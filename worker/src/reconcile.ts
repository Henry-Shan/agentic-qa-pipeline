import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { pidAlive } from './config';
import type { Ctx } from './state';
import { log, nowIso } from './util';

const ORPHAN_SWEEP_MS = 15_000;

/**
 * Boot reconciliation. Detached claude runs survive a worker restart, so a
 * DB-"running" run may still be alive: re-attach it (pid found via its session
 * uuid in argv) for stop/steer; otherwise fail it and block the report so the
 * tester can resume with Send.
 */
export async function reconcile(ctx: Ctx): Promise<void> {
  for (const run of await ctx.db.runningRuns()) {
    // selftest scoping: never touch rows outside the seeded report
    if (ctx.cfg.onlyReportId !== null && run.report_id !== ctx.cfg.onlyReportId) continue;
    const pid = await findSessionPid(run.session_id);
    if (pid !== null) {
      ctx.state.registerRun({
        runId: run.id,
        reportId: run.report_id,
        sessionId: run.session_id,
        pid,
        child: null,
        stopRequested: false,
        steerInterrupt: false,
        runinfoReceived: run.pr_url !== null,
      });
      ctx.state.activeDispatches++;
      log('reconcile', `re-attached live run ${run.id} (pid ${pid})`);
    } else {
      await ctx.db.updateRun(run.id, {
        status: 'failed',
        stopped_reason: 'worker restarted mid-run',
        finished_at: nowIso(),
      });
      await ctx.db.updateReport(run.report_id, { status: 'blocked' });
      await ctx.db.insertEvent({
        report_id: run.report_id,
        run_id: run.id,
        type: 'error',
        message: 'worker restarted mid-run — press Send to resume',
      });
      log('reconcile', `run ${run.id} orphaned (no live process) — report ${run.report_id} blocked`);
    }
  }

  for (const run of await ctx.db.previewRuns()) {
    if (ctx.cfg.onlyReportId !== null && run.report_id !== ctx.cfg.onlyReportId) continue;
    const pid = run.worktree ? readPid(path.join(run.worktree, '.qa', 'preview.pid')) : null;
    if (run.worktree && pid !== null && pidAlive(pid) && run.preview_port !== null) {
      ctx.state.previews.set(run.id, {
        runId: run.id,
        reportId: run.report_id,
        worktree: run.worktree,
        port: run.preview_port,
        pid,
        hostname: hostnameFromUrl(run.preview_url),
        startedAt: Date.now(),
      });
      log('reconcile', `re-attached live preview for run ${run.id} on port ${run.preview_port}`);
    } else {
      await ctx.db.updateRun(run.id, { preview_status: 'down' });
      log('reconcile', `preview for run ${run.id} is dead — marked down`);
    }
  }
}

/**
 * Watch re-attached (child-less) runs: their stdout is gone, so when the pid
 * dies we settle from DB state alone.
 */
export function startOrphanWatcher(ctx: Ctx): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void sweep(ctx)
      .catch((e: Error) => log('reconcile', `orphan sweep failed: ${e.message}`))
      .finally(() => {
        busy = false;
      });
  }, ORPHAN_SWEEP_MS);
}

async function sweep(ctx: Ctx): Promise<void> {
  for (const h of ctx.state.allRunHandles()) {
    if (h.child !== null) continue; // tracked normally via its stdout/close
    if (h.pid !== null && pidAlive(h.pid)) continue;
    ctx.state.removeRun(h);
    if (ctx.state.activeDispatches > 0) ctx.state.activeDispatches--;
    const run = await ctx.db.getRun(h.runId);
    const report = await ctx.db.getReport(h.reportId);
    if (!run || !report || run.status !== 'running') continue;
    const handedOff =
      h.runinfoReceived || report.status === 'pr_ready' || report.status === 'preview' || report.status === 'verified';
    if (handedOff) {
      await ctx.db.updateRun(run.id, { status: 'done', phase: 'done', finished_at: nowIso() });
    } else {
      await ctx.db.updateRun(run.id, {
        status: 'failed',
        stopped_reason: 'run process exited while detached from the worker',
        finished_at: nowIso(),
      });
      await ctx.db.updateReport(report.id, { status: 'blocked' });
      await ctx.db.insertEvent({
        report_id: report.id,
        run_id: run.id,
        type: 'error',
        message: 'run exited while detached from the worker — press Send to resume',
      });
    }
  }
}

/** The session uuid appears in claude's argv (--session-id / --resume). */
async function findSessionPid(sessionId: string): Promise<number | null> {
  const r = await execa('pgrep', ['-f', sessionId], { reject: false, timeout: 10_000 });
  const first = (r.stdout ?? '')
    .split('\n')
    .map((s: string) => s.trim())
    .filter(Boolean)
    .at(0);
  const pid = first ? Number(first) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function hostnameFromUrl(url: string | null): string | null {
  if (!url || !url.startsWith('https://')) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
