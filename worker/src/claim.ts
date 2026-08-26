import { isPaused } from './config';
import { dispatchRun, resumeRun } from './dispatch';
import { buildEnvelope } from './envelope';
import { handleInfra } from './infra';
import { routeTask } from './route';
import { maxRuns } from './settings';
import type { Ctx } from './state';
import { log } from './util';

const POLL_MS = 3_000;

let lastBudgetLog = 0;

export function startClaimLoop(ctx: Ctx): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void tick(ctx)
      .catch((e: Error) => log('claim', `tick failed: ${e.message}`))
      .finally(() => {
        busy = false;
      });
  }, POLL_MS);
}

async function tick(ctx: Ctx): Promise<void> {
  if (isPaused(ctx.cfg)) return;
  if (Date.now() < ctx.state.cooldownUntil) return;
  if (ctx.state.activeDispatches >= maxRuns(ctx)) return;
  if ((await ctx.db.countRunningRuns()) >= maxRuns(ctx)) return;
  if ((await ctx.db.countRunsToday()) >= ctx.cfg.runsPerDay) {
    if (Date.now() - lastBudgetLog > 10 * 60_000) {
      lastBudgetLog = Date.now();
      log('claim', `daily run budget reached (RUNS_PER_DAY=${ctx.cfg.runsPerDay}) — idling until midnight`);
    }
    return;
  }

  const id = await ctx.db.oldestQueuedId(ctx.cfg.onlyReportId);
  if (id === null) return;
  const report = await ctx.db.claimReport(id);
  if (!report) return;

  log('claim', `claimed report ${report.id}: ${report.title}`);
  await ctx.db.insertEvent({ report_id: report.id, type: 'system', message: 'claimed by worker' });

  try {
    // Route BEFORE any expensive work (contracts §Router): one cheap call on
    // the reporter's words alone decides how much machinery this task gets.
    // A re-queued report keeps the lane it already has (a fast run that routed
    // itself up must not be routed back down).
    let lane = report.lane ?? null;
    if (!lane) {
      const decision = await routeTask(ctx, report);
      lane = decision.lane;
      await ctx.db.updateReport(report.id, { lane: decision.lane, lane_reason: decision.reason });
      await ctx.db.insertEvent({
        report_id: report.id,
        type: 'system',
        message: `routed: ${decision.lane} — ${decision.reason}`,
      });
    }

    // Infra never spawns a code run: it produces a runbook for a human.
    if (lane === 'infra') {
      await handleInfra(ctx, { ...report, lane }, report.lane_reason ?? 'needs a human harness');
      return;
    }

    const prev = await ctx.db.latestRunForReport(report.id);
    if (prev && (prev.status === 'limited' || prev.status === 'interrupted')) {
      // requeued after a rate limit: continue the same session (worktree,
      // branch and partial work are still on disk) instead of starting over
      await resumeRun(
        ctx,
        report,
        prev,
        prev.status === 'interrupted'
          ? 'You were interrupted mid-run (the machine slept or the worker restarted) — nothing is wrong. Re-orient: git status in your worktree and the last completed ship-task step, then continue exactly where you left off.'
          : 'The previous attempt was interrupted by a usage/rate limit. Re-orient (git status in your worktree, last completed ship-task step) and continue where you left off.',
        'running',
      );
    } else {
      const envelopePath = await buildEnvelope(ctx, report);
      await dispatchRun(ctx, report, envelopePath, lane === 'fast' ? 'fast' : 'complex');
    }
  } catch (e) {
    const msg = (e as Error).message;
    log('claim', `dispatch failed for report ${report.id}: ${msg}`);
    await ctx.db.updateReport(report.id, { status: 'failed' });
    await ctx.db.insertEvent({ report_id: report.id, type: 'error', message: `dispatch failed: ${msg}` });
  }
}
