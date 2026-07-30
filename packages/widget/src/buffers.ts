// Rolling capture buffers, armed from page load: console, network, click trail,
// route changes. Headers are NEVER read into storage; URLs and bodies are scrubbed.

import { scrubString } from './scrub';
import { annotationOf } from './selector';
import type { ClickTrailEntry, ConsoleEntry, NetworkEntry } from './types';

const CONSOLE_MAX = 50;
const CONSOLE_CHARS = 500;
const NETWORK_MAX = 40;
const SNIPPET_CHARS = 2000;
const TRAIL_MAX = 50;
const CLICK_TEXT_CHARS = 40;

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

  // --- click trail ---------------------------------------------------------
  const onClick = (e: MouseEvent): void => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (
      ignoreRoot &&
      (path.includes(ignoreRoot) || (e.target instanceof Node && ignoreRoot.contains(e.target)))
    ) {
      return;
    }
    const first = path[0];
    const target = first instanceof Element ? first : e.target instanceof Element ? e.target : null;
    if (!target) return;
    const entry: ClickTrailEntry = { ts: Date.now(), route: location.pathname };
    const text = (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, CLICK_TEXT_CHARS);
    if (text) entry.text = text;
    const testid = target.closest('[data-testid]')?.getAttribute('data-testid');
    if (testid) entry.testid = testid;
    const { component } = annotationOf(target);
    if (component) entry.component = component;
    trail.push(entry);
  };
  document.addEventListener('click', onClick, true);
  disposers.push(() => document.removeEventListener('click', onClick, true));

  // --- route changes -------------------------------------------------------
  let lastRoute = location.pathname;
  trail.push({ ts: Date.now(), route: lastRoute });
  const recordRoute = (): void => {
    if (location.pathname === lastRoute) return;
    lastRoute = location.pathname;
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
