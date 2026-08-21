// Replay engine — contracts §Replay (embedded preview on the task page).
// On a `qa-pipeline:replay` message the widget navigates to the report's route,
// then EXECUTES the recorded procedure in order: click steps glide a synthetic
// cursor, pulse the target, then fire a REAL element.click() (so navigation and
// dialogs actually happen, with a MutationObserver settle wait after); input
// steps focus the field and type the recorded value character-by-character via
// the native value setter + dispatched input/change events, so React-controlled
// fields update. Total-recall step shapes execute too: select input-steps set
// the select's value by matching the recorded option LABEL (native setter +
// change); checkbox/radio steps ('checked'/'unchecked') real-click only when
// the current state differs; 'pressed Enter' steps dispatch keydown/keyup
// Enter on the resolved field; contenteditable steps land textContent + input.
// It finishes with a sustained highlight on the report's selector/elementText.
// All visuals live inside the widget's shadow-DOM overlay
// (pointer-events: none); the only host-page writes are the executed steps.

import { isVisible, resolveByText, resolveStep } from './resolve';
import { stepKind, stepLabel } from './trail-list';
import type { ClickTrailEntry, StepMark } from './types';

// The resolution order lives in ./resolve (shared with the drawer's keyframe
// player, which resolves the same steps inside the replayed iframe).
export { resolveByText, resolveStep } from './resolve';

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
  /**
   * Step-marker sink for the dedicated "after the fix" recorder (contract
   * §Session replay): called with `{i, kind, label}` immediately before each
   * resolved step executes, so the recording carries its own step index. `i` is
   * the 1-based index of the step being executed — the same number the on-screen
   * caption shows.
   */
  onStep?: (mark: StepMark) => void;
}

const STEP_MS = 1_200; // cadence between steps
const GLIDE_MS = 450; // cursor glide (matches the .qa-cursor CSS transition)
const SCROLL_SETTLE_MS = 250; // let scrollIntoView land before measuring
const CAPTION_MS = 900; // pulse + caption chip lifetime
const FINAL_MS = 4_000; // sustained highlight on the report's element
const TOTAL_CAP_MS = 90_000; // whole-replay budget (real clicks + typing + honored pauses)
const MAX_GAP_MS = 3_000; // most of a recorded pause to honor beyond STEP_MS
const NAV_TIMEOUT_MS = 1_500; // SPA must react to pushState within this window
const NAV_SETTLE_MS = 400; // post-route render settle
const CLICK_BEAT_MS = 150; // pulse lands, THEN the real click fires
const SETTLE_MAX_MS = 600; // post-click DOM settle budget
const SETTLE_QUIET_MS = 220; // mutations quiet for this long = settled early
const SETTLE_POLL_MS = 60;
const TYPE_CHAR_MS = 30; // typing cadence
const TYPE_DISPLAY_CAP = 40; // chars typed one-by-one; the rest lands in one set

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

function isToggleField(field: FieldEl | null): field is HTMLInputElement {
  if (!(field instanceof HTMLInputElement)) return false;
  const type = field.type.toLowerCase();
  return type === 'checkbox' || type === 'radio';
}

/** Contenteditable editing host of the resolved element (attribute-based so jsdom agrees with browsers). */
function editableOf(el: Element): HTMLElement | null {
  const host = el.closest('[contenteditable]');
  if (!(host instanceof HTMLElement)) return null;
  const mode = (host.getAttribute('contenteditable') ?? '').toLowerCase();
  return mode === '' || mode === 'true' || mode === 'plaintext-only' ? host : null;
}

/** Match the recorded label back to an option: exact label → case-insensitive → clamped-prefix → wire value. */
function matchOption(select: HTMLSelectElement, recorded: string): HTMLOptionElement | null {
  const needle = recorded.replace(/\s+/g, ' ').trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  let caseInsensitive: HTMLOptionElement | null = null;
  let prefix: HTMLOptionElement | null = null;
  let byValue: HTMLOptionElement | null = null;
  for (const opt of Array.from(select.options)) {
    const label = (opt.label || opt.text || '').replace(/\s+/g, ' ').trim();
    if (label === needle) return opt;
    const labelLower = label.toLowerCase();
    if (!caseInsensitive && labelLower === lower) caseInsensitive = opt;
    if (!prefix && labelLower.startsWith(lower)) prefix = opt; // recorded labels are clamped to 120 chars
    if (!byValue && opt.value === needle) byValue = opt; // legacy trails recorded el.value
  }
  return caseInsensitive ?? prefix ?? byValue;
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
  // Compare the FULL route — query and hash carry real app state (selected
  // sheet, filters, open entry), so `/inventory?sheet=a` and `/inventory` are
  // different screens and must not be treated as "already there".
  if (`${location.pathname}${location.search}${location.hash}` === route) return;
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

/** Short name for the on-screen caption chip ("3 · clicked Save"). */
function captionName(entry: ClickTrailEntry): string {
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
    pulse(rect, `${index} · clicked ${captionName(entry)}`, CAPTION_MS);
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

  /** Select step: match the recorded option LABEL, set the value via the native setter, dispatch input+change. */
  async function runSelectStep(field: HTMLSelectElement, index: number, entry: ClickTrailEntry): Promise<void> {
    const rect = await glideTo(field);
    if (c.cancelled) return;
    const recorded = entry.value ?? '';
    pulse(rect, `${index} · selected "${clip(recorded, TYPE_DISPLAY_CAP)}"`, CAPTION_MS);
    try {
      field.focus();
    } catch {
      /* non-focusable — the set still works */
    }
    const option = matchOption(field, recorded);
    setNativeValue(field, option ? option.value : recorded);
    fire(field, 'input');
    fire(field, 'change');
    const spent = instant ? 0 : SCROLL_SETTLE_MS + GLIDE_MS;
    await c.sleep(STEP_MS - spent);
  }

  /** Toggle step: REAL click only when the recorded 'checked'/'unchecked' state differs from the current one. */
  async function runToggleStep(field: HTMLInputElement, index: number, entry: ClickTrailEntry): Promise<void> {
    const rect = await glideTo(field);
    if (c.cancelled) return;
    const desired = entry.value === 'checked';
    pulse(rect, `${index} · toggled ${captionName(entry)}`, CAPTION_MS);
    await c.sleep(CLICK_BEAT_MS);
    if (c.cancelled) return;
    if (field.checked !== desired) {
      try {
        field.click(); // real click — change events and app handlers actually fire
      } catch {
        /* handler threw — the replay carries on */
      }
      await settleAfterClick();
    }
    const spent = (instant ? 0 : SCROLL_SETTLE_MS + GLIDE_MS) + CLICK_BEAT_MS;
    await c.sleep(STEP_MS - spent);
  }

  /** Key step ('pressed Enter' / 'Escape' / 'Tab'): dispatch keydown+keyup on the resolved field. */
  async function runEnterStep(el: Element, index: number, key = 'Enter'): Promise<void> {
    const rect = await glideTo(el);
    if (c.cancelled) return;
    pulse(rect, `${index} · pressed ${key}`, CAPTION_MS);
    await c.sleep(CLICK_BEAT_MS);
    if (c.cancelled) return;
    const target: Element = fieldOf(el) ?? el;
    if (target instanceof HTMLElement) {
      try {
        target.focus();
      } catch {
        /* non-focusable */
      }
    }
    for (const type of ['keydown', 'keyup'] as const) {
      let event: Event;
      try {
        event = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true });
      } catch {
        event = new Event(type, { bubbles: true, cancelable: true });
      }
      target.dispatchEvent(event);
    }
    await settleAfterClick();
    const spent = (instant ? 0 : SCROLL_SETTLE_MS + GLIDE_MS) + CLICK_BEAT_MS;
    await c.sleep(STEP_MS - spent);
  }

  /** Contenteditable step: land the recorded text in one set + input event. */
  async function runEditableStep(host: HTMLElement, index: number, entry: ClickTrailEntry): Promise<void> {
    const rect = await glideTo(host);
    if (c.cancelled) return;
    const value = entry.value ?? '';
    pulse(rect, `${index} · typed "${clip(value, TYPE_DISPLAY_CAP)}"`, CAPTION_MS);
    try {
      host.focus();
    } catch {
      /* non-focusable */
    }
    host.textContent = value;
    fire(host, 'input');
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
      // Honor the tester's OWN pacing: a deliberate pause before a step is part
      // of what they did (a screen finished loading, they read a value). Each
      // step already takes ~STEP_MS to execute, so only the REMAINDER of the
      // recorded gap is added, capped so a thinking pause can't eat the budget.
      const prev = i > 0 ? steps[i - 1] : null;
      const thisTs = steps[i]?.ts;
      if (prev && typeof prev.ts === 'number' && typeof thisTs === 'number') {
        const extra = thisTs - prev.ts - STEP_MS;
        if (Number.isFinite(extra) && extra > 0) {
          await c.sleep(Math.min(extra, MAX_GAP_MS));
          if (c.cancelled) return null;
        }
      }
      const entry = steps[i];
      if (!entry) continue;
      // Follow the tester's actual path: each step records the route it was
      // performed on, so if a click didn't navigate where it used to (or the
      // tester used the back button), re-align BEFORE resolving. Steps that
      // navigate on their own are already there and this is a no-op.
      if (entry.route) {
        await ensureRoute(entry.route, c);
        if (c.cancelled) return null;
      }
      // Each resolve runs against the CURRENT document, wherever we are now.
      const el = resolveStep(entry, document, opts.ignore);
      if (!el || !el.isConnected) {
        skipped++;
        continue;
      }
      // Step marker into the "after the fix" recording — emitted from here
      // because the engine is the only place that knows which step is running.
      // A sink must never break the replay.
      if (opts.onStep) {
        try {
          opts.onStep({ i: i + 1, kind: stepKind(entry), label: stepLabel(entry) });
        } catch {
          /* the recording just misses this marker */
        }
      }
      if (entry.kind === 'input') {
        const field = fieldOf(el);
        if (field instanceof HTMLSelectElement) {
          await runSelectStep(field, i + 1, entry);
        } else if (isToggleField(field) && (entry.value === 'checked' || entry.value === 'unchecked')) {
          await runToggleStep(field, i + 1, entry);
        } else if (field) {
          await runInputStep(field, i + 1, entry);
        } else {
          const editable = editableOf(el);
          if (!editable) {
            skipped++;
            continue;
          }
          await runEditableStep(editable, i + 1, entry);
        }
      } else if (entry.text === 'pressed Enter') {
        await runEnterStep(el, i + 1, 'Enter');
      } else if (entry.text === 'pressed Escape' || entry.text === 'pressed Tab') {
        await runEnterStep(el, i + 1, entry.text.slice('pressed '.length));
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
