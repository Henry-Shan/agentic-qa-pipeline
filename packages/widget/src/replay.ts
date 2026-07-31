// Replay engine — contracts §Replay (embedded preview on the task page).
// On a `qa-pipeline:replay` message the widget navigates to the report's route,
// glides a synthetic cursor through the click trail (pulsing each resolved
// target with a numbered caption chip), then holds a sustained highlight on the
// report's selector/elementText. Everything visual lives inside the widget's
// shadow-DOM overlay (pointer-events: none) — no DOM writes to the host page.

import type { ClickTrailEntry } from './types';

export interface ReplayRequest {
  route: string;
  trail: ClickTrailEntry[];
  selector?: string;
  elementText?: string;
}

export interface ReplayResult {
  /** steps animated */ shown: number;
  /** steps with click metadata that could not be resolved (or were cut by the time cap) */ skipped: number;
}

export interface ReplayHandle {
  /** Cancel mid-flight (used to restart when a second replay message arrives). */
  cancel(): void;
  /** Resolves with the tally, or null when the run was cancelled. */
  done: Promise<ReplayResult | null>;
}

export interface ReplayOptions {
  /** Element inside the widget's ShadowRoot that hosts the overlay. */
  container: HTMLElement;
  /** The widget's own host element — never a resolve target. */
  ignore?: Element;
  /** Override for tests; defaults to matchMedia('(prefers-reduced-motion: reduce)'). */
  reducedMotion?: boolean;
}

const STEP_MS = 1_200; // cadence between steps
const GLIDE_MS = 450; // cursor glide (matches the .qa-cursor CSS transition)
const SCROLL_SETTLE_MS = 250; // let scrollIntoView land before measuring
const CAPTION_MS = 900; // pulse + caption chip lifetime
const FINAL_MS = 4_000; // sustained highlight on the report's element
const TOTAL_CAP_MS = 20_000; // whole-replay budget
const NAV_TIMEOUT_MS = 1_500; // SPA must react to pushState within this window
const NAV_SETTLE_MS = 400; // post-route render settle

// ---------------------------------------------------------------------------
// Step resolver (pure DOM reads; unit-tested in test/replay.test.ts)
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'HEAD', 'BODY']);
const INTERACTIVE_SELECTOR =
  'button, a, [role="button"], [role="tab"], [role="link"], [role="menuitem"], ' +
  'input[type="button"], input[type="submit"], summary';

function esc(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/(["\\#.:[\]>+~*])/g, '\\$1');
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Best-effort visibility: hidden/aria-hidden ancestors and computed display/visibility. */
function isVisible(el: Element, ignore?: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return false;
  if (ignore && (el === ignore || ignore.contains(el))) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  } catch {
    /* jsdom edge — treat as visible */
  }
  return true;
}

function firstVisible(list: Iterable<Element>, ignore?: Element): Element | null {
  for (const el of list) if (isVisible(el, ignore)) return el;
  return null;
}

/**
 * Visible-text fallback: exact (whitespace-normalized, case-insensitive) before
 * contains, buttons/links/tabs before everything else, tightest text on ties.
 */
export function resolveByText(text: string, root: ParentNode = document, ignore?: Element): Element | null {
  const needle = normalize(text);
  if (!needle) return null;
  let exactAny: Element | null = null;
  let containsInteractive: Element | null = null;
  let containsInteractiveLen = Infinity;
  let containsAny: Element | null = null;
  let containsAnyLen = Infinity;
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!isVisible(el, ignore)) continue;
    const own = normalize(el.textContent ?? '');
    if (!own) continue;
    const interactive = el.matches(INTERACTIVE_SELECTOR);
    if (own === needle) {
      if (interactive) return el; // best possible match — take the first
      exactAny ??= el;
    } else if (own.includes(needle)) {
      if (interactive && own.length < containsInteractiveLen) {
        containsInteractive = el;
        containsInteractiveLen = own.length;
      } else if (!interactive && own.length < containsAnyLen) {
        containsAny = el;
        containsAnyLen = own.length;
      }
    }
  }
  return exactAny ?? containsInteractive ?? containsAny;
}

/** Resolve a trail step: data-testid → data-sentry-component/data-component → visible text. */
export function resolveStep(
  entry: Pick<ClickTrailEntry, 'testid' | 'component' | 'text'>,
  root: ParentNode = document,
  ignore?: Element,
): Element | null {
  if (entry.testid) {
    const el = firstVisible(root.querySelectorAll(`[data-testid="${esc(entry.testid)}"]`), ignore);
    if (el) return el;
  }
  if (entry.component) {
    for (const attr of ['data-sentry-component', 'data-component'] as const) {
      const el = firstVisible(root.querySelectorAll(`[${attr}="${esc(entry.component)}"]`), ignore);
      if (el) return el;
    }
  }
  if (entry.text) return resolveByText(entry.text, root, ignore);
  return null;
}

/** Trail entries with no click metadata are route markers, not replayable steps. */
function isStep(entry: ClickTrailEntry): boolean {
  return Boolean(entry.text ?? entry.testid ?? entry.component);
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

class Cancellation {
  cancelled = false;
  private waiters = new Set<{ id: number; resolve: () => void }>();

  sleep(ms: number): Promise<void> {
    if (this.cancelled || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { id: 0, resolve };
      waiter.id = window.setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, ms);
      this.waiters.add(waiter);
    });
  }

  cancel(): void {
    this.cancelled = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.id);
      waiter.resolve();
    }
    this.waiters.clear();
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Navigate SPA-style: pushState + a synthetic popstate. If the app's DOM does
 * not react within ~1.5s, hard-navigate via location.assign (state loss
 * acceptable — the page reload abandons this run).
 */
async function ensureRoute(route: string, c: Cancellation): Promise<void> {
  if (location.pathname === route) return;
  let mutated = false;
  const observer = new MutationObserver(() => {
    mutated = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    history.pushState(history.state, '', route);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  } catch {
    observer.disconnect();
    location.assign(route);
    await c.sleep(NAV_TIMEOUT_MS); // page is unloading — park until it does
    return;
  }
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (!mutated && !c.cancelled && Date.now() < deadline) await c.sleep(100);
  observer.disconnect();
  if (c.cancelled) return;
  if (!mutated) {
    location.assign(route);
    await c.sleep(NAV_TIMEOUT_MS);
    return;
  }
  await c.sleep(NAV_SETTLE_MS);
}

function stepLabel(entry: ClickTrailEntry): string {
  return entry.text ?? entry.testid ?? entry.component ?? 'element';
}

export function startReplay(req: ReplayRequest, opts: ReplayOptions): ReplayHandle {
  const c = new Cancellation();
  const instant = opts.reducedMotion ?? prefersReducedMotion();

  const overlay = document.createElement('div');
  overlay.className = `qa-replay${instant ? ' instant' : ''}`;
  const cursor = document.createElement('div');
  cursor.className = 'qa-cursor';
  // Start where the fab lives (bottom-right) so the glide reads as "the widget walks you through it".
  cursor.style.transform = `translate(${window.innerWidth - 46}px, ${window.innerHeight - 44}px)`;
  overlay.appendChild(cursor);
  opts.container.appendChild(overlay);

  function moveCursor(x: number, y: number): void {
    cursor.style.transform = `translate(${Math.round(x - 6)}px, ${Math.round(y - 6)}px)`;
  }

  function placeChip(chip: HTMLElement, rect: DOMRect): void {
    overlay.appendChild(chip);
    const width = chip.offsetWidth || 120;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = rect.top >= 42 ? rect.top - 34 : rect.bottom + 10;
    chip.style.left = `${Math.round(left)}px`;
    chip.style.top = `${Math.round(top)}px`;
  }

  function pulse(rect: DOMRect, index: number, entry: ClickTrailEntry): void {
    const box = document.createElement('div');
    box.className = 'qa-pulse';
    box.style.top = `${Math.round(rect.top - 3)}px`;
    box.style.left = `${Math.round(rect.left - 3)}px`;
    box.style.width = `${Math.round(rect.width + 6)}px`;
    box.style.height = `${Math.round(rect.height + 6)}px`;
    overlay.appendChild(box);
    const chip = document.createElement('div');
    chip.className = 'qa-step-chip';
    chip.textContent = `${index} · clicked ${stepLabel(entry)}`;
    placeChip(chip, rect);
    window.setTimeout(() => {
      box.remove();
      chip.remove();
    }, CAPTION_MS);
  }

  function targetRect(el: Element): DOMRect {
    try {
      el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
    } catch {
      /* jsdom / detached */
    }
    return el.getBoundingClientRect();
  }

  async function animateStep(el: Element, index: number, entry: ClickTrailEntry): Promise<void> {
    let rect = targetRect(el);
    if (!instant) {
      await c.sleep(SCROLL_SETTLE_MS);
      if (c.cancelled) return;
      rect = el.getBoundingClientRect(); // re-measure after the smooth scroll
      moveCursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
      await c.sleep(GLIDE_MS);
      if (c.cancelled) return;
      rect = el.getBoundingClientRect();
    }
    pulse(rect, index, entry);
    const spent = instant ? 0 : SCROLL_SETTLE_MS + GLIDE_MS;
    await c.sleep(STEP_MS - spent);
  }

  function finalTarget(): Element | null {
    if (req.selector) {
      try {
        const el = document.querySelector(req.selector);
        if (el && isVisible(el, opts.ignore)) return el;
      } catch {
        /* invalid selector — fall through to text */
      }
    }
    if (req.elementText) return resolveByText(req.elementText, document, opts.ignore);
    return null;
  }

  async function highlightFinal(): Promise<void> {
    const el = finalTarget();
    if (!el) return;
    let rect = targetRect(el);
    if (!instant) {
      await c.sleep(SCROLL_SETTLE_MS);
      if (c.cancelled) return;
      rect = el.getBoundingClientRect();
      moveCursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
      await c.sleep(GLIDE_MS);
      if (c.cancelled) return;
      rect = el.getBoundingClientRect();
    }
    const box = document.createElement('div');
    box.className = 'qa-final';
    box.style.top = `${Math.round(rect.top - 4)}px`;
    box.style.left = `${Math.round(rect.left - 4)}px`;
    box.style.width = `${Math.round(rect.width + 8)}px`;
    box.style.height = `${Math.round(rect.height + 8)}px`;
    overlay.appendChild(box);
    await c.sleep(FINAL_MS);
  }

  async function run(): Promise<ReplayResult | null> {
    await ensureRoute(req.route, c);
    if (c.cancelled) return null;
    const steps = req.trail.filter(isStep);
    const hasFinal = Boolean(req.selector ?? req.elementText);
    const stepBudget = TOTAL_CAP_MS - (hasFinal ? FINAL_MS : 0);
    const started = Date.now();
    let shown = 0;
    let skipped = 0;
    for (let i = 0; i < steps.length; i++) {
      if (c.cancelled) return null;
      if (Date.now() - started > stepBudget) {
        skipped += steps.length - i;
        break;
      }
      const entry = steps[i];
      if (!entry) continue;
      const el = resolveStep(entry, document, opts.ignore);
      if (!el || !el.isConnected) {
        skipped++;
        continue;
      }
      await animateStep(el, i + 1, entry);
      shown++;
    }
    if (c.cancelled) return null;
    await highlightFinal();
    return c.cancelled ? null : { shown, skipped };
  }

  const done = run()
    .catch(() => (c.cancelled ? null : { shown: 0, skipped: req.trail.filter(isStep).length }))
    .finally(() => overlay.remove());

  return { cancel: () => c.cancel(), done };
}
