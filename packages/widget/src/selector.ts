// Pure DOM-reading helpers: short unique CSS selectors + element metadata.

export interface ElementMeta {
  component?: string;
  sourceFile?: string;
  testid?: string;
  text?: string;
}

const TEXT_CHARS = 120;
const MAX_DEPTH = 5;

function esc(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/(["\\#.:[\]>+~*])/g, '\\$1');
}

function isUnique(selector: string, el: Element): boolean {
  try {
    const root = el.getRootNode() as Document | ShadowRoot;
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function part(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).find((c) => /^[a-zA-Z][\w-]*$/.test(c));
  let out = cls ? `${tag}.${esc(cls)}` : tag;
  const parent = el.parentElement;
  if (parent) {
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (sameTag.length > 1) out += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }
  return out;
}

/** Prefer data-testid, then id, then a tag.class:nth-of-type chain ≤5 deep. */
export function buildSelector(el: Element): string {
  const testid = el.getAttribute('data-testid');
  if (testid) {
    const sel = `[data-testid="${esc(testid)}"]`;
    if (isUnique(sel, el)) return sel;
  }
  if (el.id) {
    const sel = `#${esc(el.id)}`;
    if (isUnique(sel, el)) return sel;
  }
  // Prefer an ancestor-id anchor over a bare positional chain: keep walking up
  // looking for an id even after a bare chain becomes unique (kept as fallback).
  const parts: string[] = [];
  let fallback: string | null = null;
  let node: Element | null = el;
  while (node && parts.length < MAX_DEPTH) {
    if (node !== el && node.id) {
      const anchored = [`#${esc(node.id)}`, ...parts].join(' > ');
      if (isUnique(anchored, el)) return anchored;
    }
    parts.unshift(part(node));
    if (!fallback) {
      const sel = parts.join(' > ');
      if (isUnique(sel, el)) fallback = sel;
    }
    node = node.parentElement;
  }
  return fallback ?? parts.join(' > ');
}

// Build annotations come in two attribute families: the Sentry bundler plugin's
// data-sentry-component / data-sentry-source-file, and the host app's own build
// plugin's data-component / data-source-file. Read both — first non-empty wins,
// sentry-prefixed checked first on each ancestor.
const COMPONENT_ATTRS = ['data-sentry-component', 'data-component'] as const;
const SOURCE_FILE_ATTRS = ['data-sentry-source-file', 'data-source-file'] as const;

export interface Annotation {
  component?: string;
  sourceFile?: string;
}

function closestAttrValue(el: Element, attrs: readonly string[]): string | undefined {
  for (let node: Element | null = el; node; node = node.parentElement) {
    for (const attr of attrs) {
      const value = node.getAttribute(attr);
      if (value) return value;
    }
  }
  return undefined;
}

/** Component/source-file annotation from the closest annotated ancestor, either attribute family. */
export function annotationOf(el: Element): Annotation {
  const annotation: Annotation = {};
  const component = closestAttrValue(el, COMPONENT_ATTRS);
  if (component) annotation.component = component;
  const sourceFile = closestAttrValue(el, SOURCE_FILE_ATTRS);
  if (sourceFile) annotation.sourceFile = sourceFile;
  return annotation;
}

export function elementMeta(el: Element): ElementMeta {
  const meta: ElementMeta = { ...annotationOf(el) };
  const testid = el.closest('[data-testid]')?.getAttribute('data-testid');
  if (testid) meta.testid = testid;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_CHARS);
  if (text) meta.text = text;
  return meta;
}
