// All widget UI, inside one ShadowRoot: fab → menu → picker → drawer → toast.

import { Replayer } from 'rrweb';
import type { Buffers, StepSink } from './buffers';
import type { ConsoleEntry, IngestBody, NetworkEntry, WidgetConfig } from './types';
import { buildSelector, elementMeta, type ElementMeta } from './selector';
import { clampStep, markForStep, playerMarks, stepAriaLabel, type PlayerMark } from './marks';
import { createAutoplay } from './autoplay';
import { fitStage, stageZone, stepPoint, IDENTITY_TRANSFORM, type Point, type StageTransform } from './stage';
import { pickElement } from './picker';
import { replayDoneMessage, replayEventsField, startRecorder, type Recorder } from './record';
import { captureShot } from './shot';
import { startReplay, type ReplayHandle, type ReplayRequest } from './replay';
import { widgetCss } from './styles';
import { createTrailList, type TrailList } from './trail-list';

const SEND_LABEL = 'Send — Claude starts now ▸';
const GET_TOKEN_TIMEOUT_MS = 3_000;
const MAX_EXTRA_SHOTS = 3;
// Keyframe slideshow: synthetic-cursor glide (matches the .rr-cursor transition)
// and how long the landing pulse ring lives.
const CURSOR_GLIDE_MS = 450;
const CURSOR_PULSE_MS = 700;
// An untouched mini player rebuilds itself once this many new steps landed.
const PLAYER_STALE_STEPS = 5;

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

export function createUI(cfg: WidgetConfig, buffers: Buffers, recorder: Recorder | null = null): WidgetUI {
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

  // ---- ambient step markers (contract §Session replay "Step markers") ------
  // Every trail step buffers pushes also lands in the recording as
  // `addCustomEvent('qa-step', {i, kind, label})`. While a replay executes the
  // sink stands down: the dedicated recorder is the one rrweb is emitting into,
  // and the replay engine marks those steps itself with the index it is running.
  if (recorder) {
    const ambientSink: StepSink = (mark) => {
      if (!replay) recorder.mark(mark);
    };
    buffers.setStepSink(ambientSink);
  }

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

  // ---- session-replay mini player (contract "Player UX … KEYFRAME slideshow") --
  // A real rrweb Replayer over the recorder's buffered events, inside the
  // shadow root, above the numbered trail list. rrweb sandboxes its replay
  // iframe itself (sandbox="allow-same-origin", interaction disabled); we scale
  // the recorded viewport down into the drawer-width ~16:10 stage.
  //
  // It is a KEYFRAME SLIDESHOW, never continuous playback: the recording's own
  // `qa-step` markers (or, for marker-less recordings, the trail's timestamps)
  // become marks, and each step is `pause(mark.offset)` — the frame is exactly
  // the moment of that interaction. Moving between steps glides a synthetic
  // cursor across the stage from the previous step's target to the new one's.
  // It AUTOPLAYS from step 1 on mount and stops on the last step.
  /** Stop autoplay (collapse / picker / anything that hides the stage). */
  let pausePlayer: (() => void) | null = null;
  let destroyPlayer: (() => void) | null = null;
  /** Live-append hook: fold newly recorded steps into the marks + rail. */
  let refreshMarks: (() => void) | null = null;
  /** ← / → : step by ±1 (installed while a player is mounted). */
  let stepPlayer: ((delta: number) => void) | null = null;
  /** List → player: seek to a 1-based trail step (a row click). */
  let seekToStep: ((step: number) => void) | null = null;
  /** The drawer's live list — the player highlights the row it is parked on. */
  let trailList: TrailList | null = null;
  // The recorder keeps filming while the drawer is open, so the mounted player
  // goes stale. `playerBuiltAtSteps` is the trail length it was built at; once
  // the tester actually uses it we stop refreshing under them.
  let playerBuiltAtSteps = 0;
  let playerPlayed = false;
  let playerMounted = false;

  /** Tear the Replayer down and mount a fresh one over the newest events (paused, first frame). */
  function rebuildPlayer(box: HTMLElement): void {
    destroyPlayer?.();
    box.textContent = '';
    initPlayer(box);
  }

  /** ↻ — the ambient recorder never stopped, so the player can always catch up. */
  function freshButton(box: HTMLElement): HTMLButtonElement {
    const btn = h('button', 'rr-btn', '↻');
    btn.type = 'button';
    btn.title = 'Update the replay with what you just did';
    btn.setAttribute('aria-label', 'Update replay with the newest steps');
    btn.addEventListener('click', () => rebuildPlayer(box));
    return btn;
  }

  function initPlayer(box: HTMLElement): void {
    const events = recorder?.events() ?? [];
    playerBuiltAtSteps = buffers.clickTrail().length;
    playerMounted = true;
    const note = (): void => {
      box.appendChild(h('div', 'rr-note', 'recording just started — replay will cover from page load next time'));
      const row = h('div', 'rr-controls');
      row.appendChild(freshButton(box)); // it can catch up once frames exist
      box.appendChild(row);
    };
    // A playable recording needs at least the Meta + FullSnapshot pair.
    if (events.length < 2) {
      note();
      return;
    }

    const stage = h('div', 'rr-stage');
    box.appendChild(stage);

    let replayer: Replayer;
    try {
      replayer = new Replayer(events, {
        root: stage,
        mouseTail: false,
        speed: 1,
        showWarning: false,
        triggerFocus: false, // replayed focus must never steal the live page's focus
      });
    } catch {
      stage.remove();
      note();
      return;
    }

    // Scale the replay (recorded at the tester's viewport size) into the stage.
    // The SAME transform maps points measured inside the replay iframe into the
    // cursor overlay's coordinates (src/stage.ts) — keep them in one place.
    let transform: StageTransform = { ...IDENTITY_TRANSFORM };
    const fit = (w: number, ht: number): void => {
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      if (!cw || !ch || !w || !ht) return;
      transform = fitStage(cw, ch, w, ht);
      const el = replayer.wrapper;
      el.style.transformOrigin = 'top left';
      el.style.transform = `scale(${transform.scale})`;
      el.style.left = `${transform.left}px`;
      el.style.top = `${transform.top}px`;
    };
    replayer.on('resize', (dim) => {
      const d = dim as { width: number; height: number };
      fit(d.width, d.height);
    });
    try {
      replayer.pause(0); // first frame, paused — applies Meta and fires 'resize'
    } catch {
      /* corrupt event stream — the stage stays on whatever rendered */
    }
    fit(Number(replayer.iframe.getAttribute('width')), Number(replayer.iframe.getAttribute('height')));

    // Side-click navigation + hover affordance (contract "Player UX …
    // Navigation"): three edge panes over the stage — the outer two tint and
    // show a chevron on hover, the middle one is inert. They carry no handlers
    // of their own; the click bubbles to the stage, which decides from the
    // pointer's x which third was hit (stageZone).
    const edges = h('div', 'rr-edges');
    edges.append(h('div', 'rr-edge rr-edge-l'), h('div', 'rr-edge rr-edge-m'), h('div', 'rr-edge rr-edge-r'));
    stage.appendChild(edges);

    // Cursor overlay — ABOVE the replayer stage, never interactive.
    const cursorLayer = h('div', 'rr-cursor-layer');
    const cursor = h('div', 'rr-cursor');
    cursorLayer.appendChild(cursor);
    stage.appendChild(cursorLayer);

    // The tick rail is the position indicator; the foot carries ▶/⏸ ⟲ ↻.
    const rail = h('div', 'rr-rail');
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Recorded steps');

    const foot = h('div', 'rr-foot');
    const playBtn = h('button', 'rr-btn', '⏸');
    playBtn.type = 'button';
    playBtn.setAttribute('aria-label', 'Pause the slideshow');
    const restartBtn = h('button', 'rr-btn', '⟲');
    restartBtn.type = 'button';
    restartBtn.title = 'Replay from the first step';
    restartBtn.setAttribute('aria-label', 'Replay from the first step');
    foot.append(playBtn, restartBtn, freshButton(box));
    box.append(rail, foot);
    box.tabIndex = 0; // ← / → work when the player itself holds focus

    const total = Math.max(1, replayer.getMetaData().totalTime);
    const baseline = events[0]?.timestamp ?? 0;
    let marks: PlayerMark[] = playerMarks(events, buffers.clickTrail(), baseline, total);
    let cur = marks.length > 0 ? 0 : -1;

    // ---- synthetic cursor ---------------------------------------------------
    /** Where the cursor currently sits (overlay coords) — the glide's origin. */
    let cursorAt: Point | null = null;
    let glideTimer = 0;

    const placeCursor = (p: Point, animate: boolean): void => {
      cursor.style.transition = animate ? '' : 'none';
      cursor.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (!animate) void cursor.offsetHeight; // flush, so the NEXT move animates
    };

    const pulseAt = (p: Point): void => {
      const ring = h('div', 'rr-cursor-pulse');
      ring.style.transform = `translate(${p.x}px, ${p.y}px)`;
      cursorLayer.appendChild(ring);
      window.setTimeout(() => ring.remove(), CURSOR_PULSE_MS);
    };

    /**
     * The point a step's cursor lands on: resolve the trail entry INSIDE the
     * replayed iframe (selector → testid → component → text), then map its rect
     * through the stage transform. Unresolvable → null → no cursor at all.
     */
    const pointFor = (index: number): Point | null => {
      const mark = marks[index];
      if (!mark) return null;
      let doc: Document | null = null;
      try {
        doc = replayer.iframe.contentDocument;
      } catch {
        doc = null; // sandboxed/torn down — frame change only
      }
      return stepPoint(buffers.clickTrail()[mark.i - 1], doc, transform);
    };

    /** Glide A → B over ~450ms and pulse on arrival; hide instead of stranding a stale cursor. */
    const moveCursor = (to: Point | null): void => {
      window.clearTimeout(glideTimer);
      if (!to) {
        cursor.classList.remove('on');
        cursorAt = null;
        return;
      }
      const from = cursorAt;
      cursor.classList.add('on');
      if (from) {
        placeCursor(from, false);
        requestAnimationFrame(() => placeCursor(to, true));
      } else {
        placeCursor(to, false); // first resolved step — appear where it happened
      }
      cursorAt = to;
      glideTimer = window.setTimeout(() => pulseAt(to), from ? CURSOR_GLIDE_MS : 0);
    };

    // ---- painting -----------------------------------------------------------
    const paintRail = (): void => {
      while (rail.children.length > marks.length) rail.lastElementChild?.remove();
      for (let k = rail.children.length; k < marks.length; k++) {
        const tick = h('button', 'rr-tick');
        tick.type = 'button';
        tick.addEventListener('click', () => navigate(k));
        rail.appendChild(tick);
      }
      const stepped = marks.length > 0;
      rail.hidden = !stepped;
      edges.hidden = !stepped;
      playBtn.hidden = !stepped;
      restartBtn.hidden = !stepped;
      Array.from(rail.children).forEach((node, k) => {
        if (!(node instanceof HTMLElement)) return;
        node.classList.toggle('on', k === cur);
        node.setAttribute('aria-label', stepAriaLabel(marks, k));
        node.setAttribute('aria-current', k === cur ? 'true' : 'false');
      });
    };

    /** Light the row this step came from, and scroll the list to it. */
    const syncList = (): void => {
      const mark = cur >= 0 ? marks[cur] : undefined;
      if (mark) trailList?.setActive(mark.i - 1);
    };

    /**
     * One keyframe: `pause(offset)` puts the frame exactly at that interaction,
     * then the cursor glides from the previous step's target to this one's.
     */
    function seek(index: number, fromList = false): void {
      if (marks.length === 0) return;
      cur = clampStep(index, marks.length);
      const mark = marks[cur];
      if (mark) {
        try {
          replayer.pause(mark.offset);
        } catch {
          /* corrupt event stream — the stage keeps its last frame */
        }
      }
      paintRail();
      if (!fromList) syncList();
      moveCursor(pointFor(cur));
    }

    // Autoplay owns the ▶/⏸ label; every manual navigation stops it.
    const auto = createAutoplay({
      index: () => cur,
      total: () => marks.length,
      go: (index) => seek(index),
      onChange: (playing) => {
        playBtn.textContent = playing ? '⏸' : '▶';
        playBtn.setAttribute('aria-label', playing ? 'Pause the slideshow' : 'Play the slideshow');
      },
    });

    /** Manual navigation: stops autoplay and freezes the auto-rebuild. */
    function navigate(index: number, fromList = false): void {
      playerPlayed = true; // from here on the player only refreshes on demand (↻)
      auto.stop();
      seek(index, fromList);
    }

    const step = (delta: number): void => navigate(cur + delta);

    // Left third = back, right third = forward, middle third inert.
    stage.addEventListener('click', (e) => {
      if (marks.length === 0) return;
      const stageBox = stage.getBoundingClientRect();
      const delta = stageZone(e.clientX - stageBox.left, stageBox.width);
      if (delta !== 0) step(delta);
    });

    playBtn.addEventListener('click', () => {
      playerPlayed = true;
      auto.toggle();
    });
    restartBtn.addEventListener('click', () => {
      playerPlayed = true;
      cursorAt = null; // the run starts over — no glide from wherever it stopped
      auto.restart();
    });

    // Live append: steps taken while the drawer is open extend the marks and
    // the rail. The playhead does NOT move — a player parked on the last step
    // stays there instead of chasing the newest one — but a RUNNING autoplay
    // simply keeps walking into the new steps on its next beat.
    refreshMarks = () => {
      const next = playerMarks(recorder?.events() ?? events, buffers.clickTrail(), baseline, total);
      if (next.length === marks.length) return;
      const wasEmpty = marks.length === 0;
      marks = next;
      cur = clampStep(cur, marks.length);
      paintRail();
      if (wasEmpty && marks.length > 0) {
        seek(0);
        if (!playerPlayed) auto.start(); // the first steps just landed — autoplay them
      }
    };
    stepPlayer = step;
    seekToStep = (trailStep) => {
      const at = markForStep(marks, trailStep);
      if (at >= 0) navigate(at, true);
    };

    paintRail();
    if (marks.length > 0) {
      seek(0); // opens on step 1 …
      auto.start(); // … and walks itself to the end (contract: autoplay by default)
    }

    pausePlayer = () => auto.stop();
    destroyPlayer = () => {
      auto.dispose();
      window.clearTimeout(glideTimer);
      try {
        replayer.pause();
      } catch {
        /* already stopped */
      }
      try {
        replayer.destroy();
      } catch {
        /* already torn down */
      }
      pausePlayer = null;
      destroyPlayer = null;
      refreshMarks = null;
      stepPlayer = null;
      seekToStep = null;
      playerMounted = false;
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

    // Primary context section (contract §Widget drawer replay-first): the
    // session-replay mini player on top (initialized once the panel is in the
    // DOM — the stage needs layout), then the FULL numbered trail — what
    // Claude will replay — LIVE: steps the tester performs while the drawer is
    // open append as they happen (buffers.onTrail), the header count tracks
    // them, and the mini player can be refreshed with ↻.
    const capRow = h('div', 'cap-label cap-row');
    capRow.appendChild(h('span', undefined, 'Replay · what Claude will see'));
    const countEl = h('span', 'cap-count');
    capRow.appendChild(countEl);
    panel.appendChild(capRow);
    const playerBox = h('div', 'rr-player');
    panel.appendChild(playerBox);
    playerBuiltAtSteps = buffers.clickTrail().length; // staleness counts from the open
    // Two-way sync (contract "Player UX"): a row click seeks the player to that
    // step and lights the row; stepping in the player lights + scrolls the row.
    const list: TrailList = createTrailList(buffers.clickTrail(), {
      onPick: (index) => {
        playerPlayed = true;
        list.setActive(index);
        seekToStep?.(index + 1);
      },
    });
    trailList = list;
    drawerCleanup.push(() => {
      list.dispose();
      trailList = null;
    });
    panel.appendChild(list.el);
    panel.appendChild(h('div', 'live-hint', 'Keep using the app — new steps keep recording.'));

    const pillCount = h('span', 'pill-count');
    function paintCount(): void {
      const n = list.count();
      countEl.textContent = `${n} step${n === 1 ? '' : 's'}`;
      pillCount.textContent = String(n);
    }
    paintCount();

    // ONE subscription for the whole drawer, debounced inside buffers (~120ms):
    // it appends only the new rows (never re-renders the list), repaints the
    // count, extends the player's marks, and rebuilds an untouched mini player
    // once it is 5+ steps stale.
    drawerCleanup.push(
      buffers.onTrail(() => {
        const steps = buffers.clickTrail();
        const result = list.sync(steps);
        if (result.added > 0 || result.updated) paintCount();
        if (!playerPlayed && steps.length - playerBuiltAtSteps >= PLAYER_STALE_STEPS) {
          rebuildPlayer(playerBox);
        } else if (result.added > 0) {
          refreshMarks?.();
        }
      }),
    );

    // ← / → step the player whenever focus is anywhere in the drawer — but
    // never while the tester is typing (arrows move the caret in the textarea).
    const onPlayerKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (!stepPlayer) return;
      const target = e.target;
      if (
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      stepPlayer(e.key === 'ArrowLeft' ? -1 : 1);
    };
    panel.addEventListener('keydown', onPlayerKey);
    drawerCleanup.push(() => panel.removeEventListener('keydown', onPlayerKey));

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
    pill.appendChild(h('span', undefined, '🐛'));
    pill.appendChild(pillCount);
    pill.addEventListener('click', () => setCollapsed(false));
    drawerCleanup.push(() => pill.remove());

    function setCollapsed(next: boolean): void {
      if (next === collapsed) return;
      collapsed = next;
      collapseBtn.setAttribute('aria-expanded', next ? 'false' : 'true');
      if (next) {
        pausePlayer?.(); // nothing replays while the panel is out of sight
        panel.style.display = 'none';
        root.appendChild(pill);
      } else {
        pill.remove();
        panel.style.display = '';
        desc.focus();
      }
    }
    collapseBtn.setAttribute('aria-expanded', 'true');

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
      pausePlayer?.(); // don't keep replaying while the drawer is hidden
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
    requestAnimationFrame(() => {
      if (!playerMounted) initPlayer(playerBox); // a live-append refresh may have beaten us here
      desc.focus();
    });
  }

  function closeDrawer(): void {
    destroyPlayer?.();
    closeLightbox();
    for (const undo of drawerCleanup.splice(0)) {
      try {
        undo();
      } catch {
        /* teardown is best-effort — the drawer still closes */
      }
    }
    playerPlayed = false;
    playerMounted = false;
    playerBuiltAtSteps = 0;
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
    // Session replay (contract §Session replay): stringified rrweb events,
    // omitted when empty or over the 8M-char cap (measured after stringify).
    const replayJson = replayEventsField(recorder);
    if (replayJson !== undefined) body.replayEvents = replayJson;

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
