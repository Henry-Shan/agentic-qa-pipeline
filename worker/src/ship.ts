import { execa } from 'execa';
import type { QaReport, QaRun } from './db';
import { deriveArea } from './envelope';
import { stopPreview, teardownWorktree } from './preview';
import type { Ctx } from './state';
import { log } from './util';

const POLL_MS = 10 * 60_000; // first check happens one interval after boot

export function startShipLoop(ctx: Ctx): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void shipTick(ctx)
      .catch((e: Error) => log('ship', `tick failed: ${e.message}`))
      .finally(() => {
        busy = false;
      });
  }, POLL_MS);
}

export async function shipTick(ctx: Ctx): Promise<void> {
  await teardownCancelled(ctx);
  const reports = await ctx.db.reportsInStatuses(['pr_ready', 'preview', 'verified'], ctx.cfg.onlyReportId);
  for (const report of reports) {
    const run = await ctx.db.latestRunWithPr(report.id);
    if (!run || run.pr_number === null) continue;
    if (!(await prMerged(ctx, run.pr_number))) continue;

    log('ship', `PR #${run.pr_number} merged — shipping report ${report.id}`);
    await ctx.db.updateReport(report.id, { status: 'shipped' });
    await ctx.db.insertEvent({
      report_id: report.id,
      run_id: run.id,
      type: 'system',
      message: `PR #${run.pr_number} merged — shipped`,
    });

    const preview = ctx.state.previews.get(run.id);
    if (preview) {
      await stopPreview(ctx, preview, 'shipped');
    } else if (run.preview_status === 'live' || run.preview_status === 'starting') {
      await ctx.db.updateRun(run.id, { preview_status: 'down' });
    }
    if (run.worktree) {
      await teardownWorktree(ctx, run.worktree).catch((e: Error) =>
        log('ship', `teardown failed for ${run.worktree ?? ''}: ${e.message}`),
      );
    }
    await distill(ctx, report, run);
  }
}

/**
 * Contract §Worker: "Teardown on shipped/cancelled". Cancelled is set by the
 * operator (nothing in the pipeline sets it), so sweep for it here: stop the
 * preview and remove the worktree. Clearing run.worktree makes the sweep
 * idempotent — an already-torn-down report costs one lookup per tick.
 */
async function teardownCancelled(ctx: Ctx): Promise<void> {
  const reports = await ctx.db.reportsInStatuses(['cancelled'], ctx.cfg.onlyReportId);
  for (const report of reports) {
    // never rip the worktree out from under a still-live claude process
    const handle = ctx.state.runByReport(report.id);
    if (handle && ctx.state.runAlive(handle)) continue;
    const run = await ctx.db.latestRunForReport(report.id);
    if (!run) continue;

    const preview = ctx.state.previews.get(run.id);
    if (preview) {
      await stopPreview(ctx, preview, 'cancelled');
    } else if (run.preview_status === 'live' || run.preview_status === 'starting') {
      await ctx.db.updateRun(run.id, { preview_status: 'down' });
    }
    if (run.worktree) {
      log('ship', `report ${report.id} cancelled — tearing down ${run.worktree}`);
      await teardownWorktree(ctx, run.worktree).catch((e: Error) =>
        log('ship', `teardown failed for ${run.worktree ?? ''}: ${e.message}`),
      );
      await ctx.db.updateRun(run.id, { worktree: null });
      await ctx.db.insertEvent({
        report_id: report.id,
        run_id: run.id,
        type: 'system',
        message: 'cancelled — preview stopped, worktree removed',
      });
    }
  }
}

async function prMerged(ctx: Ctx, prNumber: number): Promise<boolean> {
  const r = await execa('gh', ['pr', 'view', String(prNumber), '--json', 'state,mergedAt'], {
    cwd: ctx.cfg.runnerRepo,
    reject: false,
    timeout: 60_000,
  });
  if (r.exitCode !== 0) {
    log('ship', `gh pr view ${prNumber} failed: ${(r.stderr ?? '').slice(0, 200)}`);
    return false;
  }
  try {
    const info = JSON.parse(r.stdout ?? '{}') as { state?: string; mergedAt?: string | null };
    return info.state === 'MERGED' || Boolean(info.mergedAt);
  } catch {
    return false;
  }
}

/** Learning loop: one qa_area_notes row so later runs in this area start smarter. */
async function distill(ctx: Ctx, report: QaReport, run: QaRun): Promise<void> {
  const area = deriveArea(report);
  const grounding = run.grounding?.at(0)?.label ?? 'no grounding trace recorded';
  const files = (run.files_changed ?? [])
    .map((f) => f.file)
    .slice(0, 6)
    .join(', ');
  let note = `${report.kind} "${report.title}" — grounding: ${grounding}. Changed: ${files || 'unknown files'}.`;
  if (run.stopped_reason) note += ` Lesson: ${run.stopped_reason}`;
  await ctx.db.insertAreaNote(area, note.slice(0, 600), report.id);
  log('ship', `distilled area note for "${area}" from report ${report.id}`);
}
