#!/usr/bin/env node
// Fake ship-task run for `npm run selftest` (QA_MOCK_DISPATCH=1).
// Emits realistic claude stream-json lines on stdout, POSTs progress beacons
// and a runinfo hand-off to the worker shim, then exits 0 — no real claude.
//
// argv: <session-id> <envelope-path> <fresh|resume>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sessionId = process.argv[2] ?? process.env.MANAGER_SESSION_ID ?? '';
const envelopePath = process.argv[3] ?? '';
const kind = process.argv[4] ?? 'fresh';
const base = process.env.MANAGER_URL ?? 'http://127.0.0.1:4519';
// QA_MOCK_MODE=blocked → exit with ship-task's blocked sentinel instead of a
// runinfo hand-off (selftest's needs-a-human leg). Default: full runinfo leg.
const mode = process.env.QA_MOCK_MODE ?? 'runinfo';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const say = (text) => emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const post = async (p, body) => {
  try {
    await fetch(base + p, {
      method: 'POST',
      // x-qa-shim: the worker exports its per-boot token as QA_SHIM_TOKEN, same as real runs.
      headers: { 'content-type': 'application/json', 'x-qa-shim': process.env.QA_SHIM_TOKEN ?? '' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    say(`beacon failed: ${e.message}`);
  }
};

emit({ type: 'system', subtype: 'init', session_id: sessionId });
say(kind === 'resume' ? 'Resuming mock run…' : `Reading task envelope at ${envelopePath}…`);

const phases =
  mode === 'blocked'
    ? ['grounding', 'testing', 'implementing']
    : ['grounding', 'testing', 'implementing', 'verifying', 'pr'];
for (const phase of phases) {
  await post('/api/progress', { session_id: sessionId, phase });
  say(`phase: ${phase}`);
  await sleep(200);
}

if (mode === 'blocked') {
  // No worktree, no runinfo, no PR — stop with the sentinel dispatch.ts
  // detects (`Stopped at Step` / 🛑) so the run settles report `blocked`.
  say('Hit a gate that needs a human decision — stopping without creating a PR.');
  await sleep(200);
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result:
      '🛑 Stopped at Step 4 (implement gate): needs a human decision. Branch qa/selftest-mock-blocked, worktree not created — no PR opened.',
  });
} else {
  // The shim only accepts worktrees inside WORKTREE_BASE, so mint the fake one there.
  const worktreeBase = process.env.WORKTREE_BASE ?? os.tmpdir();
  fs.mkdirSync(worktreeBase, { recursive: true });
  const worktree = fs.mkdtempSync(path.join(worktreeBase, 'qa-selftest-wt-'));
  fs.mkdirSync(path.join(worktree, 'apps', 'web'), { recursive: true });

  await post('/api/runinfo', {
    session_id: sessionId,
    worktree,
    branch: 'qa/selftest-mock',
    pr_url: 'https://github.com/your-org/your-app/pull/9999',
    pr_number: 9999,
    test_plan: '1. Open the preview URL.\n2. Page shows "ok".\n✅ Success = page loads.',
    files_changed: [{ file: 'apps/web/mock.tsx', add: 1, del: 0 }],
    grounding: [{ label: 'mock: entry component -> mock handler', file: 'apps/web/mock.tsx' }],
  });

  say('PR opened, handing off.');
  await sleep(200);
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'PR ready: https://github.com/your-org/your-app/pull/9999',
  });
}
