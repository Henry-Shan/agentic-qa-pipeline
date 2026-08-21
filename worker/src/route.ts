// The router (contracts §Router) — one cheap model call BEFORE any expensive
// work, reading ONLY the reporter's own words. It never sees the codebase, the
// screenshots or the recording: the point is to spend a few seconds deciding
// how much to spend, not to start solving the problem.
//
//   fast     a small, obvious, self-contained change → no grounding, no skill
//   complex  a real feature or multi-file bug → the full ship-task pipeline
//   infra    needs a human harness (AWS, DNS, env vars, billing, a vendor
//            dashboard) → NO code run at all; a runbook goes to a human
//
// Fails safe: anything unparseable, timed out, or uncertain lands on `complex`.
// Under-routing is expensive (a real bug handled sloppily); over-routing only
// costs tokens.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { QaReport } from './db';
import type { Ctx } from './state';
import { log } from './util';

export type Lane = 'fast' | 'complex' | 'infra';

export interface Routing {
  lane: Lane;
  reason: string;
}

const ROUTER_TIMEOUT_MS = 3 * 60_000;

const RUBRIC = `You are the ROUTER for an autonomous engineering queue. You decide how much machinery a task gets. You are given ONLY the reporter's own words — no code, no screenshots. Do not try to solve the task.

Choose exactly one lane:

"fast" — a small, obvious, self-contained change a careful engineer would finish in one sitting without design decisions. Copy and label changes, a wrong string, an obviously wrong constant, a missing null guard, styling/layout tweaks, showing a field that is already fetched.

"complex" — anything that is a real feature, spans several files or layers, changes data shape or permissions, is a bug whose CAUSE is not stated outright, or is vague enough that reasonable engineers would build different things. THIS IS THE DEFAULT — choose it whenever you are not confident about "fast".

"infra" — the fix is not in the application code at all: cloud consoles, DNS, TLS, environment variables and secrets, deploy or build pipelines, database provisioning, third-party dashboards, billing or quotas, account access. Choose this even if the SYMPTOM is in the UI, when the described cause lives outside the repo.

Rules:
- When torn between fast and complex, choose complex.
- "It should be easy" or "just" in the report is not evidence; judge the work, not the tone.
- A feature request is never "fast", however small it sounds.`;

function prompt(report: QaReport, outPath: string): string {
  const words = [report.description ?? '', report.done_when ?? ''].filter(Boolean).join('\n\n').trim();
  return `${RUBRIC}

THE REPORTER'S WORDS
"""
${(words || report.title || '').slice(0, 4000)}
"""

Write your decision as JSON to ${outPath} with EXACTLY this shape and nothing else:
{"lane":"fast|complex|infra","reason":"<one plain sentence, max 20 words, saying why>"}

Write the file, then reply with one short line. Do not read or edit anything else.`;
}

function readDecision(file: string): Routing | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Routing>;
    if (raw.lane !== 'fast' && raw.lane !== 'complex' && raw.lane !== 'infra') return null;
    return { lane: raw.lane, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '' };
  } catch {
    return null;
  }
}

/** Decide a lane. Never throws — an unusable answer becomes `complex`. */
export async function routeTask(ctx: Ctx, report: QaReport): Promise<Routing> {
  const fallback: Routing = { lane: 'complex', reason: 'router unavailable — defaulted to the full pipeline' };
  if (!ctx.cfg.routerEnabled) {
    return { lane: 'complex', reason: 'router disabled' };
  }
  if (ctx.cfg.mockDispatch) return { lane: 'complex', reason: 'mock dispatch' };

  const dir = path.join(ctx.cfg.qaHome, 'runs', String(report.id));
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'routing.json');
  fs.rmSync(outPath, { force: true });
  const promptPath = path.join(dir, 'router-prompt.txt');
  fs.writeFileSync(promptPath, prompt(report, outPath));

  await new Promise<void>((resolve) => {
    const child = spawn(
      ctx.cfg.claudeBin,
      [
        '-p',
        `Read ${promptPath} and follow it exactly.`,
        '--model',
        ctx.cfg.routerModel,
        '--effort',
        ctx.cfg.routerEffort,
        '--permission-mode',
        'acceptEdits',
      ],
      { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, ROUTER_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const decision = readDecision(outPath) ?? fallback;
  log('router', `report ${report.id} → ${decision.lane}: ${decision.reason}`);
  return decision;
}
