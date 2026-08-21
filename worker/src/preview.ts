import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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
  if (ctx.state.previews.has(run.id)) return;
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
  const cmd = ctx.cfg.previewCmd
    ? `${ctx.cfg.previewCmd} ${port}`
    : `npm --prefix ${shq(path.join(run.worktree, 'apps/web'))} run dev -- --port ${port}`;
  const out = fs.openSync(logPath, 'a');
  const child = spawn('bash', ['-c', cmd], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com', PORT: String(port) },
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
    const host = previewHostname(ctx, run.report_id);
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

/**
 * A task's permanent preview address. Keyed by REPORT, not run: reworking a task
 * spawns a new run, and the tester must not have to hunt for a new link. The DNS
 * record is created once and never deleted, so the URL keeps working for the life
 * of the task — when the dev server behind it is asleep, the wake service boots it.
 */
export function previewHostname(ctx: Ctx, reportId: number): string {
  return `${ctx.cfg.previewHostPrefix}${reportId}.${ctx.cfg.previewZone}`;
}

/** Regenerate the ingress yaml, route new hostnames once, restart cloudflared. */
/**
 * Re-publish every re-attached preview after a worker restart. Previews are
 * detached processes that outlive the worker, but the cloudflared child does
 * NOT — so without this, a restart in tunnel mode leaves live previews with
 * hostnames that resolve to nothing.
 */
export async function republishTunnel(ctx: Ctx): Promise<void> {
  if (ctx.cfg.previewMode !== 'tunnel') return;
  if (ctx.state.previews.size === 0) return;
  await syncTunnel(ctx);
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

  // `cloudflared tunnel route dns` once per new hostname (persisted set = idempotent)
  const routedPath = path.join(ctx.cfg.qaHome, 'routed-hostnames.json');
  let routed: Set<string>;
  try {
    routed = new Set(JSON.parse(fs.readFileSync(routedPath, 'utf8')) as string[]);
  } catch {
    routed = new Set();
  }
  for (const p of entries) {
    if (!p.hostname || routed.has(p.hostname)) continue;
    if (refusesToServe(ctx, p.hostname)) {
      log('preview', `REFUSING to route ${p.hostname} — that is a production hostname`);
      continue;
    }
    const r = await execa('cloudflared', ['tunnel', 'route', 'dns', ctx.cfg.cfTunnelName, p.hostname], {
      reject: false,
      timeout: 60_000,
    });
    if (r.exitCode === 0 || /already exists/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)) {
      routed.add(p.hostname);
    } else {
      log('preview', `cloudflared route dns failed for ${p.hostname}: ${r.stderr ?? r.stdout ?? 'unknown'}`);
    }
  }
  fs.writeFileSync(routedPath, JSON.stringify([...routed]));

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
