// End-to-end selftest against the REAL Supabase project (qa_ tables only),
// with a MOCK dispatcher and MOCK preview server — no real claude spawn.
// Asserts queued → running → pr_ready → preview(live) → verified, then a
// destroy leg (message kind `destroy` → preview dead, worktree gone, report
// row hard-deleted with runs/messages cascade-gone; gh mocked away), then a
// blocked leg (QA_MOCK_MODE=blocked → run exits with the blocked sentinel,
// report `blocked`, needs_human handoff event, no PR; summarizer mocked) run
// TWICE to pin auto-assign-on-block precedence: once for a reporter who has a
// qa_allowed_emails.display_name (assignee = that name) and once for one who
// does not (assignee = QA_DEFAULT_ASSIGNEE) — each asserting the report ends
// `blocked`, `assignee` is set, and the auto-assign system event exists.
// Then cleans up every row and tmp dir it created. Run: npm run selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, pidAlive, workerDir, type WorkerConfig } from './config';
import { Db, type QaReport } from './db';
import { startWorker, type WorkerHandle } from './index';
import { stopAllPreviews } from './preview';
import { waitUntil } from './util';

// Env overrides BEFORE loadConfig(); real env always beats worker/.env.
// Isolated QA_HOME + own shim port so a live production worker is untouched;
// high MAX_RUNS/RUNS_PER_DAY so real rows in qa_runs can't starve the gate
// (onlyReportId keeps the loops scoped to the seeded report regardless).
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pipeline-selftest-'));
process.env.QA_MOCK_DISPATCH = '1';
process.env.QA_HOME = scratchHome;
// The shim rejects worktrees outside WORKTREE_BASE; scope the base to the
// scratch dir so the mock's fake worktree passes validation AND is cleaned up.
process.env.WORKTREE_BASE = path.join(scratchHome, 'worktrees');
process.env.SHIM_PORT = '4529';
process.env.PREVIEW_MODE = 'local';
process.env.MAX_RUNS = '50';
process.env.RUNS_PER_DAY = '1000';
process.env.DISPATCH_STAGGER_MS = '0';
process.env.PREVIEW_CMD = `node ${path.join(workerDir(), 'mock', 'mock-server.mjs')} --port`;

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function check(name: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const ok = await waitUntil(pred, timeoutMs, 1_000);
  record(name, ok, ok ? '' : `timed out after ${timeoutMs}ms`);
  if (!ok) throw new Error(`step failed: ${name}`);
}

// ---- blocked-leg fixtures (auto-assign-on-block precedence) ----------------
// Two throwaway reporter identities. The "named" one gets a temporary
// qa_allowed_emails row with a display_name (deleted in cleanup); the "noname"
// one is never allow-listed, so it must fall through to QA_DEFAULT_ASSIGNEE.
const NAMED_EMAIL = 'selftest-named@example.com';
const NAMED_DISPLAY = 'selftest-tester';
const NONAME_EMAIL = 'selftest-noname@example.com';

async function seedBlockedReport(db: Db, reporterEmail: string, label: string): Promise<QaReport> {
  const row = await db.insertReport({
    title: `[selftest] fake blocked report (${label}) — safe to delete`,
    description: 'inserted by worker selftest (blocked leg); will be deleted at the end of the run',
    kind: 'bug',
    status: 'queued',
    reporter_email: reporterEmail,
    route: '/selftest',
    page_title: `Selftest (blocked · ${label})`,
    click_trail: [],
    console_log: [],
    network_log: [],
    screenshots: [],
  });
  record(`blocked/${label}: fake qa_report inserted`, true, `id ${row.id}, reporter ${reporterEmail}`);
  return row;
}

/**
 * Drive one blocked leg to settlement and assert the whole needs-a-human
 * contract for it: status `blocked`, the three-section needs_human handoff, no
 * PR, `assignee` = the expected name, and the auto-assign system event.
 */
async function assertBlockedLeg(
  db: Db,
  cfg: WorkerConfig,
  reportId: number,
  expectedAssignee: string,
  label: string,
): Promise<void> {
  cfg.onlyReportId = reportId;
  await check(
    `blocked/${label}: queued -> running`,
    async () => (await db.getReport(reportId))?.status === 'running',
    30_000,
  );
  await check(
    `blocked/${label}: run settles -> report blocked`,
    async () => (await db.getReport(reportId))?.status === 'blocked',
    60_000,
  );
  await check(
    `blocked/${label}: needs_human event with the three handoff sections`,
    async () => {
      const run = await db.latestRunForReport(reportId);
      if (!run) return false;
      const msg = (await db.eventsForRun(run.id, 'needs_human'))[0]?.message ?? '';
      return (
        msg.includes('**What went wrong**') &&
        msg.includes('**What I analyzed**') &&
        msg.includes('**What to do**')
      );
    },
    30_000,
  );
  // Auto-assign lands with the status write, but both are async — wait for it.
  await check(
    `blocked/${label}: auto-assigned to ${expectedAssignee}`,
    async () => (await db.getReport(reportId))?.assignee === expectedAssignee,
    30_000,
  );
  const events = await db.eventsForReport(reportId, 'system');
  const wanted = `auto-assigned to ${expectedAssignee} — needs a human`;
  const matches = events.filter((e) => e.message === wanted);
  record(
    `blocked/${label}: auto-assign system event (exactly one)`,
    matches.length === 1,
    matches.length === 1 ? wanted : `found ${matches.length} matching of ${events.length} system events`,
  );
  const run = await db.latestRunForReport(reportId);
  record(
    `blocked/${label}: no pr_url on the run`,
    run !== null && run.pr_url === null,
    run ? (run.pr_url ?? 'pr_url null') : 'no run row',
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new Db(cfg);
  let report: QaReport | null = null;
  const blockedReports: QaReport[] = [];
  let allowedSeeded = false;
  let handle: WorkerHandle | null = null;
  let worktree: string | null = null;

  try {
    report = await db.insertReport({
      title: '[selftest] fake report — safe to delete',
      description: 'inserted by worker selftest; will be deleted at the end of the run',
      kind: 'bug',
      status: 'queued',
      reporter_email: 'selftest@example.com',
      route: '/selftest',
      page_title: 'Selftest',
      click_trail: [],
      console_log: [],
      network_log: [],
      screenshots: [],
    });
    record('seed: fake qa_report inserted', true, `id ${report.id}`);
    const id = report.id;
    cfg.onlyReportId = id;

    handle = await startWorker(cfg);
    record('boot: worker + shim started', true, `shim :${cfg.shimPort}`);

    await check(
      'claim: queued -> running',
      async () => (await db.getReport(id))?.status === 'running',
      30_000,
    );

    await check(
      'runinfo: -> pr_ready (PR #9999)',
      async () => {
        const r = await db.getReport(id);
        const run = await db.latestRunForReport(id);
        return (r?.status === 'pr_ready' || r?.status === 'preview') && run?.pr_number === 9999;
      },
      60_000,
    );

    await check(
      'preview: -> preview live on localhost',
      async () => {
        const r = await db.getReport(id);
        const run = await db.latestRunForReport(id);
        return (
          r?.status === 'preview' &&
          run?.preview_status === 'live' &&
          (run.preview_url ?? '').startsWith('http://localhost:')
        );
      },
      150_000,
    );
    worktree = (await db.latestRunForReport(id))?.worktree ?? null;

    await db.insertMessage({ report_id: id, kind: 'verdict_fixed', body: '', author_email: 'selftest@example.com' });
    await check(
      'verdict: verdict_fixed -> verified',
      async () => (await db.getReport(id))?.status === 'verified',
      30_000,
    );

    // ---- destroy leg: full teardown via a qa_messages kind 'destroy' ----
    // The mock worktree is not a real git worktree, so teardown-worktree.sh
    // fails non-fatally and the handler's rm fallback (guarded to
    // WORKTREE_BASE) removes the dir.
    const previewPid = worktree ? readPid(path.join(worktree, '.qa', 'preview.pid')) : null;
    record('destroy: preview pid captured', previewPid !== null, `pid ${previewPid ?? 'none'}`);
    if (previewPid === null) throw new Error('destroy leg: no preview pid to verify against');

    await db.insertMessage({ report_id: id, kind: 'destroy', body: '', author_email: 'selftest@example.com' });
    await check(
      'destroy: qa_reports row gone',
      async () => (await db.getReport(id)) === null,
      120_000,
    );
    await check('destroy: preview process dead', async () => !pidAlive(previewPid), 15_000);
    record('destroy: runs cascade-gone', (await db.runsForReport(id)).length === 0);
    record('destroy: messages cascade-gone', (await db.messagesForReport(id)).length === 0);
    record(
      'destroy: mock worktree dir removed',
      worktree !== null && !fs.existsSync(worktree),
      worktree ?? '(no worktree)',
    );
    record(
      'destroy: runs/<id> artifacts dir removed',
      !fs.existsSync(path.join(scratchHome, 'runs', String(id))),
    );

    // ---- blocked legs: run exits with the blocked sentinel, no PR ----
    // QA_MOCK_MODE is inherited by mock-run.mjs from the worker's env at spawn
    // time; the needs-human summarizer is mocked in-process by QA_MOCK_DISPATCH
    // (no `claude --resume` spawn). Run twice to pin auto-assign precedence.
    process.env.QA_MOCK_MODE = 'blocked';

    // Leg 1 — the reporter HAS a display_name: it must beat QA_DEFAULT_ASSIGNEE.
    await db.upsertAllowedEmail(NAMED_EMAIL, NAMED_DISPLAY);
    allowedSeeded = true;
    record('blocked: seeded reporter display name', true, `${NAMED_EMAIL} -> ${NAMED_DISPLAY}`);
    const named = await seedBlockedReport(db, NAMED_EMAIL, 'display-name');
    blockedReports.push(named);
    await assertBlockedLeg(db, cfg, named.id, NAMED_DISPLAY, 'display-name');

    // Leg 2 — the reporter has none, so the default takes over. Assert the
    // premise too: a stray display_name here would silently void the test.
    record(
      'blocked: default-leg reporter really has no display name',
      (await db.displayNameForEmail(NONAME_EMAIL)) === null,
      NONAME_EMAIL,
    );
    const noname = await seedBlockedReport(db, NONAME_EMAIL, 'default');
    blockedReports.push(noname);
    await assertBlockedLeg(db, cfg, noname.id, cfg.defaultAssignee, 'default');
  } catch (e) {
    if (results.every((r) => r.ok)) record('selftest', false, (e as Error).message);
  } finally {
    // ---- cleanup: every row + tmp dir this test created ----
    try {
      if (handle) await stopAllPreviews(handle.ctx); // kills the mock preview server
    } catch {
      /* best effort */
    }
    try {
      if (handle) await handle.stop();
    } catch {
      /* best effort */
    }
    if (worktree && path.basename(worktree).startsWith('qa-selftest-wt-')) {
      const pidFile = path.join(worktree, '.qa', 'preview.pid');
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) process.kill(pid, 'SIGKILL');
      } catch {
        /* no leftover preview */
      }
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    try {
      if (report) await db.deleteReport(report.id); // cascades runs/events/messages
    } catch (e) {
      record('cleanup: delete seeded report', false, (e as Error).message);
    }
    for (const row of blockedReports) {
      try {
        await db.deleteReport(row.id); // cascades runs/events/messages
      } catch (e) {
        record(`cleanup: delete seeded blocked report ${row.id}`, false, (e as Error).message);
      }
    }
    if (allowedSeeded) {
      try {
        await db.deleteAllowedEmail(NAMED_EMAIL);
      } catch (e) {
        record('cleanup: delete seeded tester display name', false, (e as Error).message);
      }
    }
    delete process.env.QA_MOCK_MODE;
    fs.rmSync(scratchHome, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failed.length} failed step${failed.length === 1 ? '' : 's'})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e: Error) => {
  console.error(e);
  console.log('SELFTEST FAIL (crashed)');
  process.exit(1);
});
