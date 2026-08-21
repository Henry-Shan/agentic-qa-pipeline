// Headless re-execution of a tester's recorded steps against a fix preview
// (contracts §Examination). Spawned by the worker with one JSON argument:
//
//   { playwrightPath, previewUrl, tokenHash, route, steps, outDir, viewport }
//
// It signs in through the preview's /qa-session hand-off (as the REPORTER, so
// role-dependent behavior reproduces), then executes each step the same way the
// in-browser replay engine does — resolution order testid → selector → text —
// capturing per-step evidence a model can read: a screenshot, the visible text
// after the step settled, and any console errors / failed requests in that
// step's window. Writes evidence.json + step-N.png into outDir.
//
// It never asserts anything. Judging is the examiner model's job.

import fs from 'node:fs';
import path from 'node:path';

const SETTLE_MS = 900; // let the DOM react before the screenshot
const STEP_TIMEOUT_MS = 8_000;
const NAV_TIMEOUT_MS = 20_000;
const TEXT_CAP = 1_800; // visible-text budget per step

const cfg = JSON.parse(process.argv[2] ?? '{}');
const {
  playwrightPath,
  previewUrl,
  tokenHash,
  route = '/',
  steps = [],
  outDir,
  viewport = { w: 1440, h: 900 },
} = cfg;

/** Full URL for a recorded route (which carries pathname + query + hash). */
function urlFor(r) {
  return new URL(r || '/', previewUrl).toString();
}

function label(step) {
  if (step.kind === 'input') {
    if (step.value === 'checked' || step.value === 'unchecked') {
      return `toggled ${step.text ?? step.testid ?? 'field'} · ${step.value}`;
    }
    const where = step.text ?? step.testid ?? step.component;
    const typed = `typed "${String(step.value ?? '').slice(0, 40)}"`;
    return where ? `${typed} · ${where}` : typed;
  }
  if (typeof step.text === 'string' && step.text.startsWith('pressed ')) return step.text;
  return `clicked ${step.text ?? step.testid ?? step.component ?? step.selector ?? '?'}`;
}

/** testid → selector → exact text → substring text. First visible match wins. */
async function resolve(page, step) {
  const tries = [];
  if (step.testid) tries.push(page.getByTestId(step.testid));
  if (step.selector) tries.push(page.locator(step.selector));
  const text = typeof step.text === 'string' && !step.text.startsWith('pressed ') ? step.text.trim() : '';
  if (text) {
    // For typing steps the recorded `text` is the FIELD'S label — so the label,
    // placeholder and aria name are the right things to match, not page copy.
    if (step.kind === 'input') {
      tries.push(page.getByLabel(text, { exact: false }));
      tries.push(page.getByPlaceholder(text, { exact: false }));
      tries.push(page.getByRole('textbox', { name: text }));
      const head = text.split(/[\s,.…]+/).filter((w) => w.length > 3)[0];
      if (head) tries.push(page.getByPlaceholder(head, { exact: false }));
    }
    tries.push(page.getByRole('button', { name: text, exact: true }));
    tries.push(page.getByText(text, { exact: true }));
    if (text.length > 6) tries.push(page.getByText(text.slice(0, 40), { exact: false }));
  }
  for (const locator of tries) {
    try {
      const first = locator.first();
      if (await first.isVisible({ timeout: 700 })) return first;
    } catch {
      // not present / not visible / bad selector — try the next strategy
    }
  }
  return null;
}

async function main() {
  // playwright is CJS: a dynamic import puts its exports under `default`.
  const mod = await import(path.join(playwrightPath, 'index.js'));
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error(`playwright chromium not found at ${playwrightPath}`);
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: viewport.w || 1440, height: viewport.h || 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // Per-step diagnostic windows: cleared after each step is recorded.
  let consoleErrors = [];
  let failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${String(err).slice(0, 300)}`));
  page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url().slice(0, 200)}`));
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url().slice(0, 200)}`);
  });

  const evidence = { signedIn: false, startedOnRoute: false, steps: [], shown: 0, skipped: 0, fatal: null };
  const shot = async (name) => {
    const file = path.join(outDir, name);
    try {
      await page.screenshot({ path: file, fullPage: false });
      return name;
    } catch {
      return null;
    }
  };
  // Only text the user could actually SEE: `body.innerText` also returns closed
  // drawers and off-screen panels that are still mounted, which would tell the
  // examiner it is looking at a screen the screenshot does not show.
  const visibleText = async () => {
    try {
      const text = await page.evaluate(() => {
        const seen = [];
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        for (const el of Array.from(document.body.querySelectorAll('*'))) {
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
          for (const node of Array.from(el.childNodes)) {
            if (node.nodeType !== 3) continue; // text nodes only — no duplication from ancestors
            const value = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
            if (value) seen.push(value);
          }
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.value) seen.push(`[${el.getAttribute('placeholder') ?? 'field'}=${el.value}]`);
          }
        }
        return seen.join(' · ');
      });
      return text.slice(0, TEXT_CAP);
    } catch {
      return '';
    }
  };

  try {
    // 1. Sign in as the reporter via the preview's one-time token hand-off.
    const entry = tokenHash
      ? `${previewUrl.replace(/\/$/, '')}/qa-session#token_hash=${encodeURIComponent(tokenHash)}&next=${encodeURIComponent(route)}`
      : urlFor(route);
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(2_500); // verifyOtp + redirect into the app
    if (!/\/qa-session|\/login/.test(new URL(page.url()).pathname)) evidence.signedIn = true;

    // Land on the recorded starting route and STAY there: the app runs its own
    // post-login redirect, which can land after a one-shot goto and silently
    // start the examination on the wrong screen. Navigate, settle, verify.
    const want = new URL(urlFor(route)).pathname;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (new URL(page.url()).pathname === want) break;
      await page.goto(urlFor(route), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(1_500);
    }
    evidence.startedOnRoute = new URL(page.url()).pathname === want;
    await page.waitForTimeout(SETTLE_MS);
    evidence.startShot = await shot('step-0-start.png');
    evidence.startText = await visibleText();
    consoleErrors = [];
    failedRequests = [];

    // 2. Execute the recorded steps in order.
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const record = { i: i + 1, label: label(step), route: step.route ?? null, status: 'done' };

      // Follow the tester's path: re-align when the step happened elsewhere.
      try {
        if (step.route && new URL(page.url()).pathname !== new URL(urlFor(step.route)).pathname) {
          await page.goto(urlFor(step.route), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          await page.waitForTimeout(SETTLE_MS);
        }
      } catch {
        // navigation raced with an in-app redirect — continue from where we are
      }

      const key = typeof step.text === 'string' && step.text.startsWith('pressed ') ? step.text.slice(8) : null;
      const target = await resolve(page, step);

      if (!target && !key) {
        record.status = 'skipped';
        record.why = 'element not found on the fixed build';
        evidence.skipped++;
      } else {
        try {
          if (key) {
            if (target) await target.focus({ timeout: STEP_TIMEOUT_MS }).catch(() => {});
            await page.keyboard.press(key === 'Escape' ? 'Escape' : key === 'Tab' ? 'Tab' : 'Enter');
          } else if (step.kind === 'input' && (step.value === 'checked' || step.value === 'unchecked')) {
            const want = step.value === 'checked';
            if ((await target.isChecked().catch(() => null)) !== want) {
              await target.click({ timeout: STEP_TIMEOUT_MS });
            }
          } else if (step.kind === 'input') {
            const tag = await target.evaluate((el) => el.tagName).catch(() => '');
            if (tag === 'SELECT') {
              await target.selectOption({ label: String(step.value ?? '') }).catch(async () => {
                await target.selectOption(String(step.value ?? ''));
              });
            } else {
              await target.fill(String(step.value ?? ''), { timeout: STEP_TIMEOUT_MS });
            }
          } else {
            await target.click({ timeout: STEP_TIMEOUT_MS });
          }
          evidence.shown++;
        } catch (e) {
          record.status = 'failed';
          record.why = String(e?.message ?? e).slice(0, 200);
          evidence.skipped++;
        }
      }

      await page.waitForTimeout(SETTLE_MS);
      record.shot = await shot(`step-${i + 1}.png`);
      record.text = await visibleText();
      record.consoleErrors = consoleErrors.slice(0, 5);
      record.failedRequests = failedRequests.slice(0, 5);
      consoleErrors = [];
      failedRequests = [];
      evidence.steps.push(record);
    }

    // 3. The closing frame — the outcome of the last action.
    await page.waitForTimeout(SETTLE_MS);
    evidence.finalShot = await shot('step-final.png');
    evidence.finalText = await visibleText();
  } catch (e) {
    evidence.fatal = String(e?.message ?? e).slice(0, 400);
    evidence.fatalShot = await shot('fatal.png');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({ shown: evidence.shown, skipped: evidence.skipped, fatal: evidence.fatal }));
}

main().catch((e) => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'evidence.json'),
    JSON.stringify({ fatal: String(e?.message ?? e), steps: [], shown: 0, skipped: 0 }, null, 2),
  );
  process.stdout.write(JSON.stringify({ shown: 0, skipped: 0, fatal: String(e?.message ?? e) }));
  process.exit(0); // the worker reads evidence.json; a crash is an inconclusive exam, not a worker error
});
