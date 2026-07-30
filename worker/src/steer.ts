import type { QaMessage, QaReport } from './db';
import { killRunGroup, resumeRun, waitForExit } from './dispatch';
import type { Ctx, RunHandle } from './state';
import { log, nowIso } from './util';

const POLL_MS = 2_000;

export function startSteerLoop(ctx: Ctx): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void tick(ctx)
      .catch((e: Error) => log('steer', `tick failed: ${e.message}`))
      .finally(() => {
        busy = false;
      });
  }, POLL_MS);
}

async function tick(ctx: Ctx): Promise<void> {
  const msgs = await ctx.db.pendingMessages(ctx.cfg.onlyReportId);
  // stops jump the queue: a steer-resume can take a while and must not delay one
  const ordered = [...msgs].sort((a, b) => (a.kind === 'stop' ? 0 : 1) - (b.kind === 'stop' ? 0 : 1) || a.id - b.id);
  for (const msg of ordered) {
    await handleMessage(ctx, msg);
  }
}

async function handleMessage(ctx: Ctx, msg: QaMessage): Promise<void> {
  const report = await ctx.db.getReport(msg.report_id);
  if (!report) {
    await ctx.db.updateMessage(msg.id, 'done');
    return;
  }
  const handle = ctx.state.runByReport(msg.report_id);
  const live = handle !== null && ctx.state.runAlive(handle);

  switch (msg.kind) {
    case 'stop':
      return handleStop(ctx, msg, live ? handle : null);
    case 'verdict_fixed':
      return handleVerdictFixed(ctx, msg);
    case 'steer':
    case 'verdict_broken':
      return handleSteerOrBroken(ctx, msg, report, live ? handle : null);
    case 'answer':
      return handleOrphanAnswer(ctx, msg, report, live);
    default:
      await ctx.db.updateMessage(msg.id, 'done');
  }
}

/**
 * A tracked child settles itself on 'close' (which also decrements
 * activeDispatches); a re-attached handle has no close event, so the steer
 * path that killed it must release its dispatch slot itself.
 */
function releaseHandle(ctx: Ctx, handle: RunHandle): void {
  ctx.state.removeRun(handle);
  if (handle.child === null && ctx.state.activeDispatches > 0) ctx.state.activeDispatches--;
}

async function handleStop(ctx: Ctx, msg: QaMessage, handle: RunHandle | null): Promise<void> {
  await ctx.db.updateMessage(msg.id, 'delivered');
  // The stopped run will never poll /api/answer again — drop any stale ask flag.
  ctx.state.setAskPending(msg.report_id, false);
  if (handle) {
    handle.stopRequested = true;
    killRunGroup(handle, 'SIGINT');
    if (!(await waitForExit(handle, 15_000))) {
      killRunGroup(handle, 'SIGKILL');
      await waitForExit(handle, 5_000);
    }
    releaseHandle(ctx, handle);
  }
  const run = await ctx.db.latestRunForReport(msg.report_id);
  if (run && run.status === 'running') {
    await ctx.db.updateRun(run.id, { status: 'stopped', stopped_reason: 'stopped by tester', finished_at: nowIso() });
  }
  await ctx.db.updateReport(msg.report_id, { status: 'stopped' });
  await ctx.db.insertEvent({
    report_id: msg.report_id,
    run_id: run?.id ?? null,
    type: 'system',
    message: `stopped by tester${msg.author_email ? ` (${msg.author_email})` : ''}`,
  });
  await ctx.db.updateMessage(msg.id, 'done');
  log('steer', `report ${msg.report_id} stopped by tester`);
}

async function handleVerdictFixed(ctx: Ctx, msg: QaMessage): Promise<void> {
  await ctx.db.updateReport(msg.report_id, { status: 'verified' });
  await ctx.db.insertEvent({
    report_id: msg.report_id,
    type: 'system',
    message: `tester verdict: fixed${msg.author_email ? ` (${msg.author_email})` : ''}`,
  });
  await ctx.db.updateMessage(msg.id, 'done');
  log('steer', `report ${msg.report_id} verified by tester`);
}

async function handleSteerOrBroken(
  ctx: Ctx,
  msg: QaMessage,
  report: QaReport,
  handle: RunHandle | null,
): Promise<void> {
  // run blocked on /api/ask and still polling /api/answer: the shim delivers
  // this message as the answer — leave it pending, do not interrupt
  if (msg.kind === 'steer' && handle && ctx.state.askPending(msg.report_id)) return;

  const note = msg.body.trim() || (msg.kind === 'verdict_broken' ? 'Tester says the fix is still broken. Re-verify against the report and fix it.' : '');
  if (!note) {
    await ctx.db.updateMessage(msg.id, 'done');
    return;
  }

  if (handle) {
    // mid-run steer: interrupt, then resume the same session with the note
    await ctx.db.updateMessage(msg.id, 'delivered');
    handle.steerInterrupt = true;
    killRunGroup(handle, 'SIGINT');
    if (!(await waitForExit(handle, 30_000))) {
      killRunGroup(handle, 'SIGKILL');
      await waitForExit(handle, 5_000);
    }
    releaseHandle(ctx, handle);
    const run = await ctx.db.latestRunForReport(msg.report_id);
    if (run && run.status === 'running') {
      await ctx.db.updateRun(run.id, { status: 'stopped', stopped_reason: 'interrupted for steer', finished_at: nowIso() });
    }
    await ctx.db.insertEvent({ report_id: msg.report_id, run_id: run?.id ?? null, type: 'system', message: `steer: ${note.slice(0, 300)}` });
    if (run) await resumeRun(ctx, report, run, note, 'running');
    await ctx.db.updateMessage(msg.id, 'done');
    return;
  }

  // idle (run done/failed/blocked): rework — resume the same session
  const run = await ctx.db.latestRunForReport(msg.report_id);
  if (!run) {
    await ctx.db.insertEvent({ report_id: msg.report_id, type: 'error', message: 'no prior run to steer — nothing to resume' });
    await ctx.db.updateMessage(msg.id, 'done');
    return;
  }
  await ctx.db.updateMessage(msg.id, 'delivered');
  await ctx.db.insertEvent({
    report_id: msg.report_id,
    run_id: run.id,
    type: 'system',
    message: `${msg.kind === 'verdict_broken' ? 'tester verdict: still broken' : 'steer'}: ${note.slice(0, 300)}`,
  });
  await resumeRun(ctx, report, run, note, 'rework');
  await ctx.db.updateMessage(msg.id, 'done');
}

/** An answer whose run died before polling it: resume the session with it. */
async function handleOrphanAnswer(ctx: Ctx, msg: QaMessage, report: QaReport, live: boolean): Promise<void> {
  if (live) return; // consumed by GET /api/answer
  const run = await ctx.db.latestRunForReport(msg.report_id);
  if (!run) {
    await ctx.db.updateMessage(msg.id, 'done');
    return;
  }
  ctx.state.setAskPending(msg.report_id, false);
  await ctx.db.updateMessage(msg.id, 'delivered');
  await resumeRun(ctx, report, run, `Answer to your earlier question: ${msg.body}`, 'running');
  await ctx.db.updateMessage(msg.id, 'done');
}
