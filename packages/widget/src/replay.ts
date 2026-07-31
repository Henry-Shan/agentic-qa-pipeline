// Replay engine — contracts §Replay (embedded preview on the task page).
// On a `qa-pipeline:replay` message the widget navigates to the report's route,
// then EXECUTES the recorded procedure in order: click steps glide a synthetic
// cursor, pulse the target, then fire a REAL element.click() (so navigation and
// dialogs actually happen, with a MutationObserver settle wait after); input
// steps focus the field and type the recorded value character-by-character via
// the native value setter + dispatched input/change events, so React-controlled
// fields update. It finishes with a sustained highlight on the report's
// selector/elementText. All visuals live inside the widget's shadow-DOM overlay
// (pointer-events: none); the only host-page writes are the executed steps.

import type { ClickTrailEntry } from './types';

export interface ReplayRequest {
  route: string;
  trail: ClickTrailEntry[];
  selector?: string;
  elementText?: string;
}

export interface ReplayResult {
  /** steps executed */ shown: number;
  /** steps with metadata that could not be resolved/executed (or were cut by the time cap) */ skipped: number;
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
const TOTAL_CAP_MS = 45_000; // whole-replay budget (real clicks + typing take time)
const NAV_TIMEOUT_MS = 1_500; // SPA must react to pushState within this window
const NAV_SETTLE_MS = 400; // post-route render settle
const CLICK_BEAT_MS = 150; // pulse lands, THEN the real click fires
const SETTLE_MAX_MS = 600; // post-click DOM settle budget
const SETTLE_QUIET_MS = 220; // mutations quiet for this long = settled early
const SETTLE_POLL_MS = 60;
const TYPE_CHAR_MS = 30; // typing cadence
const TYPE_DISPLAY_CAP = 40; // chars typed one-by-one; the rest lands in one set

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

/** Resolve a trail step: selector → data-testid → data-sentry-component/data-component → visible text. */
export function resolveStep(
  entry: Pick<ClickTrailEntry, 'selector' | 'testid' | 'component' | 'text'>,
  root: ParentNode = document,
  ignore?: Element,
): Element | null {
  if (entry.selector) {
    try {
      const el = firstVisible(root.querySelectorAll(entry.selector), ignore);
      if (el) return el;
    } catch {
      /* invalid/stale selector — fall through */
    }
  }
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

/** Trail entries with no step metadata are route markers, not replayable steps. */
function isStep(entry: ClickTrailEntry): boolean {
  return Boolean(entry.selector ?? entry.text ?? entry.testid ?? entry.component);
}

// ---------------------------------------------------------------------------
// Input-step plumbing (React-safe value writes)
// ---------------------------------------------------------------------------

type FieldEl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** The resolved element itself when it is a field, else the first field inside it. */
function fieldOf(el: Element): FieldEl | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return el;
  }
  const inner = el.querySelector('input, textarea, select');
  if (
    inner instanceof HTMLInputElement ||
    inner instanceof HTMLTextAreaElement ||
    inner instanceof HTMLSelectElement
  ) {
    return inner;
  }
  return null;
}

/**
 * Write via the PROTOTYPE value setter so instance-level trackers (React's
 * controlled-input plumbing) are bypassed — the dispatched 'input' event then
 * makes React pick the new value up as user input.
 */
function setNativeValue(field: FieldEl, value: string): void {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : field instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(field, value);
  else field.value = value;
}

function fire(field: Element, type: 'input' | 'change'): void {
  let event: Event;
  try {
    event = type === 'input' && typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true })
      : new Event(type, { bubbles: true });
  } catch {
    event = new Event(type, { bubbles: true });
  }
  field.dispatchEvent(event);
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

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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

  function pulse(rect: DOMRect, caption: string, lifetime: number): void {
    const box = document.createElement('div');
    box.className = 'qa-pulse';
    box.style.top = `${Math.round(rect.top - 3)}px`;
    box.style.left = `${Math.round(rect.left - 3)}px`;
    box.style.width = `${Math.round(rect.width + 6)}px`;
    box.style.height = `${Math.round(rect.height + 6)}px`;
    overlay.appendChild(box);
    const chip = document.createElement('div');
    chip.className = 'qa-step-chip';
    chip.textContent = caption;
    placeChip(chip, rect);
    window.setTimeout(() => {
      box.remove();
      chip.remove();
    }, lifetime);
  }

  function targetRect(el: Element): DOMRect {
    try {
      el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
    } catch {
      /* jsdom / detached */
    }
    return el.getBoundingClientRect();
  }

  /** Scroll to + glide the cursor onto the element; returns the settled rect. */
  async function glideTo(el: Element): Promise<DOMRect> {
    let rect = targetRect(el);
    if (!instant) {
      await c.sleep(SCROLL_SETTLE_MS);
      if (c.cancelled) return rect;
      rect = el.getBoundingClientRect(); // re-measure after the smooth scroll
      moveCursor(rect.left + rect.width / 2, rect.top + rect.height / 2);
      await c.sleep(GLIDE_MS);
      if (c.cancelled) return rect;
      rect = el.getBoundingClientRect();
    }
    return rect;
  }

  /** Post-click settle: wait for MutationObserver quiet (≤600ms) so the DOM the next step resolves against is real. */
  async function settleAfterClick(): Promise<void> {
    const target = document.body ?? document.documentElement;
    let lastMutation = 0;
    let sawMutation = false;
    const observer = new MutationObserver(() => {
      sawMutation = true;
      lastMutation = Date.now();
    });
    try {
      observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
    } catch {
      await c.sleep(SETTLE_MAX_MS);
      return;
    }
    const deadline = Date.now() + SETTLE_MAX_MS;
    while (!c.cancelled && Date.now() < deadline) {
      if (sawMutation && Date.now() - lastMutation >= SETTLE_QUIET_MS) break;
      await c.sleep(SETTLE_POLL_MS);
    }
    observer.disconnect();
  }

  /** Click step: glide → pulse → beat → REAL click → DOM settle. Navigation is tolerated. */
  async function runClickStep(el: Element, index: number, entry: ClickTrailEntry): Promise<void> {
    const rect = await glideTo(el);
    if (c.cancelled) return;
    pulse(rect, `${index} · clicked ${stepLabel(entry)}`, CAPTION_MS);
    await c.sleep(CLICK_BEAT_MS);
    if (c.cancelled) return;
    try {
      if (el instanceof HTMLElement) el.click();
      else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch {
      /* handler threw — the replay carries on */
    }
    await settleAfterClick();
    const spent = (instant ? 0 : SCROLL_SETTLE_MS + GLIDE_MS) + CLICK_BEAT_MS;
    await c.sleep(STEP_MS - spent);
  }

  /** Input step: glide → focus → type char-by-char (display-capped) → full value + change. */
  async function runInputStep(field: FieldEl, index: number, entry: ClickTrailEntry): Promise<void> {
    const rect = await glideTo(field);
    if (c.cancelled) return;
    const value = entry.value ?? '';
    const shown = value.slice(0, TYPE_DISPLAY_CAP);
    const typeMs = instant || field instanceof HTMLSelectElement ? 0 : shown.length * TYPE_CHAR_MS;
    pulse(rect, `${index} · typed "${clip(value, TYPE_DISPLAY_CAP)}"`, typeMs + CAPTION_MS);
    try {
      field.focus();
    } catch {
      /* non-focusable — typing still works */
    }
    if (typeMs === 0) {
      setNativeValue(field, value);
      fire(field, 'input');
    } else {
      for (let i = 1; i <= shown.length; i++) {
        if (c.cancelled) return;
        setNativeValue(field, shown.slice(0, i));
        fire(field, 'input');
        await c.sleep(TYPE_CHAR_MS);
      }
      if (c.cancelled) return;
      if (value.length > shown.length) {
        setNativeValue(field, value); // display cap reached — land the full value at once
        fire(field, 'input');
      }
    }
    fire(field, 'change');
    const spent = (instant ? 0 : SCROLL_SETTLE_MS + GLIDE_MS) + typeMs;
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
    const rect = await glideTo(el);
    if (c.cancelled) return;
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
      // Steps may have navigated the SPA (a real click's pushState) — each
      // resolve runs against the CURRENT document, wherever we are now.
      const el = resolveStep(entry, document, opts.ignore);
      if (!el || !el.isConnected) {
        skipped++;
        continue;
      }
      if (entry.kind === 'input') {
        const field = fieldOf(el);
        if (!field) {
          skipped++;
          continue;
        }
        await runInputStep(field, i + 1, entry);
      } else {
        await runClickStep(el, i + 1, entry);
      }
      if (c.cancelled) return null;
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
