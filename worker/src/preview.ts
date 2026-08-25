import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execa } from 'execa';
import type { QaRun } from './db';
import { examine } from './examine';
import { maxPreviews } from './settings';
import type { Ctx, PreviewHandle } from './state';
import { log, sleep } from './util';

const PORT_SCAN_START = 3300;
const PORT_SCAN_STEP = 10;
const PORT_SCAN_END = 3990;
const HEALTH_TIMEOUT_MS = 120_000;

function shq(s: string): string {
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
async function findFreePort(ctx: Ctx): Promise<number | null> {
  const taken = new Set([...ctx.state.previews.values()].map((p) => p.port));
  for (const p of ctx.state.reservedPorts) taken.add(p);
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port += PORT_SCAN_STEP) {
    if (taken.has(port)) continue;
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

async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
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
  await ctx.db.updateRun(run.id, { preview_status: 'starting' });
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
  const webDir = shq(path.join(run.worktree, 'apps/web'));
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
  await ctx.db.updateRun(run.id, { preview_status: 'live', preview_url: url, preview_port: port });
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
  const buildId = path.join(worktree, 'apps/web/.next/BUILD_ID');
  // Waking an evicted preview re-serves code that has not changed since it was
  // built, so reuse it — that is what makes wake-from-sleep quick. But only if
  // that build points at the right backend: builds made before this check exists,
  // or made while the env was wrong, must not be handed back.
  if (waking && fs.existsSync(buildId) && bundleTargets(worktree, apiBase)) return true;

  // Belt and braces on the env, because getting this wrong is silent: the build
  // succeeds and the app calls the wrong backend.
  //  1. `.env.production.local` — highest precedence of Next's env files, and
  //     gitignored (apps/web/.gitignore), so it never reaches the PR diff.
  //  2. the process env, which beats every env file — but only if it survives
  //     turbo, hence `--env-mode=loose` in the default build command. Turbo 2
  //     filters unknown variables by default, which is exactly how the dev
  //     `.env.local` won and previews ended up calling localhost:8082.
  const env = previewEnv(ctx, apiBase);
  try {
    fs.writeFileSync(
      path.join(worktree, 'apps/web/.env.production.local'),
      `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`,
    );
  } catch (e) {
    log('preview', `run ${run.id}: could not pin preview env: ${(e as Error).message}`);
  }
  log('preview', `run ${run.id}: building preview (${ctx.cfg.previewBuildCmd})`);
  await ctx.db.insertEvent({ report_id: run.report_id, run_id: run.id, type: 'system', message: 'building preview…' });
  // Timed inside the queue: including the wait would report a 5-minute build for
  // something that took 80 seconds behind three others.
  let started = Date.now();
  const r = await queueBuild(async () => {
    await ensureDeps(ctx, worktree, run.id);
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
    if (!bundleTargets(worktree, apiBase)) {
      log('preview', `run ${run.id}: built in ${secs}s but the bundle does not point at ${apiBase} — serving dev mode`);
      await ctx.db.insertEvent({
        report_id: run.report_id,
        run_id: run.id,
        type: 'system',
        message: `preview build did not pick up the API URL (expected ${apiBase}) — falling back to the dev server`,
      });
      return false;
    }
    log('preview', `run ${run.id}: built in ${secs}s → ${apiBase}`);
    return true;
  }
  try {
    fs.appendFileSync(logPath, `\n--- preview build failed (${secs}s) ---\n${r.stdout ?? ''}\n${r.stderr ?? ''}\n`);
  } catch {
    // the log is a convenience; never fail the preview over it
  }
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' · ').slice(0, 300);
  log('preview', `run ${run.id}: build failed in ${secs}s — serving dev mode instead`);
  await ctx.db.insertEvent({
    report_id: run.report_id,
    run_id: run.id,
    type: 'system',
    message: `preview build failed — falling back to the slower dev server. ${tail}`,
  });
  return false;
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
async function ensureDeps(ctx: Ctx, worktree: string, runId: number): Promise<void> {
  if (depsAreLocal(worktree)) return;

  const started = Date.now();
  const src = path.join(ctx.cfg.runnerRepo, 'node_modules');
  if (fs.existsSync(src)) {
    const nodeModules = path.join(worktree, 'node_modules');
    const clone = await execa('bash', ['-c', `rm -rf ${shq(nodeModules)} && cp -Rc ${shq(src)} ${shq(nodeModules)}`], {
      reject: false,
      timeout: 10 * 60_000,
    });
    if (clone.exitCode !== 0) {
      log('preview', `run ${runId}: dependency clone failed (${clone.stderr ?? ''}) — falling back to a plain install`);
    }
  }
  // Reconciles what THIS branch adds, and covers having nothing to clone from.
  const install = await execa('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: worktree,
    reject: false,
    timeout: 20 * 60_000,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  if (install.exitCode === 0) log('preview', `run ${runId}: dependencies materialised in ${secs}s`);
  else log('preview', `run ${runId}: npm install exited ${install.exitCode} after ${secs}s — building anyway`);
}

/**
 * Is `next` resolvable from the app AND inside this worktree?
 *
 * That is exactly Turbopack's requirement, and it is not the same as "a
 * node_modules exists". Worktrees come in two shapes — deps hoisted to the
 * worktree root, or under apps/web — and both are fine as long as the resolved
 * path stays inside the worktree. A symlink into the runner checkout resolves
 * OUTSIDE it, which is the case that breaks the build.
 */
function depsAreLocal(worktree: string): boolean {
  try {
    const from = createRequire(path.join(worktree, 'apps/web', 'package.json'));
    const resolved = fs.realpathSync(from.resolve('next/package.json'));
    return resolved.startsWith(`${fs.realpathSync(worktree)}${path.sep}`);
  } catch {
    return false; // not resolvable at all → it needs installing
  }
}

/** Does the built client bundle actually call `apiBase`? */
function bundleTargets(worktree: string, apiBase: string): boolean {
  const dir = path.join(worktree, 'apps/web/.next/static/chunks');
  let files: string[];
  try {
    files = fs.readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return false;
  }
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      if (!fs.statSync(full).isFile() || !full.endsWith('.js')) continue;
      if (fs.readFileSync(full, 'utf8').includes(apiBase)) return true;
    } catch {
      // unreadable chunk — keep looking
    }
  }
  return false;
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
  await ctx.db.updateRun(handle.runId, { preview_status: 'down' });
  await ctx.db.insertEvent({ report_id: handle.reportId, run_id: handle.runId, type: 'system', message: `preview stopped: ${reason}` });
  log('preview', `stopped preview for run ${handle.runId}: ${reason}`);
  if (ctx.cfg.previewMode === 'tunnel') await syncTunnel(ctx);
}

export async function stopAllPreviews(ctx: Ctx): Promise<void> {
  for (const handle of [...ctx.state.previews.values()]) {
    await stopPreview(ctx, handle, 'worker shutting down');
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
 * a DNS record in the example.com zone, so a typo in PREVIEW_DOMAIN could
 * otherwise repoint the live app or the API at a laptop. Previews are not worth
 * that risk: refuse, loudly, and serve nothing.
 */
const PROTECTED_HOSTS = new Set([
  'example.com',
  'www.example.com',
  'api.example.com',
  'qa.example.com',
  'app.example.com',
]);

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
  return PROTECTED_HOSTS.has(h) || !allowedHost(ctx).test(h);
}

/** Same-origin path the preview's API calls go through; forwarded by the front door. */
export const API_PREFIX = '/__api';

/**
 * Backend URLs a preview must NOT inherit from the developer's `.env.local`.
 *
 * `apps/web/.env.local` is symlinked into every worktree from the main checkout,
 * where it points at a local dev stack (`localhost:8082` API, `localhost:8080`
 * OCR). Nothing is listening on those ports on a tester's machine, so a preview
 * that inherits them answers every call with ERR_CONNECTION_REFUSED. Production
 * serves both from the same API host, so both point at the same place here.
 */
function previewEnv(ctx: Ctx, apiBase: string): Record<string, string> {
  const env: Record<string, string> = {
    NEXT_PUBLIC_API_BASE_URL: apiBase,
    NEXT_PUBLIC_OCR_BASE_URL: apiBase,
  };
  // Supabase too, for the same reason: `apps/web/.env.local` is a symlink into
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
