import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { pidAlive, workerDir, type WorkerConfig } from './config';
import type { QaReport, QaRun } from './db';
import type { Ctx, RunHandle } from './state';
import { log, nowIso, sleep, tailChars } from './util';

const RATE_LIMIT_COOLDOWN_MS = 30 * 60_000;
const LOG_FLUSH_MS = 2_000; // throttle: at most one log event / log_tail write per 2s
const LOG_TAIL_CHARS = 200;

/**
 * Per-boot shim auth token. Exported into every spawned run's env as
 * QA_SHIM_TOKEN; the shim rejects callbacks without the matching x-qa-shim
 * header, so nothing else on localhost can drive the run state machine.
 */
export const SHIM_TOKEN = crypto.randomBytes(32).toString('hex');

// Adapted from the manager skill's dispatch.sh relay preamble.
function preamble(cfg: WorkerConfig, sessionId: string): string {
  const url = `http://127.0.0.1:${cfg.shimPort}`;
  return `─────────────────────────────────────────────────────────────────────
QA-WORKER MODE: AUTONOMOUS, STOP AT PR-READY (overrides ship-task's gates)

You are running headless under the qa-pipeline worker. There is NO terminal, so
AskUserQuestion hangs forever — never call it.

AUTH: every callback curl to ${url} MUST include the header -H "x-qa-shim: $QA_SHIM_TOKEN" (the token is already in your environment).

PROGRESS BEACONS. On every pipeline phase change, fire-and-forget:
  curl -s -X POST ${url}/api/progress -H 'Content-Type: application/json' \\
    -d '{"session_id":"${sessionId}","phase":"<grounding|testing|implementing|verifying|feature_test|pr>"}'

STOP LINE = PR-READY. Run the full ship-task pipeline up to: branch -> commit ->
push -> open PR. Then STOP and HAND OFF — do NOT wait for CI and do NOT merge
(the human merges from GitHub). As soon as the PR is open, report it:
  curl -s -X POST ${url}/api/runinfo -H 'Content-Type: application/json' \\
    -d '{"session_id":"${sessionId}","pr_url":"<PR url>","branch":"<branch name>","worktree":"<absolute worktree path>","test_plan":"<manual test guide>","files_changed":[{"file":"<path>","add":0,"del":0}],"grounding":[{"label":"<one-line trace step>","file":"<path>"}]}'
Then finish with a one-line summary. Reaching a green PR = success.

THE TEST GUIDE (test_plan) is for a non-engineer tester to verify the fix by
hand on the preview URL the worker will start: concise numbered steps, each
naming which account/role to log in as, where to go, what to click, and what
they should see, ending with a "✅ Success =" line. Use real seeded test
accounts from the repo / project memory — never invent one. Under ~12 lines.

INVESTIGATE BEFORE ASKING. Resolve unknowns yourself first: read the repo, the
task envelope, query project memory. Only escalate a genuine PREFERENCE you
cannot determine from evidence, with your recommendation:
  1. POST {"session_id":"${sessionId}","question":"<plain question>","options":["<opt>"],"context":"<why + your recommendation>"} to ${url}/api/ask
  2. Poll ${url}/api/answer?session_id=${sessionId} every 10s until "answer" is
     non-null, then continue with that decision.

DEV SERVERS: do NOT start this worktree's dev servers — the worker launches the
tester preview itself after you report runinfo. The verify gate is hermetic.

Every other ship-task invariant (blind test agent, verify gate) stays.
─────────────────────────────────────────────────────────────────────`;
}

interface SpawnSpec {
  kind: 'fresh' | 'resume';
  prompt: string;
  sessionId: string;
  envelopePath?: string;
}

// Serialize dispatch STARTS: ship-task's setup-worktree pulls the base branch
// in the runner checkout, and two concurrent setups corrupt it. The gate lets
// the caller return as soon as ITS spawn happened, but holds the NEXT spawn
// for dispatchStaggerMs.
let spawnGate: Promise<void> = Promise.resolve();

function spawnGated(ctx: Ctx, spec: SpawnSpec): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const prev = spawnGate;
    let release!: () => void;
    spawnGate = new Promise<void>((r) => {
      release = r;
    });
    void prev.then(async () => {
      try {
        const child = spawnClaude(ctx, spec);
        resolve(child);
        await sleep(ctx.cfg.mockDispatch ? 0 : ctx.cfg.dispatchStaggerMs);
      } catch (e) {
        reject(e as Error);
      } finally {
        release();
      }
    });
  });
}

function spawnClaude(ctx: Ctx, spec: SpawnSpec): ChildProcess {
  const { cfg } = ctx;
  const env = {
    ...process.env,
    MANAGER_MODE: '1',
    MANAGER_URL: `http://127.0.0.1:${cfg.shimPort}`,
    MANAGER_SESSION_ID: spec.sessionId,
    QA_SHIM_TOKEN: SHIM_TOKEN,
  };
  if (cfg.mockDispatch) {
    const mock = path.join(workerDir(), 'mock', 'mock-run.mjs');
    return spawn(process.execPath, [mock, spec.sessionId, spec.envelopePath ?? '', spec.kind], {
      cwd: workerDir(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  const args =
    spec.kind === 'resume'
      ? ['--resume', spec.sessionId, '-p', spec.prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
      : ['-p', spec.prompt, '--session-id', spec.sessionId, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  return spawn(cfg.claudeBin, args, {
    cwd: cfg.runnerRepo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function dispatchRun(ctx: Ctx, report: QaReport, envelopePath: string): Promise<void> {
  const sessionId = crypto.randomUUID();
  const run = await ctx.db.insertRun({
    report_id: report.id,
    session_id: sessionId,
    attempt: 1,
    status: 'running',
    phase: 'starting',
  });
  const prompt = `${preamble(ctx.cfg, sessionId)}\n/ship-task 'Read and execute the task envelope at ${envelopePath}'`;
  await spawnAndTrack(ctx, run, { kind: 'fresh', prompt, sessionId, envelopePath });
  log('dispatch', `run ${run.id} started for report ${report.id} (session ${sessionId})`);
}

/** Resume the same claude session with a tester note; new qa_runs attempt row. */
export async function resumeRun(
  ctx: Ctx,
  report: QaReport,
  prevRun: QaRun,
  note: string,
  reportStatus: 'running' | 'rework',
): Promise<void> {
  const run = await ctx.db.insertRun({
    report_id: report.id,
    session_id: prevRun.session_id,
    attempt: prevRun.attempt + 1,
    status: 'running',
    phase: 'starting',
    tier: prevRun.tier,
    worktree: prevRun.worktree,
    branch: prevRun.branch,
    pr_url: prevRun.pr_url,
    pr_number: prevRun.pr_number,
    grounding: prevRun.grounding,
  });
  // A resumed session is no longer polling /api/answer: clear any stale ask
  // flag so future mid-run steers interrupt instead of being silently skipped.
  ctx.state.setAskPending(report.id, false);
  await ctx.db.updateReport(report.id, { status: reportStatus });
  const prompt = `Tester note:\n${note}\n\nContinue on the SAME branch and worktree you already created (${prevRun.branch ?? 'your branch'} at ${prevRun.worktree ?? 'your worktree'}) — do not start over. Investigate, fix, re-run the verify gate, push to the same PR, and re-report runinfo when done.\n\n${preamble(ctx.cfg, prevRun.session_id)}`;
  await spawnAndTrack(ctx, run, { kind: 'resume', prompt, sessionId: prevRun.session_id });
  log('dispatch', `resume run ${run.id} (attempt ${run.attempt}) for report ${report.id}`);
}

async function spawnAndTrack(ctx: Ctx, run: QaRun, spec: SpawnSpec): Promise<void> {
  const child = await spawnGated(ctx, spec);
  const handle: RunHandle = {
    runId: run.id,
    reportId: run.report_id,
    sessionId: spec.sessionId,
    pid: child.pid ?? null,
    child,
    stopRequested: false,
    steerInterrupt: false,
    runinfoReceived: false,
  };
  ctx.state.activeDispatches++;
  ctx.state.registerRun(handle);
  trackChild(ctx, handle, child);
}

interface StreamLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { content?: Array<{ type?: string; text?: unknown }> };
}

interface RunFlags {
  ok: boolean;
  stopped: boolean;
  limited: boolean;
  resultText: string;
}

function trackChild(ctx: Ctx, h: RunHandle, child: ChildProcess): void {
  const flags: RunFlags = { ok: false, stopped: false, limited: false, resultText: '' };
  let logBuf = '';
  let tailAll = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let settled = false;

  const flush = (): void => {
    flushTimer = null;
    if (!logBuf) return;
    const chunk = logBuf;
    logBuf = '';
    void ctx.db.insertEvent({ report_id: h.reportId, run_id: h.runId, type: 'log', message: chunk });
    void ctx.db
      .updateRun(h.runId, { log_tail: tailChars(tailAll, LOG_TAIL_CHARS) })
      .catch((e: Error) => log('dispatch', `log_tail update failed: ${e.message}`));
  };
  const queueFlush = (): void => {
    if (!flushTimer) flushTimer = setTimeout(flush, LOG_FLUSH_MS);
  };

  const onLine = (raw: string): void => {
    const line = raw.trim();
    if (
      line.includes('"api_error_status":429') ||
      line.includes('"error":"rate_limit"') ||
      /hit your session limit|usage limit/i.test(line)
    ) {
      flags.limited = true;
    }
    if (!line.startsWith('{')) return;
    let o: StreamLine;
    try {
      o = JSON.parse(line) as StreamLine;
    } catch {
      return;
    }
    if (o.type === 'assistant') {
      for (const block of o.message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          const text = block.text.trim();
          logBuf += (logBuf ? '\n' : '') + text;
          tailAll = tailChars(`${tailAll} ${text.replace(/\s+/g, ' ')}`, LOG_TAIL_CHARS * 2);
          queueFlush();
        }
      }
    } else if (o.type === 'result') {
      flags.ok = o.subtype === 'success' && !o.is_error;
      flags.resultText = typeof o.result === 'string' ? o.result : '';
      // ship-task's own STOP-gate sentinel — a clean run merely *mentioning*
      // "stop" is not stopped.
      if (/Stopped at Step|🛑/.test(flags.resultText)) flags.stopped = true;
      if (/hit your session limit|usage limit/i.test(flags.resultText)) flags.limited = true;
    }
  };

  if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', onLine);
  if (child.stderr) {
    readline.createInterface({ input: child.stderr }).on('line', (l) => {
      if (/429|rate.?limit/i.test(l)) flags.limited = true;
    });
  }

  const doSettle = (code: number): void => {
    if (settled) return;
    settled = true;
    if (flushTimer) clearTimeout(flushTimer);
    flush();
    void settle(ctx, h, flags, code);
  };
  child.once('error', (e) => {
    if (!flags.resultText) flags.resultText = `spawn error: ${e.message}`;
    // 'close' may not fire when the spawn itself failed
    setTimeout(() => doSettle(-1), 3_000);
  });
  child.once('close', (code) => doSettle(code ?? -1));
}

async function settle(ctx: Ctx, h: RunHandle, flags: RunFlags, exitCode: number): Promise<void> {
  ctx.state.removeRun(h);
  if (ctx.state.activeDispatches > 0) ctx.state.activeDispatches--;
  try {
    // steer.ts owns statuses + the resume when it interrupted the run
    if (h.stopRequested || h.steerInterrupt) return;
    const run = await ctx.db.getRun(h.runId);
    const report = await ctx.db.getReport(h.reportId);
    if (!run || !report) return;
    if (run.status !== 'running') return; // already settled elsewhere
    const handedOff =
      h.runinfoReceived || report.status === 'pr_ready' || report.status === 'preview' || report.status === 'verified';
    const finished = nowIso();

    if (flags.stopped) {
      const reason = tailChars(flags.resultText, 400) || 'ship-task stopped at one of its gates';
      await ctx.db.updateRun(run.id, { status: 'stopped', stopped_reason: reason, finished_at: finished });
      await ctx.db.updateReport(report.id, { status: 'blocked' });
      await ctx.db.insertEvent({ report_id: report.id, run_id: run.id, type: 'error', message: `run stopped: ${reason}` });
    } else if (flags.limited && !(flags.ok && handedOff)) {
      ctx.state.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      await ctx.db.updateRun(run.id, {
        status: 'limited',
        stopped_reason: 'usage/rate limit — requeued with cooldown',
        finished_at: finished,
      });
      await ctx.db.updateReport(report.id, { status: 'queued' });
      await ctx.db.insertEvent({
        report_id: report.id,
        run_id: run.id,
        type: 'system',
        message: `rate limit hit — requeued; worker cools down until ${new Date(ctx.state.cooldownUntil).toISOString()}`,
      });
    } else if (flags.ok && handedOff) {
      await ctx.db.updateRun(run.id, { status: 'done', phase: 'done', finished_at: finished });
      // report status (pr_ready → preview → …) is owned by the shim + preview now
    } else if (flags.ok) {
      await ctx.db.updateRun(run.id, {
        status: 'done',
        phase: 'done',
        finished_at: finished,
        stopped_reason: 'finished without reporting a PR',
      });
      await ctx.db.updateReport(report.id, { status: 'blocked' });
      await ctx.db.insertEvent({
        report_id: report.id,
        run_id: run.id,
        type: 'error',
        message: 'run finished without posting runinfo (no PR reported) — press Send to steer',
      });
    } else {
      const reason = tailChars(flags.resultText, 400) || `claude exited with code ${exitCode}`;
      await ctx.db.updateRun(run.id, { status: 'failed', stopped_reason: reason, finished_at: finished });
      await ctx.db.updateReport(report.id, { status: 'failed' });
      await ctx.db.insertEvent({ report_id: report.id, run_id: run.id, type: 'error', message: `run failed: ${reason}` });
    }
  } catch (e) {
    log('dispatch', `settle failed for run ${h.runId}: ${(e as Error).message}`);
  }
}

/** SIGINT/SIGKILL the run's whole process group (detached spawn = own pgid). */
export function killRunGroup(h: RunHandle, signal: NodeJS.Signals = 'SIGINT'): void {
  if (h.pid === null) return;
  try {
    process.kill(-h.pid, signal);
  } catch {
    try {
      process.kill(h.pid, signal);
    } catch {
      // already gone
    }
  }
}

export async function waitForExit(h: RunHandle, timeoutMs: number): Promise<boolean> {
  if (h.child) {
    const child = h.child;
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (h.pid === null || !pidAlive(h.pid)) return true;
    await sleep(500);
  }
  return h.pid === null || !pidAlive(h.pid);
}
