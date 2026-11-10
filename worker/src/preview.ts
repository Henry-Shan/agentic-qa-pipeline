import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execa } from 'execa';
import type { PreviewStatus, QaRun } from './db';
import { examine } from './examine';
import { maxPreviews } from './settings';
import type { Ctx, PreviewHandle } from './state';
import { log, sleep } from './util';

const PORT_SCAN_START = 3300;
const PORT_SCAN_STEP = 10;
const PORT_SCAN_END = 3990;
const HEALTH_TIMEOUT_MS = 120_000;

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1' }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Picks AND reserves a port — caller must releasePort() on every exit path. */
export async function findFreePort(ctx: Ctx): Promise<number | null> {
  const taken = new Set([...ctx.state.previews.values()].map((p) => p.port));
  for (const p of ctx.state.agentPreviews.values()) taken.add(p.port);
  for (const p of ctx.state.reservedPorts) taken.add(p);
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port += PORT_SCAN_STEP) {
    if (taken.has(port)) continue;
    // The bind test alone misses wildcard listeners: SO_REUSEADDR lets a
    // 127.0.0.1 bind succeed while another server holds *:<port> (macOS), and a
    // preview registered on someone else's port serves someone else's app.
    if ((await listeningPid(port)) !== null) continue;
    if (await portFree(port)) {
      ctx.state.reservedPorts.add(port);
      return port;
    }
  }
  return null;
}

/**
 * Who is actually listening on `port`, if anyone.
 *
 * This is the authoritative liveness test for a preview, and the pid file is
 * not. Starting a preview creates TWO processes — the `npm` wrapper we record,
 * and the `next-server` it spawns — and the wrapper can die while the server
 * keeps serving (routine after the Mac sleeps). Asking "is the recorded pid
 * alive?" then declares a working preview dead, the row is marked down, and the
 * site shows "Preview waiting" over a preview that answers every request. So ask
 * the port instead, and take the pid FROM the listener so a later stop still
 * reaches the right process.
 */
export async function listeningPid(port: number): Promise<number | null> {
  const r = await execa('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { reject: false, timeout: 10_000 });
  if (r.exitCode !== 0) return null;
  for (const line of (r.stdout ?? '').split('\n')) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

export { HEALTH_TIMEOUT_MS };

export async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // any HTTP response (even 404/500 while compiling) counts as "up"
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await sleep(1_500);
    }
  }
  return false;
}

/** On pr_ready: start the worktree's dev server and publish the preview URL. */
/**
 * Record what the preview is doing and WHY, for whoever is looking at the task.
 *
 * `preview_status` alone renders as "Preview waiting", which is true and useless:
 * evicted, building, queued and broken all look identical. The reason already
 * exists at every one of these points — it was only ever going into the log.
 */
async function setPreviewState(ctx: Ctx, runId: number, status: PreviewStatus, detail: string): Promise<void> {
  await ctx.db
    .updateRun(runId, { preview_status: status, preview_detail: detail, preview_detail_at: new Date().toISOString() })
    .catch(() => undefined);
}

export async function startPreview(ctx: Ctx, run: QaRun, skipExam = false): Promise<void> {
  // `previews` is only populated once the server answers, which is seconds (or a
  // build) away — so the map alone cannot stop a reconcile and a wake request from
  // both starting a server for the same run. That doubles the heaviest thing on
  // this machine, so claim the run up front.
  if (ctx.state.previews.has(run.id) || ctx.state.startingPreviews.has(run.id)) return;
  ctx.state.startingPreviews.add(run.id);
  ctx.state.startingReports.add(run.report_id);
  try {
    await startPreviewInner(ctx, run, skipExam);
  } finally {
    ctx.state.startingPreviews.delete(run.id);
    ctx.state.startingReports.delete(run.report_id);
  }
}

async function startPreviewInner(ctx: Ctx, run: QaRun, skipExam: boolean): Promise<void> {
  if (!run.worktree) {
    await ctx.db.insertEvent({
      report_id: run.report_id,
      run_id: run.id,
      type: 'error',
      message: 'no worktree reported in runinfo — cannot start a preview',
    });
    return;
  }
  await setPreviewState(ctx, run.id, 'starting', 'Getting this preview ready.');
  const port = await findFreePort(ctx);
  if (port === null) {
    await ctx.db.updateRun(run.id, { preview_status: 'down' });
    await ctx.db.insertEvent({ report_id: run.report_id, run_id: run.id, type: 'error', message: 'no free preview port in 3300-3990' });
    return;
  }
  const releasePort = (): void => {
    ctx.state.reservedPorts.delete(port);
  };

  const qaDir = path.join(run.worktree, '.qa');
  fs.mkdirSync(qaDir, { recursive: true });
  const logPath = path.join(qaDir, 'preview.log');
  // The API is reached through the preview's OWN origin (`/__api`), which the
  // front door forwards to the real API. Going straight to api.example.com is
  // a cross-origin call the API rejects — its CORS allowlist is example.com and
  // localhost, and a preview hostname is neither. Adding preview hosts to that
  // allowlist would mean changing and redeploying the production API for the sake
  // of QA, so instead we make the call same-origin and production stays untouched.
  const publicHost = ctx.cfg.previewMode === 'tunnel' ? previewHostname(ctx, run.report_id) : null;
  const apiBase = publicHost && !refusesToServe(ctx, publicHost) ? `https://${publicHost}${API_PREFIX}` : ctx.cfg.previewApiOrigin;

  // Reserve the hostname BEFORE the build. A build takes minutes, and until the
  // DNS record exists the URL does not resolve at all — the visitor gets the
  // browser's "server not found", not our "building…" page. The record is
  // created once and never removed, so this only does work the first time.
  if (publicHost) await ensureDns(ctx, publicHost);

  // Serve a production build, not `next dev`. Measured on this app: dev ships
  // 25.8 MB over 123 requests for one page and holds ~1 GB per preview, because it
  // compiles routes on demand and serves every module unbundled. The same page
  // built is 1.38 MB over 16 requests in a 64 MB server. A preview shows frozen
  // code, so nothing about dev mode is worth 19x the bytes.
  const built = await ensureBuild(ctx, run, run.worktree, apiBase, logPath, skipExam);
  const webDir = shq(path.join(run.worktree, ctx.cfg.previewAppDir));
  const cmd = ctx.cfg.previewCmd
    ? `${ctx.cfg.previewCmd} ${port}`
    : built
      ? `npm --prefix ${webDir} run start -- --port ${port}`
      : `npm --prefix ${webDir} run dev -- --port ${port}`;
  const out = fs.openSync(logPath, 'a');
  const child = spawn('bash', ['-c', cmd], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...previewEnv(ctx, apiBase), PORT: String(port) },
  });
  fs.closeSync(out);
  child.unref();
  const pid = child.pid;
  if (!pid) {
    releasePort();
    await ctx.db.updateRun(run.id, { preview_status: 'down' });
    await ctx.db.insertEvent({ report_id: run.report_id, run_id: run.id, type: 'error', message: 'preview process failed to spawn' });
    return;
  }
  fs.writeFileSync(path.join(qaDir, 'preview.pid'), String(pid));
  log('preview', `starting preview for run ${run.id} on port ${port} (pid ${pid})`);

  if (!(await waitHealthy(port, HEALTH_TIMEOUT_MS))) {
    releasePort();
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already dead
    }
    await ctx.db.updateRun(run.id, { preview_status: 'down' });
    await ctx.db.insertEvent({
      report_id: run.report_id,
      run_id: run.id,
      type: 'error',
      message: `preview never became healthy on port ${port} (see ${logPath})`,
    });
    return;
  }

  const handle: PreviewHandle = {
    runId: run.id,
    reportId: run.report_id,

    worktree: run.worktree,
    port,
    pid,
    hostname: null,
    startedAt: Date.now(),
  };
  ctx.state.previews.set(run.id, handle);
  releasePort(); // the previews map owns the port from here

  // Every task gets its own permanent https address (contracts §Preview). Only a
  // worker restart or an eviction can take the dev server down, and neither
  // changes the URL — the wake service brings it back on the next request.
  let url = `http://localhost:${port}`;
  if (ctx.cfg.previewMode === 'tunnel') {
    const host = publicHost ?? previewHostname(ctx, run.report_id);
    if (refusesToServe(ctx, host)) {
      log('preview', `REFUSING to serve ${host} — not a preview hostname`);
    } else {
      // A rework supersedes the older run's preview: same task, same hostname,
      // so leaving both alive would make the ingress order decide which fix the
      // tester sees.
      for (const other of ctx.state.previews.values()) {
        if (other.reportId === run.report_id && other.runId !== run.id) {
          await stopPreview(ctx, other, `superseded by run ${run.id}`);
        }
      }
      handle.hostname = host;
      url = `https://${host}`;
      await syncTunnel(ctx);
    }
  }
  await ctx.db.updateRun(run.id, {
    preview_status: 'live',
    preview_url: url,
    preview_port: port,
    preview_detail: built ? 'Running the built version of the fix.' : 'Running in dev mode — the production build failed, so pages load slowly.',
    preview_detail_at: new Date().toISOString(),
  });
  // Health wait can take up to 120s: only pr_ready may advance to preview, so a
  // late-healthy dev server never regresses verified/stopped/blocked.
  await ctx.db.updateReportIfStatus(run.report_id, 'pr_ready', { status: 'preview' });
  await ctx.db.insertEvent({ report_id: run.report_id, run_id: run.id, type: 'system', message: `preview live: ${url}` });
  await enforcePreviewCap(ctx);

  // Examination loop (contracts §Examination): re-run the tester's own steps on
  // this build and let an examiner judge the result. Fire-and-forget — it takes
  // minutes, and a preview must never wait on it. Only for a preview that just
  // came up for a fresh fix; a preview restarted at boot is not re-examined.
  if (ctx.cfg.examEnabled && !skipExam) {
    const report = await ctx.db.getReport(run.report_id);
    if (report) {
      void examine(ctx, report, { ...run, preview_url: url }).catch((e: Error) =>
        log('examine', `report ${run.report_id}: examination failed: ${e.message}`),
      );
    }
  }
}

/**
 * Produce a production build in the worktree, returning false if we must fall back
 * to `next dev`.
 *
 * A build that fails must never cost the tester their preview — a branch with a
 * type error still deserves to be looked at — so failure degrades to dev mode with
 * the reason recorded, rather than leaving nothing to open.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so the API base has to be
 * passed here and not only to the server process.
 */
async function ensureBuild(ctx: Ctx, run: QaRun, worktree: string, apiBase: string, logPath: string, waking: boolean): Promise<boolean> {
  if (!ctx.cfg.previewBuild || ctx.cfg.previewCmd) return false;
  // Waking an evicted preview re-serves code that has not changed since it was
  // built, so reuse it — that is what makes wake-from-sleep quick. But only if
  // that build points at the right backend: builds made before this check exists,
  // or made while the env was wrong, must not be handed back.
  if (waking && buildMatches(ctx, worktree, apiBase)) return true;

  await ctx.db.insertEvent({ report_id: run.report_id, run_id: run.id, type: 'system', message: 'building preview…' });
  await setPreviewState(ctx, run.id, 'starting', 'Queued to build. Builds run two at a time, so this waits its turn.');
  const built = await producePreviewBuild(ctx, {
    worktree,
    apiBase,
    logPath,
    label: `run ${run.id}`,
    onCompiling: () => setPreviewState(ctx, run.id, 'starting', 'Compiling the fixed build. This takes a few minutes the first time.'),
  });
  if (!built.ok) {
    await ctx.db.insertEvent({
      report_id: run.report_id,
      run_id: run.id,
      type: 'system',
      message: `preview build failed — falling back to the slower dev server. ${built.tail}`,
    });
  }
  return built.ok;
}

/**
 * The build itself, with no opinion about the shared DB — the runner wraps it in
 * events and preview_detail updates above; the preview agent (contracts §Preview
 * agent) calls it directly, because the run row's preview_* columns belong to
 * the runner machine and an agent must not write them.
 */
export async function producePreviewBuild(
  ctx: Ctx,
  opts: { worktree: string; apiBase: string; logPath: string; label: string; onCompiling?: () => Promise<void> },
): Promise<{ ok: boolean; tail: string }> {
  const { worktree, apiBase, logPath, label } = opts;
  const buildId = path.join(worktree, ctx.cfg.previewAppDir, '.next/BUILD_ID');
  // Belt and braces on the env, because getting this wrong is silent: the build
  // succeeds and the app calls the wrong backend.
  //  1. `.env.production.local` — highest precedence of Next's env files, and
  //     gitignored (<PREVIEW_APP_DIR>/.gitignore), so it never reaches the PR diff.
  //  2. the process env, which beats every env file — but only if it survives
  //     turbo, hence `--env-mode=loose` in the default build command. Turbo 2
  //     filters unknown variables by default, which is exactly how the dev
  //     `.env.local` won and previews ended up calling localhost:8082.
  const env = previewEnv(ctx, apiBase);
  try {
    fs.writeFileSync(
      path.join(worktree, ctx.cfg.previewAppDir, '.env.production.local'),
      `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`,
    );
  } catch (e) {
    log('preview', `${label}: could not pin preview env: ${(e as Error).message}`);
  }
  log('preview', `${label}: building preview (${ctx.cfg.previewBuildCmd})`);
  // Timed inside the queue: including the wait would report a 5-minute build for
  // something that took 80 seconds behind three others.
  let started = Date.now();
  const r = await queueBuild(async () => {
    await ensureDeps(ctx, worktree, label);
    await opts.onCompiling?.();
    started = Date.now();
    return execa('bash', ['-c', ctx.cfg.previewBuildCmd], {
      cwd: worktree,
      env: { ...env, NEXT_TELEMETRY_DISABLED: '1' },
      extendEnv: true,
      reject: false,
      timeout: 15 * 60_000,
    });
  });
  const secs = Math.round((Date.now() - started) / 1000);
  if (r.exitCode === 0 && fs.existsSync(buildId)) {
    // A build that silently baked in the wrong backend is worse than no build:
    // it looks fine and every request is refused. Prove the URL is in the bundle.
    recordBuildTarget(ctx, worktree, apiBase);
    log('preview', `${label}: built in ${secs}s → ${apiBase}`);
    return { ok: true, tail: '' };
  }
  try {
    fs.appendFileSync(logPath, `\n--- preview build failed (${secs}s) ---\n${r.stdout ?? ''}\n${r.stderr ?? ''}\n`);
  } catch {
    // the log is a convenience; never fail the preview over it
  }
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' · ').slice(0, 300);
  log('preview', `${label}: build failed in ${secs}s — serving dev mode instead`);
  return { ok: false, tail };
}

/**
 * Make the worktree's dependencies real and its own.
 *
 * Worktrees are created with their `node_modules` SYMLINKED into the runner
 * checkout — 1011 of ~1100 packages — which is a sensible way to avoid a 1.6 GB
 * install per task, and worked fine while previews ran `next dev`.
 *
 * Turbopack does not accept it. It resolves `next` to its real path, infers THAT
 * directory as the workspace root, and then refuses to compile anything outside
 * it: "files outside of the project directory will not be compiled". So every
 * preview build failed and silently fell back to dev mode — the 19x-heavier
 * thing built precisely to avoid.
 *
 * Materialising with `cp -c` is an APFS clone: copy-on-write, so the 1.6 GB costs
 * seconds and almost no disk. Then `npm install` reconciles what THIS branch adds
 * (a task that adds a dependency — `xlsx`, say — is not in the runner's tree).
 * Measured on a real worktree: 25s clone + 13s install, once per worktree.
 */
async function ensureDeps(ctx: Ctx, worktree: string, label: string): Promise<void> {
  if (depsAreUsable(worktree, ctx.cfg.previewAppDir)) return;

  const started = Date.now();
  // A clean install, not a copy. Cloning the runner's node_modules looked
  // cheaper, but npm then relocates `next` into <PREVIEW_APP_DIR> for the workspace
  // layout and leaves the bin link behind NEITHER there nor at the root — so
  // `next build` dies with exit 127, "command not found", and the preview falls
  // back to dev mode. Wiping first and letting npm build the tree itself takes
  // ~18s against a warm cache, which is faster than the clone was anyway.
  const wipe = [...new Set(['node_modules', path.join(ctx.cfg.previewAppDir, 'node_modules')])]
    .map((d) => shq(path.join(worktree, d)))
    .join(' ');
  await execa('bash', ['-c', `rm -rf ${wipe}`], { reject: false, timeout: 5 * 60_000 });
  const install = await execa('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: worktree,
    reject: false,
    timeout: 20 * 60_000,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  if (install.exitCode === 0 && depsAreUsable(worktree, ctx.cfg.previewAppDir)) {
    log('preview', `${label}: dependencies installed in ${secs}s`);
  } else {
    log('preview', `${label}: npm install exited ${install.exitCode} after ${secs}s and the next binary is ${depsAreUsable(worktree, ctx.cfg.previewAppDir) ? 'present' : 'still missing'} — building anyway`);
  }
}

/**
 * Can this worktree actually RUN a build?
 *
 * Not "does node_modules exist", and not even "does `next` resolve" — the build
 * script runs `next build`, so what matters is that the executable is linked
 * where npm puts it for this workspace. A tree can resolve `next/package.json`
 * perfectly and still fail with exit 127 because `.bin/next` was never created,
 * which is exactly how tasks 59 and 62 ended up with no preview at all.
 */
function depsAreUsable(worktree: string, appDir: string): boolean {
  const bins = [
    path.join(worktree, appDir, 'node_modules/.bin/next'),
    path.join(worktree, 'node_modules/.bin/next'),
  ];
  if (!bins.some((b) => fs.existsSync(b))) return false;
  return depsAreLocal(worktree, appDir);
}

/**
 * Is `next` resolvable from the app AND inside this worktree?
 *
 * That is exactly Turbopack's requirement, and it is not the same as "a
 * node_modules exists". Worktrees come in two shapes — deps hoisted to the
 * worktree root, or under <PREVIEW_APP_DIR> — and both are fine as long as the resolved
 * path stays inside the worktree. A symlink into the runner checkout resolves
 * OUTSIDE it, which is the case that breaks the build.
 */
function depsAreLocal(worktree: string, appDir: string): boolean {
  try {
    const from = createRequire(path.join(worktree, appDir, 'package.json'));
    const resolved = fs.realpathSync(from.resolve('next/package.json'));
    return resolved.startsWith(`${fs.realpathSync(worktree)}${path.sep}`);
  } catch {
    return false; // not resolvable at all → it needs installing
  }
}


async function enforcePreviewCap(ctx: Ctx): Promise<void> {
  while (ctx.state.previews.size > maxPreviews(ctx)) {
    // Oldest-first. Safe now that every task's URL is permanent: evicting a
    // preview only puts it to sleep, and the next request to its hostname wakes
    // it through the wake service.
    const oldest = [...ctx.state.previews.values()].sort((a, b) => a.startedAt - b.startedAt).at(0);
    if (!oldest) return;
    await stopPreview(ctx, oldest, `evicted — max previews=${maxPreviews(ctx)}`);
  }
}

export async function stopPreview(ctx: Ctx, handle: PreviewHandle, reason: string): Promise<void> {
  try {
    process.kill(-handle.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(handle.pid, 'SIGTERM');
    } catch {
      // already dead
    }
  }
  ctx.state.previews.delete(handle.runId);
  await setPreviewState(ctx, handle.runId, 'down', explainStop(ctx, reason));
  await ctx.db.insertEvent({ report_id: handle.reportId, run_id: handle.runId, type: 'system', message: `preview stopped: ${reason}` });
  log('preview', `stopped preview for run ${handle.runId}: ${reason}`);
  if (ctx.cfg.previewMode === 'tunnel') await syncTunnel(ctx);
}

export async function stopAllPreviews(ctx: Ctx): Promise<void> {
  for (const handle of [...ctx.state.previews.values()]) {
    await stopPreview(ctx, handle, 'worker shutting down');
  }
  // Agent-built previews are local state only — kill the servers, touch no rows.
  for (const [reportId, agent] of [...ctx.state.agentPreviews]) {
    try {
      process.kill(-agent.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(agent.pid, 'SIGTERM');
      } catch {
        // already dead
      }
    }
    ctx.state.agentPreviews.delete(reportId);
  }
  if (cfChild) {
    try {
      cfChild.kill('SIGTERM');
    } catch {
      // already dead
    }
    cfChild = null;
  }
}

// ---- cloudflared (PREVIEW_MODE=tunnel) -------------------------------------

let cfChild: ChildProcess | null = null;

/**
 * Bounded build concurrency.
 *
 * Five at once thrashes a laptop and finishes later than five in a row. One at a
 * time is safe but serialises a backlog: after the symlink fix every worktree
 * needs one materialise-and-build (~15 min), and strictly serial that is hours
 * during which every preview reads "waiting". Two keeps the machine responsive
 * while halving the queue — the phases interleave, since materialising is
 * disk-bound and building is CPU-bound.
 */
const BUILD_SLOTS = Math.max(1, Number(process.env.PREVIEW_BUILD_CONCURRENCY ?? 2) || 2);
const buildLanes: Array<Promise<unknown>> = Array.from({ length: BUILD_SLOTS }, () => Promise.resolve());
let nextLane = 0;
function queueBuild<T>(fn: () => Promise<T>): Promise<T> {
  const lane = nextLane;
  nextLane = (nextLane + 1) % BUILD_SLOTS;
  const next = (buildLanes[lane] ?? Promise.resolve()).then(fn, fn);
  buildLanes[lane] = next.catch(() => undefined);
  return next;
}

/**
 * Hostnames this worker must NEVER touch. `cloudflared tunnel route dns` writes
 * a DNS record in the example.com zone, so a typo in PREVIEW_ZONE could
 * otherwise repoint the live app or the API at a laptop. Previews are not worth
 * that risk: refuse, loudly, and serve nothing.
 */
const EXTRA_PROTECTED_HOSTS = (process.env.PROTECTED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Apex + the usual production labels of the preview zone, plus PROTECTED_HOSTS. */
function protectedHosts(zone: string): Set<string> {
  return new Set([zone, ...['www', 'api', 'app', 'qa'].map((l) => `${l}.${zone}`), ...EXTRA_PROTECTED_HOSTS]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ONLY shape of hostname this worker may create: `<prefix><digits>.<zone>`.
 * A digits-only label cannot collide with `api`, `www`, `qa` or the apex, so no
 * misconfiguration can aim a DNS write at production. PROTECTED_HOSTS stays as a
 * second, redundant check.
 */
function allowedHost(ctx: Ctx): RegExp {
  return new RegExp(`^${escapeRe(ctx.cfg.previewHostPrefix)}\\d+\\.${escapeRe(ctx.cfg.previewZone)}$`);
}

function refusesToServe(ctx: Ctx, hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  return protectedHosts(ctx.cfg.previewZone).has(h) || !allowedHost(ctx).test(h);
}

/** Same-origin path the preview's API calls go through; forwarded by the front door. */
export const API_PREFIX = '/__api';

/**
 * Backend URLs a preview must NOT inherit from the developer's `.env.local`.
 *
 * A developer's `.env.local` may be symlinked or copied into a worktree and point
 * at a local dev stack. Nothing is listening on those ports on a tester's machine,
 * so a preview that inherits it answers every call with ERR_CONNECTION_REFUSED.
 */
/** Turn an internal stop reason into something worth reading on the task page. */
function explainStop(ctx: Ctx, reason: string): string {
  if (reason.startsWith('evicted')) {
    return `Stopped to free memory — the machine keeps ${maxPreviews(ctx)} previews running at once and this was the least recently started. Opening the link starts it again, which takes about a minute.`;
  }
  if (reason.includes('worker shutting down')) {
    return 'Stopped because the worker restarted. Opening the link starts it again.';
  }
  if (reason.includes('process is gone')) {
    return 'The dev server stopped on its own — usually the Mac went to sleep. Opening the link starts it again.';
  }
  if (reason.startsWith('superseded')) {
    return 'Replaced by a newer run for this task.';
  }
  if (reason === 'shipped') return 'Shipped — the preview was torn down.';
  if (reason === 'built for a different address') {
    return 'This preview was built for the old public URL, which no longer exists. Opening the link rebuilds it for localhost — a few minutes.';
  }
  return reason;
}

/**
 * Where this preview should be reachable RIGHT NOW.
 *
 * Derived from the current mode, never from what was stored when the preview
 * first started: switching PREVIEW_MODE from tunnel to local left every live row
 * advertising a `https://qa-preview-*` address whose tunnel no longer exists, so
 * the board offered links that could not resolve.
 */
export function expectedPreviewUrl(ctx: Ctx, reportId: number, port: number): string {
  if (ctx.cfg.previewMode === 'tunnel') {
    const host = previewHostname(ctx, reportId);
    if (!refusesToServe(ctx, host)) return `https://${host}`;
  }
  return `http://localhost:${port}`;
}

/**
 * What a build was made FOR, recorded beside it.
 *
 * Grepping the bundle for the expected URLs cannot work: the app carries
 * `https://api.example.com` as a hardcoded fallback in getPublicEnv(), so that
 * string is present whether or not the build actually used it — a stale build
 * passed the check and kept serving after the tunnel was switched off. A marker
 * written at build time says exactly what went in, with no guessing.
 */
interface BuildTarget {
  apiBase: string;
  supabaseUrl: string;
}

function targetPath(worktree: string): string {
  return path.join(worktree, '.qa', 'build-target.json');
}

export function recordBuildTarget(ctx: Ctx, worktree: string, apiBase: string): void {
  try {
    fs.mkdirSync(path.join(worktree, '.qa'), { recursive: true });
    const target: BuildTarget = { apiBase, supabaseUrl: ctx.cfg.previewSupabaseUrl };
    fs.writeFileSync(targetPath(worktree), JSON.stringify(target));
  } catch {
    // best effort: a missing marker just means the next start rebuilds
  }
}

/** Was the build in this worktree made for exactly these settings? */
export function buildMatches(ctx: Ctx, worktree: string, apiBase: string): boolean {
  if (!fs.existsSync(path.join(worktree, ctx.cfg.previewAppDir, '.next/BUILD_ID'))) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(targetPath(worktree), 'utf8')) as BuildTarget;
    return saved.apiBase === apiBase && saved.supabaseUrl === ctx.cfg.previewSupabaseUrl;
  } catch {
    return false; // no marker → built before this existed, or unreadable
  }
}

export function previewEnv(ctx: Ctx, apiBase: string): Record<string, string> {
  const env: Record<string, string> = {
    NEXT_PUBLIC_API_BASE_URL: apiBase,
  };
  // Supabase too, for the same reason: `<PREVIEW_APP_DIR>/.env.local` is a symlink into
  // the developer's checkout that only SOME worktrees have, and a build without
  // it produces an app whose login page reads "Supabase is not configured".
  // A preview must not depend on a file that may or may not be there.
  if (ctx.cfg.previewSupabaseUrl && ctx.cfg.previewSupabaseAnonKey) {
    if (isServiceRoleKey(ctx.cfg.previewSupabaseAnonKey)) {
      // This value is inlined into a client bundle that anyone with the preview
      // link can read. A service-role key there is a full database leak.
      log('preview', 'REFUSING to build with PREVIEW_SUPABASE_ANON_KEY that is a service_role key');
    } else {
      env.NEXT_PUBLIC_SUPABASE_URL = ctx.cfg.previewSupabaseUrl;
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ctx.cfg.previewSupabaseAnonKey;
    }
  }
  return env;
}

/** A Supabase JWT carries its role in the payload; anon is safe to publish, service_role is not. */
function isServiceRoleKey(key: string): boolean {
  try {
    const payload = key.split('.')[1];
    if (!payload) return false;
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { role?: string };
    return json.role === 'service_role';
  } catch {
    return false; // not a JWT we can read; the explicit env name is the contract
  }
}

/**
 * A task's permanent preview address. Keyed by REPORT, not run: reworking a task
 * spawns a new run, and the tester must not have to hunt for a new link. The DNS
 * record is created once and never deleted, so the URL keeps working for the life
 * of the task — when the dev server behind it is asleep, the wake service boots it.
 */
export function previewHostname(ctx: Ctx, reportId: number): string {
  return `${ctx.cfg.previewHostPrefix}${reportId}.${ctx.cfg.previewZone}`;
}

/**
 * Bring the tunnel up at boot, before any preview exists.
 *
 * cloudflared dies with the worker while previews (detached) outlive it, so a
 * restart must re-establish it. It must NOT wait for a preview to start: with
 * the tunnel down every task URL answers 530 from Cloudflare instead of the wake
 * page, which is exactly the "permanent link" promise breaking.
 */
export async function republishTunnel(ctx: Ctx): Promise<void> {
  if (ctx.cfg.previewMode !== 'tunnel') return;
  await syncTunnel(ctx);
}

/**
 * Give a hostname a DNS record, once. Idempotent via a persisted set, so calling
 * it on every preview start costs nothing after the first time.
 *
 * Called BEFORE the build so the address resolves while the preview is still
 * being produced — otherwise the visitor gets the browser's own "server not
 * found" instead of the page that says what is happening.
 */
async function ensureDns(ctx: Ctx, hostname: string): Promise<void> {
  if (ctx.cfg.previewMode !== 'tunnel') return;
  if (refusesToServe(ctx, hostname)) {
    log('preview', `REFUSING to route ${hostname} — not a preview hostname`);
    return;
  }
  const routedPath = path.join(ctx.cfg.qaHome, 'routed-hostnames.json');
  let routed: Set<string>;
  try {
    routed = new Set(JSON.parse(fs.readFileSync(routedPath, 'utf8')) as string[]);
  } catch {
    routed = new Set();
  }
  if (routed.has(hostname)) return;
  const r = await execa('cloudflared', ['tunnel', 'route', 'dns', ctx.cfg.cfTunnelName, hostname], {
    reject: false,
    timeout: 60_000,
  });
  if (r.exitCode === 0 || /already exists/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)) {
    routed.add(hostname);
    fs.writeFileSync(routedPath, JSON.stringify([...routed]));
    log('preview', `routed ${hostname}`);
  } else {
    log('preview', `cloudflared route dns failed for ${hostname}: ${r.stderr ?? r.stdout ?? 'unknown'}`);
  }
}

async function syncTunnel(ctx: Ctx): Promise<void> {
  const yml = path.join(ctx.cfg.qaHome, 'cloudflared.yml');
  const entries = [...ctx.state.previews.values()].filter((p) => p.hostname !== null);
  // ONE ingress rule: everything goes to the front door, which routes by Host to
  // the right dev server (or wakes it). Per-hostname rules would mean rewriting
  // this file and restarting cloudflared on every preview start and stop — and
  // they could not fix Next's cross-origin block, which needs a header rewrite.
  const lines = [`tunnel: ${ctx.cfg.cfTunnelName}`, 'ingress:', `  - service: http://localhost:${ctx.cfg.wakePort}`, ''];
  const desired = lines.join('\n');
  const changed = !fs.existsSync(yml) || fs.readFileSync(yml, 'utf8') !== desired;
  if (changed) fs.writeFileSync(yml, desired);

  for (const p of entries) if (p.hostname) await ensureDns(ctx, p.hostname);

  if (cfChild && !changed) return; // already running the right config
  if (cfChild) {
    try {
      cfChild.kill('SIGTERM');
    } catch {
      // already dead
    }
    cfChild = null;
  }
  const out = fs.openSync(path.join(ctx.cfg.qaHome, 'cloudflared.log'), 'a');
  cfChild = spawn('cloudflared', ['tunnel', '--config', yml, 'run', ctx.cfg.cfTunnelName], {
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  cfChild.once('close', (code) => log('preview', `managed cloudflared exited (code ${code})`));
}

// ---- worktree teardown -----------------------------------------------------

/** Prefer the repo's teardown-worktree.sh; fall back to git worktree remove. */
export async function teardownWorktree(ctx: Ctx, worktree: string): Promise<void> {
  const name = path.basename(worktree);
  const script = path.join(ctx.cfg.runnerRepo, '.claude', 'skills', 'ship-task', 'teardown-worktree.sh');
  if (fs.existsSync(script)) {
    const r = await execa('bash', [script, name], { cwd: ctx.cfg.runnerRepo, reject: false, timeout: 120_000 });
    if (r.exitCode === 0) {
      log('preview', `worktree torn down via teardown-worktree.sh: ${worktree}`);
      return;
    }
    log('preview', `teardown-worktree.sh exited ${r.exitCode} — falling back to git worktree remove`);
  }
  await execa('git', ['-C', ctx.cfg.runnerRepo, 'worktree', 'remove', '--force', worktree], { reject: false, timeout: 60_000 });
  await execa('git', ['-C', ctx.cfg.runnerRepo, 'worktree', 'prune'], { reject: false, timeout: 60_000 });
  log('preview', `worktree removed: ${worktree}`);
}
