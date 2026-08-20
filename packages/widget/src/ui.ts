// All widget UI, inside one ShadowRoot: fab → menu → picker → drawer → toast.

import type { Buffers } from './buffers';
import type { ClickTrailEntry, ConsoleEntry, IngestBody, IngestUploadTargets, NetworkEntry, WidgetConfig } from './types';
import { buildSelector, elementMeta, type ElementMeta } from './selector';
import {
  clampStep,
  markForStep,
  playerMarks,
  settledOffset,
  stepAriaLabel,
  withResultMark,
  type PlayerMark,
} from './marks';
import { createAutoplay } from './autoplay';
import { fitStage, stageZone, IDENTITY_TRANSFORM, type StageTransform } from './stage';
import { pickElement } from './picker';
import { replayDoneMessage, replayEventsField, startRecorder, type Recorder } from './record';
import { captureShot } from './shot';
import { startReplay, type ReplayHandle, type ReplayRequest } from './replay';
import { widgetCss } from './styles';
import { createTrailList, type TrailList } from './trail-list';

const SEND_LABEL = 'Send — Claude starts now ▸';
const GET_TOKEN_TIMEOUT_MS = 3_000;
const MAX_EXTRA_SHOTS = 3;

export interface WidgetUI {
  host: HTMLElement;
  open(): void;
}

/**
 * A finished ⏺ Start→Finish capture (contract §Session replay): the window the
 * report ships — its click/input steps are the trail entries inside [t0, t1],
 * and `replayJson` is the stringified rrweb recording of exactly that window.
 */
interface RecordedSteps {
  t0: number;
  t1: number;
  /** Route at ⏺ Start — where a replay of these steps must begin. */
  route: string;
  /** Undefined when the recording was empty or over the 8M-char cap. */
  replayJson?: string;
}

interface Draft {
  kind: 'bug' | 'feature';
  meta: ElementMeta;
  selector?: string;
  /** First capture — submits as screenshotDataUrl. */
  shot: string | null;
  /** "＋ Add another screenshot" captures (≤3) — submit as screenshotsDataUrls. */
  extraShots: string[];
  /** Explicit capture — null/absent until the tester records. */
  recording?: RecordedSteps | null;
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
  let replay: ReplayHandle | null = null;
  /** Per-open teardown: trail subscription, list timers, pill, key handler. */
  const drawerCleanup: Array<() => void> = [];

  // ---- explicit recording (contract §Session replay) -----------------------
  // There is NO ambient recorder: a Recorder exists only between the drawer's
  // ⏺ Start and Finish. While it lives, the step sink forwards every trail
  // step into the recording as `addCustomEvent('qa-step', {i, kind, label})`,
  // re-sequenced so mark i === the step's 1-based index WITHIN the window
  // (= the report's clickTrail index). During a replay execution the sink
  // stands down: the replay engine marks its own dedicated recorder.
  let activeRec: { recorder: Recorder; t0: number; route: string; seq: number } | null = null;

  /** The trail entries a draft's finished recording window covers. */
  const recordedTrail = (draft: Draft): ClickTrailEntry[] => {
    const rec = draft.recording;
    if (!rec) return [];
    return buffers.clickTrail().filter((e) => e.ts >= rec.t0 && e.ts <= rec.t1);
  };

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
    headText.appendChild(h('div', 'sub', 'Describe it, record the steps, send'));
    head.appendChild(headText);
    // Collapse (chevron) → compact pill at the right edge, so the drawer never
    // covers the UI being reproduced. The panel stays in the DOM: description
    // text, screenshots and the live subscription all survive untouched.
    const collapseBtn = h('button', 'drawer-collapse', '›');
    collapseBtn.type = 'button';
    collapseBtn.title = 'Collapse — keep reproducing without losing anything';
    collapseBtn.setAttribute('aria-label', 'Collapse report panel');
    collapseBtn.addEventListener('click', () => setCollapsed(true));
    head.appendChild(collapseBtn);
    const close = h('button', 'drawer-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Discard report');
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    panel.appendChild(head);

    // Primary context section (contract §Widget drawer): the recorded steps —
    // clicks, typing and screen are captured ONLY between ⏺ Start and Finish,
    // and the numbered list shows exactly that window (what Claude replays).
    const capRow = h('div', 'cap-label cap-row');
    capRow.appendChild(h('span', undefined, 'Recorded steps · what Claude will replay'));
    const countEl = h('span', 'cap-count');
    capRow.appendChild(countEl);
    panel.appendChild(capRow);

    /** Steps inside the current window — the live one, else the finished one. */
    const windowTrail = (): ClickTrailEntry[] => {
      if (activeRec) {
        const t0 = activeRec.t0;
        return buffers.clickTrail().filter((e) => e.ts >= t0);
      }
      return recordedTrail(draft);
    };

    let list: TrailList = createTrailList(windowTrail(), {
      onPick: (index) => list.setActive(index),
    });
    drawerCleanup.push(() => list.dispose());
    panel.appendChild(list.el);

    const recBtn = h('button', 'qa-record', draft.recording ? '↻ Re-record the steps' : '⏺ Record the steps');
    recBtn.type = 'button';
    panel.appendChild(recBtn);
    panel.appendChild(
      h('div', 'live-hint', 'Recording captures your clicks, typing and screen until you press Finish.'),
    );

    const pillCount = h('span', 'pill-count');
    function paintCount(): void {
      const n = list.count();
      countEl.textContent =
        draft.recording || activeRec ? `${n} step${n === 1 ? '' : 's'}` : 'not recorded yet';
      pillCount.textContent = String(n);
    }
    paintCount();

    /** Swap in a fresh list for the current window (sync() can only append). */
    const resetList = (): void => {
      const next: TrailList = createTrailList(windowTrail(), {
        onPick: (index) => next.setActive(index),
      });
      list.el.replaceWith(next.el);
      list.dispose();
      list = next;
      paintCount();
    };

    // ONE subscription for the whole drawer, debounced inside buffers (~120ms):
    // while a recording is live it appends the new rows and repaints the count,
    // so steps land in the list (and the Finish pill) as they happen.
    drawerCleanup.push(
      buffers.onTrail(() => {
        if (!activeRec) return;
        const result = list.sync(windowTrail());
        if (result.added > 0 || result.updated) paintCount();
      }),
    );

    // ---- collapse ↔ pill ---------------------------------------------------
    // Collapsed, the panel is only display:none — every bit of form state
    // (description text, screenshots) and the live subscription stay alive, so
    // expanding returns the tester to exactly what they had, with the steps
    // taken meanwhile already in the list.
    let collapsed = false;
    const pill = h('button', 'qa-pill');
    pill.type = 'button';
    pill.title = 'Back to your report';
    pill.setAttribute('aria-label', 'Expand report panel');
    const pillIcon = h('span', undefined, '🐛');
    const pillTail = h('span', 'pill-tail', '');
    pill.appendChild(pillIcon);
    pill.appendChild(pillCount);
    pill.appendChild(pillTail);
    // While recording, the pill IS the Finish button: it ends the capture and
    // returns to the report in one click.
    pill.addEventListener('click', () => {
      finishRecording();
      setCollapsed(false);
    });
    drawerCleanup.push(() => pill.remove());

    function setCollapsed(next: boolean): void {
      if (next === collapsed) return;
      collapsed = next;
      collapseBtn.setAttribute('aria-expanded', next ? 'false' : 'true');
      if (next) {
        panel.style.display = 'none';
        root.appendChild(pill);
      } else {
        pill.remove();
        panel.style.display = '';
        desc.focus();
      }
    }
    collapseBtn.setAttribute('aria-expanded', 'true');

    // ---- ⏺ Start / Finish --------------------------------------------------
    // Start: fresh single-window recorder (no checkout rotation — nothing is
    // ever dropped), step sink re-sequencing marks to the window, drawer
    // collapsed to the red Finish pill so the tester reproduces uncovered.
    // Finish: freeze the window onto the draft and return to the report.
    function startRecording(): void {
      if (activeRec) return;
      draft.recording = null; // re-record discards the previous take
      const rec = {
        recorder: startRecorder(undefined, undefined, { manual: true }),
        t0: Date.now(),
        route: location.pathname,
        seq: 0,
      };
      activeRec = rec;
      buffers.setStepSink((mark) => {
        if (activeRec !== rec || replay) return;
        rec.recorder.mark({ ...mark, i: ++rec.seq });
      });
      resetList();
      recBtn.textContent = '⏺ Recording…';
      pill.classList.add('rec');
      pillIcon.textContent = '⏺';
      pillTail.textContent = 'Finish';
      pill.title = 'Finish recording and return to the report';
      pill.setAttribute('aria-label', 'Finish recording');
      setCollapsed(true);
    }

    function finishRecording(): void {
      const rec = activeRec;
      if (!rec) return;
      activeRec = null;
      buffers.setStepSink(null);
      const replayJson = replayEventsField(rec.recorder);
      rec.recorder.dispose();
      draft.recording = {
        t0: rec.t0,
        t1: Date.now(),
        route: rec.route,
        ...(replayJson !== undefined ? { replayJson } : {}),
      };
      resetList();
      recBtn.textContent = '↻ Re-record the steps';
      pill.classList.remove('rec');
      pillIcon.textContent = '🐛';
      pillTail.textContent = '';
      pill.title = 'Back to your report';
      pill.setAttribute('aria-label', 'Expand report panel');
    }

    recBtn.addEventListener('click', () => startRecording());
    // Closing the drawer mid-recording discards the live take with it.
    drawerCleanup.push(() => {
      if (activeRec) {
        buffers.setStepSink(null);
        activeRec.recorder.dispose();
        activeRec = null;
      }
    });

    // Escape NEVER discards the report (contract: avoid data loss) — × stays
    // the one explicit discard. It collapses instead, which loses nothing.
    const onDrawerKey = (e: KeyboardEvent): void => {
      // The lightbox owns its own Escape; collapsed, the drawer is out of the
      // way already and the host page keeps its own Escape handling.
      if (e.key !== 'Escape' || picking || lightbox || collapsed) return;
      e.preventDefault();
      e.stopPropagation();
      setCollapsed(true);
    };
    window.addEventListener('keydown', onDrawerKey, true);
    drawerCleanup.push(() => window.removeEventListener('keydown', onDrawerKey, true));

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
    closeLightbox();
    for (const undo of drawerCleanup.splice(0)) {
      try {
        undo();
      } catch {
        /* teardown is best-effort — the drawer still closes */
      }
    }
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
        // After-the-fix recording (contract §Session replay): a DEDICATED rrweb
        // recorder covers exactly this execution — started here, stopped when
        // the run settles. The ambient session recorder is never touched.
        const afterRecorder = startRecorder();
        // Step markers for the "after" recording come from the engine (it knows
        // which step it is executing); the ambient sink stands down meanwhile.
        const handle = startReplay(req, {
          container: root,
          ignore: host,
          onStep: (mark) => afterRecorder.mark(mark),
        });
        replay = handle;
        void handle.done.then((result) => {
          if (replay !== handle) {
            afterRecorder.dispose(); // superseded by a restart — drop this take
            return;
          }
          replay = null;
          if (!drawer && !picking) fab.hidden = false;
          if (result) {
            // Read the events BEFORE dispose() releases the buffers; the field
            // is omitted when the recording is empty or over the 8M-char cap.
            window.parent.postMessage(replayDoneMessage(result, afterRecorder), origin);
          }
          afterRecorder.dispose();
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
      // A recorded report replays from where the recording BEGAN, not from
      // wherever the tester parked before hitting Send.
      route: draft.recording?.route ?? location.pathname,
      pageTitle: document.title,
      // ONLY the recorded window ships (contract §IngestBody clickTrail) —
      // no recording, no trail.
      clickTrail: recordedTrail(draft),
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
    // First capture first, extras after (≤3) — same order the server names
    // marked.png, marked-2.png…  When the first capture failed, the earliest
    // added shot is promoted.
    const shots = [draft.shot, ...draft.extraShots]
      .filter((s): s is string => Boolean(s))
      .slice(0, 1 + MAX_EXTRA_SHOTS);
    // Session replay (contract §Session replay): the ⏺ Start→Finish window's
    // stringified rrweb events, frozen at Finish — absent without a recording.
    const replayJson = draft.recording?.replayJson;
    // Blobs go to signed storage URLs AFTER filing (contract §Widget→Site) —
    // inlined base64 blew Vercel's ~4.5 MB request cap (413) on heavy reports.
    body.uploads = { shots: shots.length, replay: replayJson !== undefined };

    try {
      const res = await buffers.rawFetch(`${cfg.endpoint}/api/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`ingest ${res.status}`);
      const out = (await res.json()) as { id: number; url: string; uploads?: IngestUploadTargets };
      // Evidence uploads are best-effort: the report is already filed, and a
      // failed PUT just means that shot/replay is missing from the task page.
      try {
        const targets = out.uploads;
        if (targets) {
          const puts: Array<Promise<unknown>> = [];
          targets.shots.forEach((t, i) => {
            const dataUrl = shots[i];
            if (!dataUrl || !t?.signedUrl) return;
            puts.push(
              buffers
                .rawFetch(dataUrl)
                .then((r) => r.blob())
                .then((blob) =>
                  buffers.rawFetch(t.signedUrl, {
                    method: 'PUT',
                    headers: { 'content-type': 'image/png' },
                    body: blob,
                  }),
                ),
            );
          });
          if (targets.replay?.signedUrl && replayJson !== undefined) {
            puts.push(
              buffers.rawFetch(targets.replay.signedUrl, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: replayJson,
              }),
            );
          }
          await Promise.all(puts);
        }
      } catch {
        // report filed; missing evidence only
      }
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
