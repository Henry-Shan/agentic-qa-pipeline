// Shared step resolver — pure DOM reads, no side effects.
//
// One resolution order for every consumer (contracts §Replay, §Session replay
// "Player UX"): selector → data-testid → data-sentry-component/data-component →
// visible text. The live replay engine (src/replay.ts) runs it against the HOST
// document; the drawer's keyframe player runs it against the REPLAYED iframe's
// document to place its synthetic cursor. Both must agree, so they share this.
//
// Every read is defensive: a foreign document (the replay iframe) may have no
// defaultView, a selector may be stale or invalid, styles may be unavailable.
// Nothing here throws.

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'HEAD', 'BODY']);
const INTERACTIVE_SELECTOR =
  'button, a, [role="button"], [role="tab"], [role="link"], [role="menuitem"], ' +
  'input[type="button"], input[type="submit"], summary';

/** The subset of a trail entry the resolver reads. */
export interface ResolvableStep {
  selector?: string;
  testid?: string;
  component?: string;
  text?: string;
}

function esc(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/(["\\#.:[\]>+~*])/g, '\\$1');
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Computed style from the element's OWN view — elements inside the replay iframe belong to another window. */
function styleOf(el: Element): CSSStyleDeclaration | null {
  try {
    const view = el.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    return view ? view.getComputedStyle(el) : null;
  } catch {
    return null; // jsdom edge / detached node — treat as visible
  }
}

/** Best-effort visibility: hidden/aria-hidden ancestors and computed display/visibility. */
export function isVisible(el: Element, ignore?: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return false;
  if (ignore && (el === ignore || ignore.contains(el))) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = styleOf(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
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
  entry: ResolvableStep,
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
