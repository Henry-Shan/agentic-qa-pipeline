// The infra lane (contracts §Router). Some reports cannot be fixed by changing
// this repo at all — an expired secret, a DNS record, a Lambda that needs
// redeploying, a quota. Today those still run the whole code pipeline and end
// as "Blocked" with nothing to show for it.
//
// This lane spawns NO code run. It asks a model to write a RUNBOOK from the
// reporter's words — what is likely wrong, where to look, what to run — and
// hands that to a human as the needs-human summary. Seconds instead of a Tier-3
// pipeline, and the human starts with a checklist instead of a dead PR.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { autoAssignOnBlock } from './assign';
import type { QaReport } from './db';
import type { Ctx } from './state';
import { log } from './util';

const RUNBOOK_TIMEOUT_MS = 5 * 60_000;

function prompt(report: QaReport, outPath: string): string {
  return `A tester reported the problem below. It has been routed as INFRASTRUCTURE: the fix is not a change to the the host app application code — it lives in a cloud console, DNS, environment variables, a deploy pipeline, a third-party dashboard, or an account/quota.

Do NOT write or change any code. Do NOT create a PR. Write a RUNBOOK a competent engineer can follow.

THE REPORT
"""
${(report.description ?? report.title ?? '').slice(0, 3000)}
"""
${report.done_when?.trim() ? `\nWhat the tester expects once it works:\n"""\n${report.done_when.trim().slice(0, 800)}\n"""\n` : ''}
Known stack (only mention what is plausibly involved): AWS (EC2 host, S3, Lambda, SNS, Step Functions), MongoDB Atlas, Supabase (auth + Postgres), Cloudflare (DNS + Pages/Workers + tunnels), Vercel, GitHub Actions, Expo/EAS for mobile.

Write to ${outPath} a JSON object with EXACTLY this shape and nothing else:
{"likely_cause":"<1-2 sentences>","checks":["<a command or console page that CONFIRMS the cause, most-likely first>"],"fix":["<numbered concrete actions>"],"verify":"<how to confirm it is fixed, ideally the tester's own steps>","risk":"<anything destructive or billable to be careful about, or an empty string>"}

Keep it specific — name consoles, services and commands, not "check the configuration". Write only that one file.`;
}

interface Runbook {
  likely_cause?: string;
  checks?: string[];
  fix?: string[];
  verify?: string;
  risk?: string;
}

function render(rb: Runbook): string {
  const lines: string[] = [];
  lines.push('**What went wrong** (infrastructure — not a code change)');
  lines.push(rb.likely_cause?.trim() || 'Routed as infrastructure; the cause is outside this repo.');
  if (rb.checks?.length) {
    lines.push('');
    lines.push('**Confirm it**');
    for (const c of rb.checks.slice(0, 6)) lines.push(`- ${c}`);
  }
  if (rb.fix?.length) {
    lines.push('');
    lines.push('**Fix it**');
    rb.fix.slice(0, 8).forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  }
  if (rb.verify?.trim()) {
    lines.push('');
    lines.push(`**Verify** ${rb.verify.trim()}`);
  }
  if (rb.risk?.trim()) {
    lines.push('');
    lines.push(`**Careful** ${rb.risk.trim()}`);
  }
  return lines.join('\n').slice(0, 4000);
}

/**
 * Handle an infra-lane report end to end: write the runbook, block the report
 * and assign it. No run row is created — nothing was executed. Never throws;
 * a failure still blocks the report so it cannot silently vanish.
 */
export async function handleInfra(ctx: Ctx, report: QaReport, reason: string): Promise<void> {
  const dir = path.join(ctx.cfg.qaHome, 'runs', String(report.id));
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'runbook.json');
  fs.rmSync(outPath, { force: true });
  // The prompt goes INLINE, not as a file: claude only reads files inside its
  // cwd, and this lane deliberately runs in the report's own run directory so
  // it can neither wander into nor write to the runner checkout.
  const askPrompt = prompt(report, outPath);

  await ctx.db.insertEvent({
    report_id: report.id,
    run_id: null,
    type: 'system',
    message: `routed to the infra lane — ${reason}. No code run; writing a runbook.`,
  });

  if (!ctx.cfg.mockDispatch) {
    await new Promise<void>((resolve) => {
      const child = spawn(
        ctx.cfg.claudeBin,
        ['-p', askPrompt, '--model', ctx.cfg.routerModel, '--effort', 'high', '--permission-mode', 'acceptEdits'],
        { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] },
      );
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, RUNBOOK_TIMEOUT_MS);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  let body: string;
  try {
    body = render(JSON.parse(fs.readFileSync(outPath, 'utf8')) as Runbook);
  } catch {
    body =
      '**What went wrong** (infrastructure — not a code change)\n' +
      `Routed to the infra lane (${reason}), but the runbook could not be generated. ` +
      'Read the report and check the relevant console directly.';
  }

  await ctx.db.updateReport(report.id, { status: 'blocked' });
  await autoAssignOnBlock(ctx, report.id);
  await ctx.db.insertEvent({ report_id: report.id, run_id: null, type: 'needs_human', message: body });
  log('infra', `report ${report.id}: runbook written, routed to a human`);
}
