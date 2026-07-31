// Full teardown of a report — qa_messages kind `destroy`, per CONTRACTS.md
// §Status model: SIGINT any live run · stop the preview server (tunnel ingress
// entry removed by the existing preview teardown path) · run the repo's
// teardown-worktree.sh on each run's worktree · gh pr close <n> --delete-branch
// (non-fatal if already closed/merged — never delete merged work's history) ·
// delete the report's screenshots from the qa-screenshots bucket · remove
// ~/.qa-pipeline/runs/<id> · hard-delete the qa_reports row (cascades runs/
// events/messages/canvas rows).
//
// Idempotent: the message is marked delivered up front so a worker restart
// never reprocesses it, and every step treats "nothing to do" as success.
// Each major step logs a qa_events row BEFORE the final row delete so a
// watching UI shows progress; nothing is written after the row is gone.
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { QaMessage, QaReport } from './db';
import { killRunGroup, waitForExit, withRunnerLock } from './dispatch';
import { stopPreview } from './preview';
import type { Ctx, RunHandle } from './state';
import { log } from './util';

const SIGINT_WAIT_MS = 5_000;

export async function handleDestroy(
  ctx: Ctx,
  msg: QaMessage,
  report: QaReport,
  handle: RunHandle | null,
): Promise<void> {
  // 1. delivered immediately — pendingMessages() never returns it again, so a
  // crash/restart mid-teardown cannot double-process the destroy.
  await ctx.db.updateMessage(msg.id, 'delivered');
  const id = report.id;
  const event = (message: string): Promise<void> => ctx.db.insertEvent({ report_id: id, type: 'system', message });
  log('destroy', `report ${id}: teardown started`);
  await event(`destroy: teardown started${msg.author_email ? ` by ${msg.author_email}` : ''}`);
  ctx.state.setAskPending(id, false);

  // 2. live claude run: SIGINT the whole process group, wait briefly.
  if (handle) {
    handle.stopRequested = true; // settle() must not write rows for a report being deleted
    killRunGroup(handle, 'SIGINT');
    if (!(await waitForExit(handle, SIGINT_WAIT_MS))) {
      killRunGroup(handle, 'SIGKILL');
      await waitForExit(handle, 2_000);
    }
    ctx.state.removeRun(handle);
    // a re-attached (child-less) handle settles nowhere else — release its slot
    if (handle.child === null && ctx.state.activeDispatches > 0) ctx.state.activeDispatches--;
    await event('destroy: live run stopped');
  }

  const runs = await ctx.db.runsForReport(id);

  // 3. previews — the existing teardown path also drops the tunnel ingress
  // entry (stopPreview → syncTunnel) when PREVIEW_MODE=tunnel.
  for (const run of runs) {
    const preview = ctx.state.previews.get(run.id);
    if (preview) await stopPreview(ctx, preview, 'destroyed by tester');
  }

  // 4+5. worktrees + PR — teardown-worktree.sh touches the runner checkout, so
  // serialize with dispatch starts (one destroy at a time).
  await withRunnerLock(async () => {
    const worktrees = new Set<string>();
    for (const run of runs) if (run.worktree) worktrees.add(path.resolve(run.worktree));
    for (const wt of worktrees) await removeWorktree(ctx, id, wt);

    const prNumbers = new Set<number>();
    for (const run of runs) if (run.pr_number !== null) prNumbers.add(run.pr_number);
    for (const n of prNumbers) await closePr(ctx, id, n);
  });

  // 6. screenshots: every object under report-<id>/ in the qa-screenshots bucket.
  try {
    const n = await ctx.db.deleteReportScreenshots(id);
    await event(n > 0 ? `destroy: ${n} screenshot${n === 1 ? '' : 's'} deleted from bucket` : 'destroy: no screenshots in bucket');
  } catch (e) {
    await event(`destroy: screenshot delete failed (non-fatal): ${(e as Error).message.slice(0, 200)}`);
  }

  // 7. local run artifacts (envelope + downloaded screenshots).
  fs.rmSync(path.join(ctx.cfg.qaHome, 'runs', String(id)), { recursive: true, force: true });
  await event('destroy: local run artifacts removed');

  // 8. hard-delete the report row — cascades runs/events/messages/canvas rows.
  // This is the LAST step: no events (or any other write) after this.
  await event('destroy: complete — deleting report');
  await ctx.db.deleteReport(id);
  log('destroy', `report ${id}: destroyed`);
}

/**
 * Invoke the repo's teardown script (usage: `teardown-worktree.sh
 * <worktree-name>`, cwd = runner checkout) — never reimplemented here. A
 * non-zero exit is non-fatal but logged. If the directory still exists
 * afterwards, fall back to a plain recursive rm — ONLY when the resolved path
 * is strictly inside WORKTREE_BASE (mandatory guard).
 */
async function removeWorktree(ctx: Ctx, reportId: number, worktree: string): Promise<void> {
  const event = (message: string): Promise<void> =>
    ctx.db.insertEvent({ report_id: reportId, type: 'system', message });
  const name = path.basename(worktree);
  const script = path.join(ctx.cfg.runnerRepo, '.claude', 'skills', 'ship-task', 'teardown-worktree.sh');
  let scriptOk = false;
  if (fs.existsSync(script)) {
    const r = await execa('bash', [script, name], { cwd: ctx.cfg.runnerRepo, reject: false, timeout: 120_000 });
    scriptOk = r.exitCode === 0;
    if (!scriptOk) await event(`destroy: teardown-worktree.sh exited ${r.exitCode ?? 'on signal'} for ${name} (non-fatal)`);
  } else {
    await event('destroy: teardown-worktree.sh not found in runner repo (non-fatal)');
  }

  const base = path.resolve(ctx.cfg.worktreeBase);
  if (!fs.existsSync(worktree)) {
    await event(`destroy: worktree removed (${name})`);
  } else if (worktree.startsWith(base + path.sep)) {
    fs.rmSync(worktree, { recursive: true, force: true });
    await event(`destroy: worktree removed (${name}${scriptOk ? '' : ', rm fallback'})`);
  } else {
    await event(`destroy: worktree left in place — outside WORKTREE_BASE (${worktree})`);
  }
  // The script's repo paths are its own; the runner checkout may still hold a
  // stale registration for the removed dir — prune it (best effort).
  await execa('git', ['-C', ctx.cfg.runnerRepo, 'worktree', 'prune'], { reject: false, timeout: 60_000 });
}

/**
 * Close the PR and delete its remote branch. Already merged/closed PRs are
 * left untouched (repo policy: never delete merged work's history). Mocked
 * entirely under QA_MOCK_DISPATCH (selftest has no real PR).
 */
async function closePr(ctx: Ctx, reportId: number, prNumber: number): Promise<void> {
  const event = (message: string): Promise<void> =>
    ctx.db.insertEvent({ report_id: reportId, type: 'system', message });
  if (ctx.cfg.mockDispatch) {
    await event('destroy: skipped gh (mock)');
    return;
  }
  const view = await execa('gh', ['pr', 'view', String(prNumber), '--json', 'state'], {
    cwd: ctx.cfg.runnerRepo,
    reject: false,
    timeout: 60_000,
  });
  if (view.exitCode === 0) {
    try {
      const state = (JSON.parse(view.stdout ?? '{}') as { state?: string }).state ?? '';
      if (state && state !== 'OPEN') {
        await event(`destroy: PR #${prNumber} already ${state.toLowerCase()} — left untouched`);
        return;
      }
    } catch {
      // unparseable — fall through to the close attempt, which is itself non-fatal
    }
  }
  const r = await execa('gh', ['pr', 'close', String(prNumber), '--delete-branch'], {
    cwd: ctx.cfg.runnerRepo,
    reject: false,
    timeout: 60_000,
  });
  if (r.exitCode === 0) {
    await event(`destroy: PR #${prNumber} closed, remote branch deleted`);
  } else {
    await event(`destroy: gh pr close #${prNumber} failed (non-fatal): ${(r.stderr ?? '').slice(0, 200)}`);
  }
}
