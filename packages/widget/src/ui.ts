// All widget UI, inside one ShadowRoot: fab → menu → picker → drawer → toast.

import type { Buffers } from './buffers';
import type { ClickTrailEntry, ConsoleEntry, IngestBody, NetworkEntry, WidgetConfig } from './types';
import { buildSelector, elementMeta, type ElementMeta } from './selector';
import { pickElement } from './picker';
import { captureShot } from './shot';
import { widgetCss } from './styles';

const SEND_LABEL = 'Send — Claude starts now ▸';
const TRAIL_PREVIEW = 6;
const GET_TOKEN_TIMEOUT_MS = 3_000;

export interface WidgetUI {
  host: HTMLElement;
  open(): void;
}

interface Draft {
  kind: 'bug' | 'feature';
  meta: ElementMeta;
  selector?: string;
  shot: string | null;
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

  // ---- fab + menu ----------------------------------------------------------
  const fab = h('button', 'qa-fab', '🐛');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Report a bug or request a feature');
  fab.setAttribute('aria-haspopup', 'menu');
  fab.setAttribute('aria-expanded', 'false');
  fab.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));

  const menu = h('div', 'qa-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'QA Pipeline');

  function menuItem(icon: string, title: string, sub: string, onPick: () => void): void {
    const btn = h('button', 'mi');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.appendChild(h('span', 'mic', icon));
    const label = h('span');
    label.appendChild(document.createTextNode(title));
    label.appendChild(h('span', 'sub', sub));
    btn.appendChild(label);
    btn.addEventListener('click', onPick);
    menu.appendChild(btn);
  }
  menuItem('⊕', 'Report an issue', "Point at what's broken", () => void startReport('bug'));
  menuItem('✦', 'Request a feature', "Describe what's missing", () => void startReport('feature'));
  menuItem('▤', 'My reports', 'Open the QA board', () => {
    window.open(cfg.endpoint, '_blank', 'noopener');
    closeMenu();
  });

  root.append(menu, fab);

  function openMenu(): void {
    if (drawer || picking) return;
    menu.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
  }
  function closeMenu(): void {
    menu.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!menu.hidden && !e.composedPath().includes(host)) closeMenu();
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });

  // ---- report flow ---------------------------------------------------------
  async function startReport(kind: 'bug' | 'feature'): Promise<void> {
    closeMenu();
    if (picking || drawer) return;
    picking = true;
    fab.hidden = true;
    try {
      let element: Element | null = null;
      if (kind === 'bug') {
        element = await pickElement(root, { ignore: host });
        if (!element) return; // Esc — cancelled
      }
      const shot = await captureShot(element, host);
      const draft: Draft = { kind, meta: element ? elementMeta(element) : {}, shot };
      if (element) draft.selector = buildSelector(element);
      openDrawer(draft);
    } finally {
      picking = false;
      if (!drawer) fab.hidden = false;
    }
  }

  function chip(key: string, value: string, isError = false): HTMLElement {
    const el = h('div', `chip mono${isError ? ' err' : ''}`);
    el.appendChild(h('span', 'k', key));
    el.appendChild(document.createTextNode(truncate(value, 90)));
    return el;
  }

  function trailChip(entry: ClickTrailEntry): HTMLElement {
    const clickLabel = entry.text ?? entry.testid ?? entry.component;
    return clickLabel
      ? h('span', 't click', `⊕ ${truncate(clickLabel, 26)}`)
      : h('span', 't', entry.route);
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
    const title = draft.kind === 'bug' ? 'Report an issue' : 'Request a feature';
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

    panel.appendChild(h('div', 'cap-label', draft.kind === 'bug' ? 'Screenshot · element marked' : 'Screenshot'));
    if (draft.shot) {
      const shot = h('div', 'shot');
      const img = h('img');
      img.src = draft.shot;
      img.alt = 'Captured screenshot';
      shot.appendChild(img);
      shot.appendChild(h('div', 'shot-cap', `${location.pathname} · ${window.innerWidth}×${window.innerHeight}`));
      panel.appendChild(shot);
    } else {
      panel.appendChild(h('div', 'chip', 'Screenshot unavailable on this page'));
    }

    const trail = buffers.clickTrail().slice(-TRAIL_PREVIEW);
    if (trail.length > 0) {
      panel.appendChild(h('div', 'cap-label', 'Click trail'));
      const wrap = h('div', 'trail');
      trail.forEach((entry, i) => {
        if (i > 0) wrap.appendChild(h('span', 'arr', '→'));
        wrap.appendChild(trailChip(entry));
      });
      panel.appendChild(wrap);
    }

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

    panel.appendChild(h('div', 'cap-label', draft.kind === 'bug' ? "What's wrong?" : 'What do you need?'));
    const desc = h('textarea', 'desc');
    desc.required = true;
    desc.placeholder =
      draft.kind === 'bug'
        ? 'One sentence: what happened, and what did you expect?'
        : 'One sentence: what should this do?';
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
    drawer?.remove();
    drawer = null;
    fab.hidden = false;
  }

  /**
   * Submit-time auth, in order: (a) the host's `window.QAPipeline.getToken`
   * session bridge (awaited, 3s timeout) → `Authorization: Bearer`; (b) the
   * configured static token → `x-qa-token`; (c) neither → null (not configured).
   */
  async function resolveAuthHeader(): Promise<Record<string, string> | null> {
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
      toast('err', "QA widget isn't configured — missing auth");
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
    if (draft.shot) body.screenshotDataUrl = draft.shot;

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

  return { host, open: openMenu };
}
