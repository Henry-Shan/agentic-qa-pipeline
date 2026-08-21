// The examination loop (contracts §Examination).
//
// When a fix's preview comes up, the worker re-executes the tester's recorded
// steps headlessly against it (exam/exam-run.mjs, Playwright) and hands the
// resulting per-step evidence to an EXAMINER model — a fresh context that has
// never seen the diff, so it judges the app's behavior, not its own work. The
// examiner answers one question: on this build, is the expected result there?
//
// The loop closes on the verdict:
//   pass          → the report waits for the human's merge, examination logged
//   fail, try 1   → automatic rework, steered with the examiner's evidence
//   fail, try ≥2  → STOP. Status blocked + assigned, so a human takes over
//                   rather than burning runs on a fix that isn't converging.
//   inconclusive  → logged, no rework (a broken harness must never steer code)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { autoAssignOnBlock } from './assign';
import { workerDir } from './config';
import type { QaReport, QaRun } from './db';
import { resumeRun } from './dispatch';
import type { Ctx } from './state';
import { log, nowIso } from './util';

/** Failed fix attempts after which the loop stops and a human takes over. */
const MAX_FIX_ATTEMPTS = 2;
const REPLAY_TIMEOUT_MS = 5 * 60_000;
const EXAMINER_TIMEOUT_MS = 10 * 60_000;
/** Screenshots handed to the examiner (and stored) — newest steps matter most. */
const MAX_SHOTS = 14;

export interface ExamFinding {
  claim: string;
  met: boolean;
  evidence: string;
}

export interface ExamVerdict {
  verdict: 'pass' | 'fail' | 'inconclusive';
  summary: string;
  findings: ExamFinding[];
}

interface StepRecord {
  i: number;
  label: string;
  status: string;
  why?: string;
  shot?: string | null;
  text?: string;
  consoleErrors?: string[];
  failedRequests?: string[];
}

interface Evidence {
  signedIn?: boolean;
  steps?: StepRecord[];
  shown?: number;
  skipped?: number;
  fatal?: string | null;
  startShot?: string | null;
  startText?: string;
  finalShot?: string | null;
  finalText?: string;
}

/** One-time sign-in token for the reporter, so the replay runs as THEIR role. */
async function mintToken(ctx: Ctx, email: string | null): Promise<string | null> {
  if (!email) return null;
  try {
    const res = await fetch(`${ctx.cfg.supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: ctx.cfg.supabaseServiceRoleKey,
        authorization: `Bearer ${ctx.cfg.supabaseServiceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type: 'magiclink', email }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { hashed_token?: string };
    return body.hashed_token ?? null;
  } catch {
    return null;
  }
}

function runProcess(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', () => {
      /* diagnostics only */
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** The examiner's prompt — evidence only, never the diff. */
function examinerPrompt(report: QaReport, evidence: Evidence, dir: string): string {
  const steps = (evidence.steps ?? [])
    .map((s) => {
      const bits = [`${s.i}. ${s.label} — ${s.status}${s.why ? ` (${s.why})` : ''}`];
      if (s.shot) bits.push(`   screenshot: ${path.join(dir, s.shot)}`);
      if (s.consoleErrors?.length) bits.push(`   console errors: ${s.consoleErrors.join(' | ')}`);
      if (s.failedRequests?.length) bits.push(`   failed requests: ${s.failedRequests.join(' | ')}`);
      if (s.text) bits.push(`   visible text after: ${JSON.stringify(s.text.slice(0, 700))}`);
      return bits.join('\n');
    })
    .join('\n');

  return `You are the EXAMINER for a QA fix. You have NOT seen the code change and must not look for it — judge ONLY what the app did.

A tester reported this, in their own words:
"""
${(report.description ?? report.title ?? '').slice(0, 4000)}
"""

Their recorded steps were re-executed on the FIXED build just now. Evidence per step is below; screenshots are files — READ THEM AS IMAGES with the Read tool before judging. The closing frame is the outcome.

Signed in as the reporter: ${evidence.signedIn ? 'yes' : 'NO — sign-in may have failed'}
Steps executed: ${evidence.shown ?? 0} · not executed: ${evidence.skipped ?? 0}
${evidence.fatal ? `Harness error: ${evidence.fatal}` : ''}
Starting screenshot: ${evidence.startShot ? path.join(dir, evidence.startShot) : '(none)'}
Closing screenshot: ${evidence.finalShot ? path.join(dir, evidence.finalShot) : '(none)'}
Closing visible text: ${JSON.stringify((evidence.finalText ?? '').slice(0, 900))}

STEPS
${steps || '(no steps were recorded with this report)'}

YOUR JOB
1. Derive the concrete expected result(s) from the tester's words above — what they say SHOULD happen.
2. For each, decide from the evidence whether it is TRUE on this build, quoting the specific screenshot/text that shows it.
3. Verdict:
   - "pass" — every expected result is visibly there.
   - "fail" — at least one is visibly NOT there, or an error appeared. Say precisely what you saw instead; this text is fed straight back to the engineer as the rework instruction, so make it actionable.
   - "inconclusive" — the evidence cannot decide it (sign-in failed, the harness errored, steps could not run, the expectation isn't observable in the UI). Do NOT guess. Steps that were merely "skipped" because an element moved are NOT automatically a fail — if the intended behavior is visible anyway, that is a pass; if you truly cannot tell, that is inconclusive.

Write your answer as JSON to ${path.join(dir, 'verdict.json')} with EXACTLY this shape, and nothing else:
{"verdict":"pass|fail|inconclusive","summary":"<2-3 sentences a non-engineer can read>","findings":[{"claim":"<the expected result>","met":true|false,"evidence":"<what you saw, citing a step or screenshot>"}]}

Write the file, then reply with one short line. Do not edit any other file.`;
}

function readVerdict(dir: string): ExamVerdict | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')) as Partial<ExamVerdict>;
    if (raw.verdict !== 'pass' && raw.verdict !== 'fail' && raw.verdict !== 'inconclusive') return null;
    return {
      verdict: raw.verdict,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      findings: Array.isArray(raw.findings)
        ? raw.findings
            .filter((f): f is ExamFinding => Boolean(f) && typeof f.claim === 'string')
            .map((f) => ({ claim: f.claim, met: Boolean(f.met), evidence: String(f.evidence ?? '') }))
        : [],
    };
  } catch {
    return null;
  }
}

/** Upload the step screenshots so the task page can show what the examiner saw. */
async function storeShots(ctx: Ctx, reportId: number, examKey: string, dir: string, names: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const name of names.slice(0, MAX_SHOTS)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const storagePath = `report-${reportId}/exam-${examKey}/${name}`;
    try {
      const { error } = await ctx.db.uploadScreenshot(storagePath, fs.readFileSync(file));
      if (!error) paths.push(storagePath);
    } catch {
      // evidence upload is best-effort — the verdict still stands
    }
  }
  return paths;
}

/**
 * Run one examination for a live preview and act on the verdict. Safe to call
 * fire-and-forget: every failure path logs and returns without throwing.
 */
export async function examine(ctx: Ctx, report: QaReport, run: QaRun): Promise<void> {
  const trail = Array.isArray(report.click_trail) ? report.click_trail : [];
  if (trail.length === 0) {
    log('examine', `report ${report.id} has no recorded steps — nothing to examine`);
    return;
  }
  if (!run.preview_url) return;

  const dir = path.join(ctx.cfg.qaHome, 'runs', String(report.id), `exam-${run.id}-${run.attempt}`);
  fs.mkdirSync(dir, { recursive: true });
  log('examine', `report ${report.id}: replaying ${trail.length} steps on ${run.preview_url}`);
  await ctx.db.insertEvent({
    report_id: report.id,
    run_id: run.id,
    type: 'system',
    message: `examination started — replaying ${trail.length} recorded steps on the fixed build`,
  });

  // 1. Headless re-execution of the tester's steps.
  const tokenHash = await mintToken(ctx, report.reporter_email ?? null);
  const args = [
    path.join(workerDir(), 'exam', 'exam-run.mjs'),
    JSON.stringify({
      playwrightPath: path.join(ctx.cfg.runnerRepo, 'node_modules', 'playwright'),
      previewUrl: run.preview_url,
      tokenHash,
      route: report.route ?? '/',
      steps: trail,
      outDir: dir,
      viewport: report.viewport ?? { w: 1440, h: 900 },
    }),
  ];
  await runProcess(process.execPath, args, ctx.cfg.runnerRepo, REPLAY_TIMEOUT_MS);

  let evidence: Evidence = {};
  try {
    evidence = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8')) as Evidence;
  } catch {
    log('examine', `report ${report.id}: no evidence produced — skipping the verdict`);
    await ctx.db.insertEvent({
      report_id: report.id,
      run_id: run.id,
      type: 'error',
      message: 'examination harness produced no evidence — left for the tester',
    });
    return;
  }

  // 2. The examiner model — fresh context, evidence only, never the diff.
  const promptPath = path.join(dir, 'examiner-prompt.txt');
  fs.writeFileSync(promptPath, examinerPrompt(report, evidence, dir));
  await runProcess(
    ctx.cfg.claudeBin,
    [
      '-p',
      `Read ${promptPath} and follow it exactly.`,
      '--model',
      ctx.cfg.examinerModel,
      '--effort',
      ctx.cfg.examinerEffort,
      '--permission-mode',
      'acceptEdits',
    ],
    dir,
    EXAMINER_TIMEOUT_MS,
  );

  const verdict = readVerdict(dir) ?? {
    verdict: 'inconclusive' as const,
    summary: 'The examiner did not return a readable verdict.',
    findings: [],
  };

  // 3. Store what the examiner saw, then record the examination.
  const shotNames = [
    ...(evidence.startShot ? [evidence.startShot] : []),
    ...(evidence.steps ?? []).map((s) => s.shot).filter((n): n is string => Boolean(n)),
    ...(evidence.finalShot ? [evidence.finalShot] : []),
  ];
  const shots = await storeShots(ctx, report.id, `${run.id}-${run.attempt}`, dir, shotNames);
  await ctx.db.insertExamination({
    report_id: report.id,
    run_id: run.id,
    attempt: run.attempt,
    verdict: verdict.verdict,
    summary: verdict.summary,
    findings: verdict.findings,
    shots,
    steps_shown: evidence.shown ?? 0,
    steps_skipped: evidence.skipped ?? 0,
  });

  const headline = `examiner: ${verdict.verdict.toUpperCase()} — ${verdict.summary.slice(0, 400)}`;
  log('examine', `report ${report.id}: ${verdict.verdict} (attempt ${run.attempt})`);

  // 4. Close the loop.
  if (verdict.verdict === 'pass') {
    await ctx.db.insertEvent({ report_id: report.id, run_id: run.id, type: 'system', message: headline });
    return; // the human still merges; the examination is the evidence they read
  }
  if (verdict.verdict === 'inconclusive') {
    await ctx.db.insertEvent({ report_id: report.id, run_id: run.id, type: 'system', message: headline });
    return; // never steer code on evidence that couldn't decide anything
  }

  await ctx.db.insertEvent({ report_id: report.id, run_id: run.id, type: 'error', message: headline });

  if (run.attempt >= MAX_FIX_ATTEMPTS) {
    await ctx.db.updateReport(report.id, { status: 'blocked' });
    await autoAssignOnBlock(ctx, report.id);
    await ctx.db.insertEvent({
      report_id: report.id,
      run_id: run.id,
      type: 'needs_human',
      message:
        `Two fix attempts did not satisfy the examination — stopping.\n\n` +
        `Last examiner verdict: ${verdict.summary}\n\n` +
        verdict.findings
          .filter((f) => !f.met)
          .map((f) => `· expected: ${f.claim}\n  saw: ${f.evidence}`)
          .join('\n') +
        `\n\nThe branch and preview are still up — take it from here.`,
    });
    log('examine', `report ${report.id}: ${MAX_FIX_ATTEMPTS} failed attempts — routed to a human`);
    return;
  }

  // Rework: same session, steered with exactly what the examiner saw.
  const note =
    `The fix did not pass examination. Your changes were re-tested by replaying the tester's own recorded steps ` +
    `on your preview build, and an independent examiner judged the result:\n\n${verdict.summary}\n\n` +
    verdict.findings
      .filter((f) => !f.met)
      .map((f) => `· expected: ${f.claim}\n  observed: ${f.evidence}`)
      .join('\n') +
    `\n\nRe-orient in your worktree, fix the cause of what was observed, and push to the same PR. ` +
    `This is attempt ${run.attempt + 1} of ${MAX_FIX_ATTEMPTS}; after this the report goes to a human.`;
  await ctx.db.updateRun(run.id, { finished_at: run.finished_at ?? nowIso() });
  await resumeRun(ctx, report, run, note, 'rework');
}
