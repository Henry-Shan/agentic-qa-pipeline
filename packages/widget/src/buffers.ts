// Rolling capture buffers, armed from page load: console, network, click trail,
// route changes. Headers are NEVER read into storage; URLs and bodies are scrubbed.
// TOTAL-RECALL (contracts §IngestBody clickTrail): all interaction listeners are
// WINDOW-level capture-phase — the capture phase visits window before any app
// listener, so stopPropagation in the app can never hide an interaction.

import { scrubString } from './scrub';
import { annotationOf, buildSelector } from './selector';
import type { ClickTrailEntry, ConsoleEntry, NetworkEntry } from './types';

const CONSOLE_MAX = 50;
const CONSOLE_CHARS = 500;
const NETWORK_MAX = 40;
const SNIPPET_CHARS = 2000;
// Trail ring only — console/network rings are unchanged (contract TOTAL-RECALL).
const TRAIL_MAX = 200;
const CLICK_TEXT_CHARS = 40;
const INPUT_VALUE_CHARS = 120;
const FIELD_LABEL_CHARS = 40;
// 'change' is the primary input-step trigger; the debounced 'input' fallback
// covers fields whose frameworks clear/re-render the value on change.
const INPUT_DEBOUNCE_MS = 700;

// HARD PRIVACY RULE — fields whose autocomplete matches this are never recorded.
const SENSITIVE_AUTOCOMPLETE_RE = /password|cc-|card|otp/i;
// Non-text input types: clicks already cover them, values are not "typing".
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'file',
  'hidden',
  'image',
  'radio',
  'reset',
  'submit',
]);

class Ring<T> {
  private items: T[] = [];
  constructor(private readonly cap: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.shift();
  }
  list(): T[] {
    return this.items.slice();
  }
}

export interface Buffers {
  consoleLog(): ConsoleEntry[];
  networkLog(): NetworkEntry[];
  clickTrail(): ClickTrailEntry[];
  /** fetch as it was before patching — the widget's own requests bypass capture */
  rawFetch: typeof fetch;
  /** clicks inside this element (the widget's own UI) are not recorded */
  setIgnoreRoot(el: Element | null): void;
  dispose(): void;
}

interface XhrMeta {
  method: string;
  url: string;
  capturable: boolean;
  started: number;
}
type XhrWithMeta = XMLHttpRequest & { __qaPipeline?: XhrMeta };

type FieldEl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Recordable text-entry field, or null. type=password is rejected HERE — its value never transits. */
function asField(target: EventTarget | null): FieldEl | null {
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    if (type === 'password' || NON_TEXT_INPUT_TYPES.has(type)) return null;
    return target;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return target;
  return null;
}

function isSensitiveField(el: FieldEl): boolean {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') return true;
  return SENSITIVE_AUTOCOMPLETE_RE.test(el.getAttribute('autocomplete') ?? '');
}

/** Checkbox/radio input, or null — toggles record as kind:'input' with value 'checked'/'unchecked'. */
function asToggle(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement)) return null;
  const type = target.type.toLowerCase();
  return type === 'checkbox' || type === 'radio' ? target : null;
}

/** Field an Enter press records for. type=password rejected HERE; autocomplete checked at the call site. */
function asEnterField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLInputElement) {
    return target.type.toLowerCase() === 'password' ? null : target;
  }
  return target instanceof HTMLTextAreaElement ? target : null;
}

/** The contenteditable editing host of the event target, or null. Attribute-based so jsdom agrees with browsers. */
function editableHost(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return null;
  }
  const host = target.closest('[contenteditable]');
  if (!(host instanceof HTMLElement)) return null;
  const mode = (host.getAttribute('contenteditable') ?? '').toLowerCase();
  return mode === '' || mode === 'true' || mode === 'plaintext-only' ? host : null;
}

/** The chosen option's LABEL(s) — what the tester saw, not the wire value. */
function selectedLabel(el: HTMLSelectElement): string {
  const labels = Array.from(el.selectedOptions).map((o) =>
    (o.label || o.text || o.value).replace(/\s+/g, ' ').trim(),
  );
  return labels.filter(Boolean).join(', ');
}

/** Human name for the field: <label> → aria-label → placeholder, ≤40 chars. */
function fieldLabel(el: Element): string | undefined {
  let raw = '';
  const labels = 'labels' in el ? (el as HTMLInputElement).labels : null;
  if (labels && labels.length > 0) raw = labels[0]?.textContent ?? '';
  if (!raw.trim()) raw = el.closest('label')?.textContent ?? '';
  if (!raw.trim()) raw = el.getAttribute('aria-label') ?? '';
  if (!raw.trim()) raw = el.getAttribute('placeholder') ?? '';
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, FIELD_LABEL_CHARS);
  return text || undefined;
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Same-origin request whose path has an /api segment — the only calls whose bodies we snippet. */
function resolveUrl(raw: string): { scrubbed: string; capturable: boolean } {
  try {
    const u = new URL(raw, location.href);
    const capturable = u.origin === location.origin && /(^|\/)api(\/|$)/.test(u.pathname);
    return { scrubbed: scrubString(u.href), capturable };
  } catch {
    return { scrubbed: scrubString(raw), capturable: false };
  }
}

export function startBuffers(): Buffers {
  const consoles = new Ring<ConsoleEntry>(CONSOLE_MAX);
  const network = new Ring<NetworkEntry>(NETWORK_MAX);
  const trail = new Ring<ClickTrailEntry>(TRAIL_MAX);
  let ignoreRoot: Element | null = null;
  const disposers: Array<() => void> = [];

  const pushConsole = (level: 'error' | 'warn', parts: unknown[]): void => {
    const text = scrubString(parts.map(formatArg).join(' ')).slice(0, CONSOLE_CHARS);
    consoles.push({ ts: Date.now(), level, text });
  };

  // --- console -------------------------------------------------------------
  for (const level of ['error', 'warn'] as const) {
    const previous = console[level];
    const original = previous.bind(console);
    console[level] = (...args: unknown[]): void => {
      pushConsole(level, args);
      original(...args);
    };
    disposers.push(() => {
      console[level] = previous;
    });
  }

  const onError = (e: ErrorEvent): void => {
    const where = e.filename ? ` (${e.filename}:${e.lineno})` : '';
    pushConsole('error', [`${e.message}${where}`]);
  };
  window.addEventListener('error', onError);
  disposers.push(() => window.removeEventListener('error', onError));

  const onRejection = (e: PromiseRejectionEvent): void => {
    pushConsole('error', [`Unhandled rejection: ${formatArg(e.reason)}`]);
  };
  window.addEventListener('unhandledrejection', onRejection);
  disposers.push(() => window.removeEventListener('unhandledrejection', onRejection));

  // --- fetch ---------------------------------------------------------------
  const attachSnippet = (entry: NetworkEntry, res: Response): void => {
    let clone: Response;
    try {
      clone = res.clone();
    } catch {
      return;
    }
    clone.text().then(
      (text) => {
        if (entry.status < 200 || entry.status >= 300) {
          entry.bodySnippet = scrubString(text).slice(0, SNIPPET_CHARS);
        } else if (entry.status === 200 && text.trim() === '') {
          entry.bodySnippet = ''; // explicit marker: the 200 came back with no body
        }
      },
      () => undefined,
    );
  };

  const prevFetch = window.fetch;
  const nativeFetch: typeof fetch = prevFetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const started = performance.now();
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const { scrubbed, capturable } = resolveUrl(rawUrl);
    return nativeFetch(input, init).then(
      (res) => {
        const entry: NetworkEntry = {
          ts: Date.now(),
          method,
          url: scrubbed,
          status: res.status,
          ms: Math.round(performance.now() - started),
        };
        network.push(entry);
        if (capturable) attachSnippet(entry, res);
        return res;
      },
      (err: unknown) => {
        network.push({
          ts: Date.now(),
          method,
          url: scrubbed,
          status: 0,
          ms: Math.round(performance.now() - started),
        });
        throw err;
      },
    );
  };
  disposers.push(() => {
    window.fetch = prevFetch;
  });

  // --- XMLHttpRequest ------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const openOrig = XHR.prototype.open;
    const sendOrig = XHR.prototype.send;

    XHR.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ): void {
      const raw = typeof url === 'string' ? url : url.href;
      const { scrubbed, capturable } = resolveUrl(raw);
      (this as XhrWithMeta).__qaPipeline = {
        method: String(method).toUpperCase(),
        url: scrubbed,
        capturable,
        started: 0,
      };
      openOrig.call(this, method, url, async, username ?? null, password ?? null);
    };

    XHR.prototype.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const meta = (this as XhrWithMeta).__qaPipeline;
      if (meta) {
        meta.started = performance.now();
        this.addEventListener('loadend', () => {
          const entry: NetworkEntry = {
            ts: Date.now(),
            method: meta.method,
            url: meta.url,
            status: this.status,
            ms: Math.round(performance.now() - meta.started),
          };
          network.push(entry);
          if (meta.capturable) {
            const readable = this.responseType === '' || this.responseType === 'text';
            let text = '';
            if (readable) {
              try {
                text = this.responseText;
              } catch {
                /* response not readable in this state */
              }
            }
            if (this.status < 200 || this.status >= 300) {
              entry.bodySnippet = scrubString(text).slice(0, SNIPPET_CHARS);
            } else if (this.status === 200 && readable && text.trim() === '') {
              entry.bodySnippet = '';
            }
          }
        });
      }
      sendOrig.call(this, body);
    };

    disposers.push(() => {
      XHR.prototype.open = openOrig;
      XHR.prototype.send = sendOrig;
    });
  }

  // --- click + input trail -------------------------------------------------
  // Clicks, typing, toggles, selects, contenteditable edits and Enter presses
  // share ONE ring buffer, interleaved in event order. Every listener sits on
  // WINDOW in the capture phase (fires before any app listener).
  const inIgnoredRoot = (e: Event): boolean => {
    if (!ignoreRoot) return false;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(ignoreRoot) || (e.target instanceof Node && ignoreRoot.contains(e.target));
  };

  // The trail entry currently accumulating typing for a field. While it is the
  // most recent trail item, further change/debounce fires for the SAME field
  // update it in place (no duplicate steps); any click, toggle, Enter press or
  // route change seals it.
  let activeInput: { el: Element; entry: ClickTrailEntry } | null = null;
  // Enter commits a field value: the change event it triggers would duplicate
  // the just-flushed input step, so the NEXT change on that element is dropped.
  let suppressChangeFor: Element | null = null;

  const stepMetaInto = (entry: ClickTrailEntry, el: Element): void => {
    try {
      entry.selector = buildSelector(el);
    } catch {
      /* selector is best-effort — the step still records */
    }
    const testid = el.closest('[data-testid]')?.getAttribute('data-testid');
    if (testid) entry.testid = testid;
    const { component } = annotationOf(el);
    if (component) entry.component = component;
  };

  const onClick = (e: MouseEvent): void => {
    if (inIgnoredRoot(e)) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const first = path[0];
    const target = first instanceof Element ? first : e.target instanceof Element ? e.target : null;
    if (!target) return;
    const entry: ClickTrailEntry = { ts: Date.now(), route: location.pathname, kind: 'click' };
    const text = (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, CLICK_TEXT_CHARS);
    if (text) entry.text = text;
    stepMetaInto(entry, target);
    activeInput = null;
    suppressChangeFor = null;
    trail.push(entry);
  };
  window.addEventListener('click', onClick, true);
  disposers.push(() => window.removeEventListener('click', onClick, true));

  const inputTimers = new Map<Element, number>();
  // Last value seen via 'input' events — the change-time fallback for fields
  // that frameworks (React) clear before the change listener reads them.
  const lastTyped = new WeakMap<FieldEl, string>();

  const recordInput = (el: Element, value: string, label?: string): void => {
    const entry: ClickTrailEntry = {
      ts: Date.now(),
      route: location.pathname,
      kind: 'input',
      value: scrubString(value).slice(0, INPUT_VALUE_CHARS),
    };
    stepMetaInto(entry, el);
    if (label) entry.text = label;
    if (activeInput && activeInput.el === el) {
      Object.assign(activeInput.entry, entry); // still the latest step — refresh in place
      return;
    }
    activeInput = { el, entry };
    trail.push(entry);
  };

  /** Discrete toggle step — checkbox/radio state changes never coalesce. */
  const recordToggle = (el: HTMLInputElement): void => {
    const entry: ClickTrailEntry = {
      ts: Date.now(),
      route: location.pathname,
      kind: 'input',
      value: el.checked ? 'checked' : 'unchecked',
    };
    stepMetaInto(entry, el);
    const label = fieldLabel(el);
    if (label) entry.text = label;
    activeInput = null;
    trail.push(entry);
  };

  const clearInputTimer = (el: Element): void => {
    const timer = inputTimers.get(el);
    if (timer !== undefined) {
      clearTimeout(timer);
      inputTimers.delete(el);
    }
  };

  const onChange = (e: Event): void => {
    if (inIgnoredRoot(e)) return;
    const toggle = asToggle(e.target);
    if (toggle) {
      if (isSensitiveField(toggle)) return;
      recordToggle(toggle);
      return;
    }
    const el = asField(e.target);
    if (!el || isSensitiveField(el)) return;
    if (suppressChangeFor === el) {
      suppressChangeFor = null; // Enter already flushed this exact value
      return;
    }
    clearInputTimer(el);
    if (el instanceof HTMLSelectElement) {
      recordInput(el, selectedLabel(el), fieldLabel(el));
    } else {
      const raw = el.value;
      recordInput(el, raw !== '' ? raw : (lastTyped.get(el) ?? raw), fieldLabel(el));
    }
    lastTyped.delete(el);
  };
  window.addEventListener('change', onChange, true);
  disposers.push(() => window.removeEventListener('change', onChange, true));

  const onInput = (e: Event): void => {
    if (inIgnoredRoot(e)) return;
    suppressChangeFor = null; // fresh typing — the next change is real again
    const el = asField(e.target);
    if (el) {
      if (isSensitiveField(el)) return;
      lastTyped.set(el, el.value);
      clearInputTimer(el);
      inputTimers.set(
        el,
        window.setTimeout(() => {
          inputTimers.delete(el);
          if (el instanceof HTMLSelectElement) recordInput(el, selectedLabel(el), fieldLabel(el));
          else recordInput(el, lastTyped.get(el) ?? el.value, fieldLabel(el));
        }, INPUT_DEBOUNCE_MS),
      );
      return;
    }
    // Contenteditable edits debounce like text inputs; value = textContent
    // (scrubbed + clamped by recordInput), coalesced per edit burst.
    const host = editableHost(e.target);
    if (!host) return;
    clearInputTimer(host);
    inputTimers.set(
      host,
      window.setTimeout(() => {
        inputTimers.delete(host);
        recordInput(host, host.textContent ?? '', fieldLabel(host));
      }, INPUT_DEBOUNCE_MS),
    );
  };
  window.addEventListener('input', onInput, true);
  disposers.push(() => {
    window.removeEventListener('input', onInput, true);
    for (const timer of inputTimers.values()) clearTimeout(timer);
    inputTimers.clear();
  });

  // Enter inside an input/textarea is a submit-intent step: flush any pending
  // typing first (so the trail reads "typed … → pressed Enter"), then record
  // {kind:'click', text:'pressed Enter', selector of the field}.
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' || inIgnoredRoot(e)) return;
    const el = asEnterField(e.target);
    if (!el || isSensitiveField(el)) return;
    if (inputTimers.has(el)) {
      clearInputTimer(el);
      recordInput(el, lastTyped.get(el) ?? el.value, fieldLabel(el));
      lastTyped.delete(el);
    }
    const entry: ClickTrailEntry = {
      ts: Date.now(),
      route: location.pathname,
      kind: 'click',
      text: 'pressed Enter',
    };
    stepMetaInto(entry, el);
    activeInput = null;
    suppressChangeFor = el; // the commit-on-Enter change would duplicate the flush
    trail.push(entry);
  };
  window.addEventListener('keydown', onKeydown, true);
  disposers.push(() => window.removeEventListener('keydown', onKeydown, true));

  // --- route changes -------------------------------------------------------
  let lastRoute = location.pathname;
  trail.push({ ts: Date.now(), route: lastRoute });
  const recordRoute = (): void => {
    if (location.pathname === lastRoute) return;
    lastRoute = location.pathname;
    activeInput = null; // a route change seals any in-progress input step
    suppressChangeFor = null;
    trail.push({ ts: Date.now(), route: lastRoute });
  };
  const pushStateOrig = history.pushState;
  const replaceStateOrig = history.replaceState;
  // `data: any` mirrors the lib.dom History signatures so the assignment stays compatible.
  history.pushState = function (this: History, data: any, unused: string, url?: string | URL | null): void {
    pushStateOrig.call(this, data, unused, url);
    recordRoute();
  };
  history.replaceState = function (this: History, data: any, unused: string, url?: string | URL | null): void {
    replaceStateOrig.call(this, data, unused, url);
    recordRoute();
  };
  window.addEventListener('popstate', recordRoute);
  disposers.push(() => {
    history.pushState = pushStateOrig;
    history.replaceState = replaceStateOrig;
    window.removeEventListener('popstate', recordRoute);
  });

  return {
    consoleLog: () => consoles.list(),
    networkLog: () => network.list(),
    clickTrail: () => trail.list(),
    rawFetch: nativeFetch,
    setIgnoreRoot: (el) => {
      ignoreRoot = el;
    },
    dispose: () => {
      for (const undo of disposers.splice(0)) undo();
    },
  };
}
