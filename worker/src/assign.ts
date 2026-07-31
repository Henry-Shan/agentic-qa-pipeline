// Auto-assign on block (contracts § Auto-assign on block).
//
// The moment a report becomes `blocked` — a STOP-gate settle, a run that
// finished without ever reporting a PR, or a question posted to the shim's
// POST /api/ask — it gets an owner so "needs a human" names that human. One
// shared helper, called from all three transitions.
//
// Rules, exactly as contracted:
//   · manual assignment ALWAYS wins — a non-null `assignee` is never touched;
//   · the name is the reporter's qa_allowed_emails.display_name when they have
//     one, else QA_DEFAULT_ASSIGNEE;
//   · the write is paired with a qa_events {type:'system'} line so the handoff
//     is visible in the log.
// Only the block transition assigns; later transitions never re-assign.

import type { Ctx } from './state';
import { log } from './util';

/**
 * Idempotent: the assignment is a conditional `assignee is null` update, so a
 * re-settle (worker restart, duplicate ask) or a race with the tester's own
 * picker updates no row — and then no event is written either. Never throws:
 * an auto-assign failure must not take down the transition that triggered it.
 */
export async function autoAssignOnBlock(ctx: Ctx, reportId: number): Promise<void> {
  try {
    const report = await ctx.db.getReport(reportId);
    if (!report) {
      log('assign', `auto-assign skipped: report ${reportId} not found`);
      return;
    }
    if (report.assignee) return; // manual assignment always wins

    const reporterName = report.reporter_email
      ? await ctx.db.displayNameForEmail(report.reporter_email)
      : null;
    const name = reporterName ?? ctx.cfg.defaultAssignee;

    if (!(await ctx.db.assignIfUnassigned(reportId, name))) {
      log('assign', `report ${reportId} already assigned — auto-assign skipped`);
      return;
    }
    await ctx.db.insertEvent({
      report_id: reportId,
      type: 'system',
      message: `auto-assigned to ${name} — needs a human`,
    });
    log('assign', `report ${reportId} auto-assigned to ${name}`);
  } catch (e) {
    log('assign', `auto-assign failed for report ${reportId}: ${(e as Error).message}`);
  }
}
