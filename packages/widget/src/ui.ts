// All widget UI, inside one ShadowRoot: fab → menu → picker → drawer → toast.

import type { Buffers } from './buffers';
import type { ClickTrailEntry, ConsoleEntry, IngestBody, NetworkEntry, WidgetConfig } from './types';
import { buildSelector, elementMeta, type ElementMeta } from './selector';
import { pickElement } from './picker';
import { captureShot } from './shot';
import { startReplay, type ReplayHandle, type ReplayRequest } from './replay';
import { widgetCss } from './styles';

const SEND_LABEL = 'Send — Claude starts now ▸';
const GET_TOKEN_TIMEOUT_MS = 3_000;
const MAX_EXTRA_SHOTS = 3;
// Drawer auto-play cadence: one trail step lights up every ~350ms.
const STEP_PLAY_MS = 350;

export interface WidgetUI {
  host: HTMLElement;
  open(): void;
}

interface Draft {
  kind: 'bug' | 'feature';
  meta: ElementMeta;
  selector?: string;
  /** First capture — submits as screenshotDataUrl. */
  shot: string | null;
  /** "＋ Add another screenshot" captures (≤3) — submit as screenshotsDataUrls. */
  extraShots: string[];
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className !== undefined) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Icon + label for one trail entry in the drawer's replay list (contract replay-first icons). */
function stepView(entry: ClickTrailEntry): { icon: string; label: string } {
  if (entry.kind === 'input') {
    if (entry.value === 'checked' || entry.value === 'unchecked') {
      const name = entry.text ?? entry.testid ?? entry.component ?? 'field';
      return { icon: '☑', label: `toggled ${truncate(name, 26)} · ${entry.value}` };
    }
    const where = entry.text ?? entry.testid ?? entry.component;
    const typed = `typed "${truncate(entry.value ?? '', 32)}"`;
    return { icon: '⌨', label: where ? `${typed} · ${truncate(where, 22)}` : typed };
  }
  if (entry.text === 'pressed Enter') return { icon: '⏎', label: 'pressed Enter' };
  const label = entry.text ?? entry.testid ?? entry.component;
  if (label) return { icon: '⊕', label: truncate(label, 44) };
  return { icon: '→', label: entry.route };
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createUI(cfg: WidgetConfig, buffers: Buffers): WidgetUI {
  const host = document.createElement('div');
  host.setAttribute('data-qa-pipeline', '');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(widgetCss);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = widgetCss;
    shadow.appendChild(style);
  }
  const root = h('div', 'root');
  shadow.appendChild(root);
  document.body.appendChild(host);
  buffers.setIgnoreRoot(host);

  let drawer: HTMLElement | null = null;
  let toastEl: HTMLElement | null = null;
  let picking = false;
  let replay: ReplayHandle | null = null;

  // ---- fab -----------------------------------------------------------------
  const fab = h('button', 'qa-fab', '🐛');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Report an issue');
  fab.addEventListener('click', () => void startReport());

  root.append(fab);

  // ---- report flow ---------------------------------------------------------
  // One flow for everything: fab → element picker → form. Esc skips the picker
  // (feature ideas have nothing to point at) — picked = bug, skipped = feature.
  async function startReport(): Promise<void> {
    if (picking || drawer) return;
    picking = true;
    fab.hidden = true;
    try {
      const element = await pickElement(root, { ignore: host });
      const kind: 'bug' | 'feature' = element ? 'bug' : 'feature';
      const shot = await captureShot(element, host);
      const draft: Draft = { kind, meta: element ? elementMeta(element) : {}, shot, extraShots: [] };
      if (element) draft.selector = buildSelector(element);
      openDrawer(draft);
    } finally {
      picking = false;
      if (!drawer && !replay) fab.hidden = false;
    }
  }

  function chip(key: string, value: string, isError = false): HTMLElement {
    const el = h('div', `chip mono${isError ? ' err' : ''}`);
    el.appendChild(h('span', 'k', key));
    el.appendChild(document.createTextNode(truncate(value, 90)));
    return el;
  }

  // ---- lightbox (thumbnail enlarge) ---------------------------------------
  let lightbox: HTMLElement | null = null;
  let lightboxKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  function closeLightbox(): void {
    if (lightboxKeyHandler) {
      window.removeEventListener('keydown', lightboxKeyHandler, true);
      lightboxKeyHandler = null;
    }
    lightbox?.remove();
    lightbox = null;
  }

  function openLightbox(src: string, alt: string): void {
    closeLightbox();
    const overlay = h('div', 'qa-lightbox');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', `${alt} enlarged`);
    const img = h('img');
    img.src = src;
    img.alt = alt;
    overlay.appendChild(img);
    overlay.addEventListener('click', closeLightbox);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeLightbox();
    };
    lightboxKeyHandler = onKey;
    window.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    lightbox = overlay;
  }

  // ---- trail auto-play (once per drawer open) -----------------------------
  let stopPlayback: (() => void) | null = null;

  function playTrail(list: HTMLElement): void {
    if (prefersReducedMotion()) return; // static list — every step fully visible
    const items = Array.from(list.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
    if (items.length === 0) return;
    for (const item of items) item.classList.add('pending');
    let timer = 0;
    let idx = 0;
    const tick = (): void => {
      items[idx - 1]?.classList.remove('now');
      const item = items[idx];
      if (!item) return;
      item.classList.remove('pending');
      item.classList.add('now');
      try {
        item.scrollIntoView({ block: 'nearest' }); // the list scroll follows the run-through
      } catch {
        /* jsdom / detached */
      }
      idx++;
      timer = window.setTimeout(idx < items.length ? tick : () => item.classList.remove('now'), STEP_PLAY_MS);
    };
    tick();
    stopPlayback = () => {
      clearTimeout(timer);
      for (const item of items) item.classList.remove('pending', 'now');
      stopPlayback = null;
    };
  }

  function lastConsoleError(): ConsoleEntry | undefined {
    const log = buffers.consoleLog();
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry && entry.level === 'error') return entry;
    }
    return log[log.length - 1];
  }

  function lastNetworkFailure(): NetworkEntry | undefined {
    const log = buffers.networkLog();
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry && (entry.status === 0 || entry.status >= 400 || entry.bodySnippet !== undefined)) {
        return entry;
      }
    }
    return undefined;
  }

  function describeNet(entry: NetworkEntry): string {
    const path = entry.url.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const status = entry.status === 0 ? 'failed' : String(entry.status);
    const empty = entry.bodySnippet === '' ? ' · empty body' : '';
    return `${entry.method} ${truncate(path, 48)} → ${status}${empty}`;
  }

  function endpointHost(): string {
    try {
      return new URL(cfg.endpoint).host;
    } catch {
      return cfg.endpoint;
    }
  }

  function openDrawer(draft: Draft): void {
    const panel = h('aside', 'qa-drawer');
    panel.setAttribute('role', 'dialog');
    const title = 'Report an issue';
    panel.setAttribute('aria-label', title);

    const head = h('div', 'drawer-head');
    head.appendChild(h('div', 'di', draft.kind === 'bug' ? '🐛' : '✦'));
    const headText = h('div');
    headText.appendChild(h('h3', undefined, title));
    headText.appendChild(h('div', 'sub', 'Everything below was captured automatically'));
    head.appendChild(headText);
    const close = h('button', 'drawer-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Discard report');
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    panel.appendChild(head);

    // Primary context section (contract §Widget drawer replay-first): the FULL
    // numbered trail — what Claude will replay — auto-playing once on open.
    panel.appendChild(h('div', 'cap-label', 'Replay · what Claude will see'));
    const steps = buffers.clickTrail();
    if (steps.length === 0) {
      panel.appendChild(h('div', 'chip', 'No steps recorded yet'));
    } else {
      const list = h('ol', 'replay-list');
      steps.forEach((entry, i) => {
        const li = h('li', 'replay-step');
        const view = stepView(entry);
        li.appendChild(h('span', 'rs-num', String(i + 1)));
        li.appendChild(h('span', 'rs-ico', view.icon));
        li.appendChild(h('span', 'rs-lbl', view.label));
        list.appendChild(li);
      });
      panel.appendChild(list);
      playTrail(list);
    }

    // Screenshots: compact thumbnail row below the trail (capture unchanged;
    // each thumb enlarges via the lightbox).
    panel.appendChild(h('div', 'cap-label', 'Screenshots'));
    const shotsWrap = h('div', 'shots');
    panel.appendChild(shotsWrap);

    function thumb(src: string, alt: string, onRemove?: () => void): HTMLElement {
      const cell = h('div', 'thumb');
      const img = h('img');
      img.src = src;
      img.alt = alt;
      img.addEventListener('click', () => openLightbox(src, alt));
      cell.appendChild(img);
      if (onRemove) {
        const x = h('button', 'thumb-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', `Remove ${alt}`);
        x.addEventListener('click', onRemove);
        cell.appendChild(x);
      }
      return cell;
    }

    function renderShots(): void {
      shotsWrap.textContent = '';
      if (!draft.shot && draft.extraShots.length === 0) {
        shotsWrap.appendChild(h('div', 'chip', 'Screenshot unavailable on this page'));
      } else {
        const row = h('div', 'shot-row');
        // The first capture is the report's anchor — no ×; added shots are removable.
        if (draft.shot) row.appendChild(thumb(draft.shot, 'screenshot 1'));
        draft.extraShots.forEach((src, i) => {
          row.appendChild(
            thumb(src, `screenshot ${(draft.shot ? 1 : 0) + i + 1}`, () => {
              draft.extraShots.splice(i, 1);
              renderShots();
            }),
          );
        });
        shotsWrap.appendChild(row);
        shotsWrap.appendChild(h('div', 'shots-cap', `${location.pathname} · ${window.innerWidth}×${window.innerHeight}`));
      }
      if (draft.extraShots.length < MAX_EXTRA_SHOTS) {
        const add = h('button', 'add-shot', '＋ Add another screenshot');
        add.type = 'button';
        add.addEventListener('click', () => void addShot());
        shotsWrap.appendChild(add);
      }
    }

    // Hide the drawer, re-enter the element picker (Esc = plain viewport shot),
    // capture, and come back with the new thumb. Buffers keep recording — only
    // widget-internal events are ever ignored.
    async function addShot(): Promise<void> {
      if (picking || draft.extraShots.length >= MAX_EXTRA_SHOTS) return;
      picking = true;
      panel.style.display = 'none';
      try {
        const element = await pickElement(root, { ignore: host });
        const shot = await captureShot(element, host);
        if (shot) draft.extraShots.push(shot);
        else toast('err', "Couldn't capture that screenshot — try again.");
      } finally {
        panel.style.display = '';
        picking = false;
        renderShots();
      }
    }

    renderShots();

    const { meta } = draft;
    if (meta.component || meta.sourceFile || meta.testid || draft.selector) {
      panel.appendChild(h('div', 'cap-label', 'Code location'));
      const chips = h('div', 'chips');
      if (meta.component || meta.sourceFile) {
        chips.appendChild(chip('component', [meta.component, meta.sourceFile].filter(Boolean).join(' · ')));
      } else if (meta.testid) {
        chips.appendChild(chip('testid', meta.testid));
      }
      if (draft.selector) chips.appendChild(chip('selector', draft.selector));
      panel.appendChild(chips);
    }

    const lastConsole = lastConsoleError();
    const lastNet = lastNetworkFailure();
    if (lastConsole || lastNet) {
      panel.appendChild(h('div', 'cap-label', 'Recorded while you navigated'));
      const chips = h('div', 'chips');
      if (lastConsole) chips.appendChild(chip('console', lastConsole.text, true));
      if (lastNet) chips.appendChild(chip('network', describeNet(lastNet), true));
      panel.appendChild(chips);
    }

    panel.appendChild(h('div', 'cap-label', "What's wrong? / New feature?"));
    const desc = h('textarea', 'desc');
    desc.required = true;
    desc.placeholder = 'One sentence: what happened — or what should this do?';
    desc.addEventListener('input', () => desc.classList.remove('invalid'));
    panel.appendChild(desc);

    const send = h('button', 'send-btn', SEND_LABEL);
    send.type = 'button';
    send.addEventListener('click', () => void submit(draft, desc, send));
    panel.appendChild(send);
    panel.appendChild(h('div', 'send-note', `Lands on ${endpointHost()} · fix fires automatically`));

    root.appendChild(panel);
    drawer = panel;
    fab.hidden = true;
    requestAnimationFrame(() => desc.focus());
  }

  function closeDrawer(): void {
    stopPlayback?.();
    closeLightbox();
    drawer?.remove();
    drawer = null;
    if (!replay) fab.hidden = false;
  }

  // ---- replay (contracts §Replay, messages 8-9) ----------------------------
  // In framed+activated mode the task page (same origin that activated the
  // widget = the configured endpoint's origin) can ask for a visual replay of
  // the report's click trail. The fab hides for the duration; when the run
  // finishes we post `qa-pipeline:replay-done {shown, skipped}` back to that
  // origin. A second replay message cancels the current run and restarts.
  if (window.self !== window.top) {
    let activatingOrigin: string | null = null;
    try {
      activatingOrigin = new URL(cfg.endpoint).origin;
    } catch {
      activatingOrigin = null; // malformed endpoint — replay stays off
    }
    if (activatingOrigin) {
      const origin = activatingOrigin;
      window.addEventListener('message', (e: MessageEvent) => {
        if (e.origin !== origin) return;
        const d = e.data as
          | { type?: unknown; route?: unknown; trail?: unknown; selector?: unknown; elementText?: unknown }
          | null;
        if (!d || d.type !== 'qa-pipeline:replay') return;
        replay?.cancel(); // restart cleanly on a second replay message
        const req: ReplayRequest = {
          route: typeof d.route === 'string' && d.route ? d.route : location.pathname,
          trail: Array.isArray(d.trail) ? (d.trail as ReplayRequest['trail']) : [],
        };
        if (typeof d.selector === 'string' && d.selector) req.selector = d.selector;
        if (typeof d.elementText === 'string' && d.elementText) req.elementText = d.elementText;
        fab.hidden = true;
        const handle = startReplay(req, { container: root, ignore: host });
        replay = handle;
        void handle.done.then((result) => {
          if (replay !== handle) return; // superseded by a restart
          replay = null;
          if (!drawer && !picking) fab.hidden = false;
          if (result) {
            window.parent.postMessage(
              { type: 'qa-pipeline:replay-done', shown: result.shown, skipped: result.skipped },
              origin,
            );
          }
        });
      });
    }
  }

  /**
   * Frame handshake step 4 (contracts § Widget host integration): when the app
   * runs inside the QA site's /capture iframe, tell the parent a report was
   * filed so it can navigate to the task page. targetOrigin is the configured
   * endpoint's origin — only the QA site can receive it.
   */
  function notifyParentFiled(id: number, url: string): void {
    if (window.self === window.top) return;
    try {
      window.parent.postMessage({ type: 'qa-pipeline:filed', id, url }, new URL(cfg.endpoint).origin);
    } catch {
      // Malformed endpoint — skip; the toast link still works.
    }
  }

  /**
   * When framed by the QA site, ask the parent (capture page) for the QA
   * session's access token — the tester is always signed in THERE, even when
   * the embedded app is logged out. Origin-checked both ways; null on timeout.
   */
  function requestParentToken(): Promise<string | null> {
    if (window.self === window.top) return Promise.resolve(null);
    let origin: string;
    try {
      origin = new URL(cfg.endpoint).origin;
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, GET_TOKEN_TIMEOUT_MS);
      const onMsg = (e: MessageEvent): void => {
        if (e.origin !== origin) return;
        const d = e.data as { type?: unknown; token?: unknown } | null;
        if (!d || d.type !== 'qa-pipeline:token-result') return;
        cleanup();
        resolve(typeof d.token === 'string' && d.token ? d.token : null);
      };
      function cleanup(): void {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
      }
      window.addEventListener('message', onMsg);
      window.parent.postMessage({ type: 'qa-pipeline:token' }, origin);
    });
  }

  /**
   * Submit-time auth, in order: (a) framed → the QA site session via the
   * parent token relay; (b) the host's `window.QAPipeline.getToken` session
   * bridge (awaited, 3s timeout); (c) the configured static token →
   * `x-qa-token`; (d) none → null.
   */
  async function resolveAuthHeader(): Promise<Record<string, string> | null> {
    const parentToken = await requestParentToken();
    if (parentToken) return { authorization: `Bearer ${parentToken}` };
    const getToken = window.QAPipeline?.getToken;
    if (typeof getToken === 'function') {
      try {
        const token = await Promise.race([
          Promise.resolve().then(() => getToken()),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('getToken timed out')), GET_TOKEN_TIMEOUT_MS);
          }),
        ]);
        if (typeof token === 'string' && token) return { authorization: `Bearer ${token}` };
      } catch {
        // bridge failed/timed out — fall back to the static token below
      }
    }
    if (cfg.token) return { 'x-qa-token': cfg.token };
    return null;
  }

  async function submit(draft: Draft, desc: HTMLTextAreaElement, send: HTMLButtonElement): Promise<void> {
    const description = desc.value.trim();
    if (!description) {
      desc.classList.add('invalid');
      desc.focus();
      return;
    }
    send.disabled = true;
    send.textContent = 'Sending…';

    const auth = await resolveAuthHeader();
    if (!auth) {
      send.disabled = false;
      send.textContent = SEND_LABEL;
      toast('err', "Couldn't authenticate — sign in to QA Pipeline, then try again");
      return;
    }

    const body: IngestBody = {
      kind: draft.kind,
      description,
      route: location.pathname,
      pageTitle: document.title,
      clickTrail: buffers.clickTrail(),
      consoleLog: buffers.consoleLog(),
      networkLog: buffers.networkLog(),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    };
    if (cfg.email) body.reporterEmail = cfg.email;
    if (draft.meta.component) body.component = draft.meta.component;
    if (draft.meta.sourceFile) body.sourceFile = draft.meta.sourceFile;
    if (draft.selector) body.selector = draft.selector;
    if (draft.meta.testid) body.testid = draft.meta.testid;
    if (draft.meta.text) body.elementText = draft.meta.text;
    if (cfg.appContext) body.appContext = cfg.appContext;
    // First capture → screenshotDataUrl, the rest → screenshotsDataUrls (≤3).
    // When the first capture failed, the earliest added shot is promoted.
    const shots = [draft.shot, ...draft.extraShots].filter((s): s is string => Boolean(s));
    const [firstShot, ...restShots] = shots;
    if (firstShot) body.screenshotDataUrl = firstShot;
    if (restShots.length > 0) body.screenshotsDataUrls = restShots.slice(0, MAX_EXTRA_SHOTS);

    try {
      const res = await buffers.rawFetch(`${cfg.endpoint}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`ingest ${res.status}`);
      const out = (await res.json()) as { id: number; url: string };
      closeDrawer();
      // ingest returns an absolute url when NEXT_PUBLIC_SITE_URL is set;
      // only a relative fallback ("/task/N") needs the endpoint prefix.
      const link = out.url.startsWith('http') ? out.url : `${cfg.endpoint}${out.url}`;
      toast('ok', `Report #${out.id} filed — Claude starts now`, link);
      notifyParentFiled(out.id, link);
    } catch {
      send.disabled = false;
      send.textContent = SEND_LABEL;
      toast('err', "Couldn't send — your report is kept here, try again.");
    }
  }

  function toast(tone: 'ok' | 'err', message: string, link?: string): void {
    toastEl?.remove();
    const el = h('div', `qa-toast ${tone}`);
    el.setAttribute('role', 'status');
    el.appendChild(h('span', undefined, message));
    if (link !== undefined) {
      const a = h('a', undefined, 'View progress ↗');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener';
      el.appendChild(a);
    }
    root.appendChild(el);
    toastEl = el;
    setTimeout(
      () => {
        el.remove();
        if (toastEl === el) toastEl = null;
      },
      tone === 'ok' ? 8000 : 5000,
    );
  }

  return { host, open: () => void startReport() };
}
