// Preview agent (contracts §Preview agent): build and serve a report's fix on
// THIS machine, from the branch the run pushed.
//
// A preview normally lives only where the runner built it — its worktree, its
// dev server, its localhost port. Any other machine opening the stored URL hits
// its own localhost and finds nothing. The agent closes that gap: the code is
// already shared (every run pushes `branch` to origin), so when `/p/<reportId>`
// is opened on a machine that has no preview, this fetches the branch into a
// local worktree, builds it, and serves it here.
//
// Two invariants keep this safe to run anywhere, in any number:
//  - The shared DB is read-only from this path. `qa_runs.preview_*` describes
//    the RUNNER machine's server; an agent writing it would point every other
//    machine at a port that only exists here.
//  - All state is per-machine: worktrees under `<worktreeBase>/agent-preview-*`,
//    handles in `state.agentPreviews`, the built sha in `.qa/agent-built-sha`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import {
  HEALTH_TIMEOUT_MS,
  buildMatches,
  findFreePort,
  listeningPid,
  producePreviewBuild,
  previewEnv,
  shq,
  waitHealthy,
} from './preview';
import type { Ctx } from './state';
import { log } from './util';

function agentWorktree(ctx: Ctx, reportId: number): string {
  return path.join(ctx.cfg.worktreeBase, `agent-preview-${reportId}`);
}

function builtShaPath(worktree: string): string {
  return path.join(worktree, '.qa', 'agent-built-sha');
}

/**
 * Make report `reportId`'s fix serve on this machine, if it isn't already.
 * Idempotent and re-entrant-guarded via `startingReports` — the front door's
 * waiting page polls every 5s, and each poll calls this.
 */
export async function ensureAgentPreview(ctx: Ctx, reportId: number): Promise<void> {
  if (ctx.state.startingReports.has(reportId)) return;
  ctx.state.startingReports.add(reportId);
  try {
    await ensureInner(ctx, reportId);
  } catch (e) {
    log('agent', `report ${reportId}: preview failed: ${(e as Error).message}`);
  } finally {
    ctx.state.startingReports.delete(reportId);
  }
}

async function ensureInner(ctx: Ctx, reportId: number): Promise<void> {
  const run = await ctx.db.latestRunForReport(reportId);
  if (!run?.branch) {
    log('agent', `report ${reportId}: no run with a branch — nothing to build`);
    return;
  }

  // The branch moves on rework, so what "current" means is origin's tip, not
  // whatever this machine fetched last time.
  const fetch = await execa('git', ['-C', ctx.cfg.runnerRepo, 'fetch', 'origin', run.branch], {
    reject: false,
    timeout: 120_000,
  });
  if (fetch.exitCode !== 0) {
    log('agent', `report ${reportId}: git fetch origin ${run.branch} failed: ${fetch.stderr ?? ''}`);
    return;
  }
  const rev = await execa('git', ['-C', ctx.cfg.runnerRepo, 'rev-parse', `origin/${run.branch}`], {
    reject: false,
    timeout: 30_000,
  });
  const sha = rev.stdout?.trim();
  if (rev.exitCode !== 0 || !sha) {
    log('agent', `report ${reportId}: origin/${run.branch} did not resolve`);
    return;
  }

  const existing = ctx.state.agentPreviews.get(reportId);
  if (existing) {
    if (existing.sha === sha && (await listeningPid(existing.port)) !== null) return; // current and serving
    // Stale code or dead server — retire it and start over.
    try {
      process.kill(-existing.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(existing.pid, 'SIGTERM');
      } catch {
        // already dead
      }
    }
    ctx.state.agentPreviews.delete(reportId);
  }

  const worktree = agentWorktree(ctx, reportId);
  if (fs.existsSync(worktree)) {
    const co = await execa('git', ['-C', worktree, 'checkout', '--force', '--detach', sha], {
      reject: false,
      timeout: 60_000,
    });
    if (co.exitCode !== 0) {
      // A worktree too broken to check out is not worth diagnosing — recreate it.
      await execa('git', ['-C', ctx.cfg.runnerRepo, 'worktree', 'remove', '--force', worktree], { reject: false, timeout: 60_000 });
      await execa('rm', ['-rf', worktree], { reject: false, timeout: 60_000 });
    }
  }
  if (!fs.existsSync(worktree)) {
    const add = await execa('git', ['-C', ctx.cfg.runnerRepo, 'worktree', 'add', '--detach', worktree, sha], {
      reject: false,
      timeout: 120_000,
    });
    if (add.exitCode !== 0) {
      log('agent', `report ${reportId}: git worktree add failed: ${add.stderr ?? ''}`);
      return;
    }
  }

  const qaDir = path.join(worktree, '.qa');
  fs.mkdirSync(qaDir, { recursive: true });
  const logPath = path.join(qaDir, 'preview.log');
  // The agent always serves plain localhost, so the API is called directly —
  // its CORS allowlist includes localhost (same as PREVIEW_MODE=local).
  const apiBase = ctx.cfg.previewApiOrigin;

  // Reuse a build only when it is a build OF THIS SHA for these settings; the
  // generic marker alone would happily re-serve last week's code after a rework.
  let built = readBuiltSha(worktree) === sha && buildMatches(ctx, worktree, apiBase);
  if (!built) {
    const r = await producePreviewBuild(ctx, { worktree, apiBase, logPath, label: `agent report ${reportId}` });
    built = r.ok;
    if (built) {
      try {
        fs.writeFileSync(builtShaPath(worktree), sha);
      } catch {
        // best effort — a missing marker just rebuilds next time
      }
    }
  }

  const port = await findFreePort(ctx);
  if (port === null) {
    log('agent', `report ${reportId}: no free preview port in 3300-3990`);
    return;
  }
  const releasePort = (): void => {
    ctx.state.reservedPorts.delete(port);
  };

  const webDir = shq(path.join(worktree, 'apps/web'));
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
    log('agent', `report ${reportId}: preview process failed to spawn`);
    return;
  }
  fs.writeFileSync(path.join(qaDir, 'preview.pid'), String(pid));
  log('agent', `report ${reportId}: starting local preview on port ${port} (pid ${pid}, ${built ? 'built' : 'dev mode'})`);

  if (!(await waitHealthy(port, HEALTH_TIMEOUT_MS))) {
    releasePort();
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already dead
    }
    log('agent', `report ${reportId}: preview never became healthy on port ${port} (see ${logPath})`);
    return;
  }

  ctx.state.agentPreviews.set(reportId, { reportId, worktree, port, pid, sha, startedAt: Date.now() });
  releasePort(); // the agentPreviews map owns the port from here
  log('agent', `report ${reportId}: local preview live on http://localhost:${port}`);
  enforceAgentCap(ctx);
}

function readBuiltSha(worktree: string): string | null {
  try {
    return fs.readFileSync(builtShaPath(worktree), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Same memory bound as the runner's previews: oldest goes to sleep first. */
function enforceAgentCap(ctx: Ctx): void {
  while (ctx.state.agentPreviews.size > ctx.cfg.maxPreviews) {
    const oldest = [...ctx.state.agentPreviews.values()].sort((a, b) => a.startedAt - b.startedAt).at(0);
    if (!oldest) return;
    try {
      process.kill(-oldest.pid, 'SIGTERM');
    } catch {
      // already dead
    }
    ctx.state.agentPreviews.delete(oldest.reportId);
    log('agent', `report ${oldest.reportId}: evicted — max previews=${ctx.cfg.maxPreviews}. The next open rebuilds it.`);
  }
}
