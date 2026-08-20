'use client';

// Session replay player (contracts § Session replay): an rrweb Replayer over
// the recording fetched from /api/replay/[id] (302 → 10-min signed URL; fetch
// follows the redirect). `src` picks which recording — the report's own
// ("Before (the report)", default) or the run's after-the-fix capture
// (?src=after). rrweb is imported DYNAMICALLY inside the effect so it never
// lands in the server bundle. Window-styled card in the same chrome language as
// the preview embed; the recorded viewport is letterboxed and scaled to fit the
// stage.
//
// CONTINUOUS PLAYBACK (contracts § Player UX): the recording plays as real
// footage — the actual site DOM with the cursor moving, clicks landing and
// typing appearing — autoplaying from the top on load. Controls: ▶/⏸, a scrub
// bar, 1×/2× speed and ⟲. The step marks ride a tick rail above the controls
// and the numbered trail list beneath stays synced with the footage; clicking
// either jumps the playback there. While PAUSED a step jump lands on the
// SETTLED frame (`settledOffset()` — `mark.offset + 700ms`, clamped clear of
// the next mark) so the static frame shows the step's EFFECT; while PLAYING it
// seeks to the step's instant and the effect unfolds as footage. When the
// recording outlives the last step, a synthetic trailing "result" mark keeps
// the outcome reachable from the rail.
//
// Navigation: ← / → / Home / End while the card has focus, clicking the LEFT
// third of the stage steps back and the RIGHT third forward (the middle third
// is inert).
//
// Marks come from the recording's own `qa-step` custom events; recordings made
// before markers existed fall back to marks derived from the report's
// click_trail timestamps, and failing that to the plain timeline (scrub bar).
// Malformed or empty recordings get a quiet error note instead of a broken
// player.

import 'rrweb/dist/style.css';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Replayer } from 'rrweb';
import type { ClickTrailEntry } from '@/lib/types';

type Phase = 'loading' | 'ready' | 'error';

/** One seekable step: `offset` ms into the recording. */
interface StepMark {
  offset: number;
  /** 1-based step number as recorded — also the index into the report's click_trail. */
  i: number;
  label: string;
  kind?: string;
  /** The appended final-outcome frame: it has no row in the numbered trail list. */
  synthetic?: boolean;
}

// Progress-poll cadence while the plain-timeline fallback is playing.
const TICK_MS = 100;
// Slack so a mark exactly at the current time counts as reached.
const REACHED_EPS_MS = 1;
// rrweb custom-event type.
const EVENT_TYPE_CUSTOM = 5;
// How long after a step the DOM has had to react — the frame we actually show.
const SETTLE_MS = 700;
// Stay this far clear of the next step so its own frame never leaks in.
const NEXT_GUARD_MS = 50;
// A recording must run at least this long past the last step to earn a final frame.
const RESULT_MIN_TAIL_MS = 500;
// The trailing "result" mark sits this far back from the very end.
const RESULT_BACK_MS = 50;

function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Icon for a step, matching the widget drawer's trail list language. */
function stepIcon(kind: string | undefined, label: string): string {
  if (kind === 'input') return label.startsWith('toggled') ? '☑' : '⌨';
  if (label === 'pressed Enter') return '⏎';
  return '⊕';
}

/** Human label for a click_trail entry (fallback marks) — mirrors the widget's stepView. */
function trailLabel(entry: ClickTrailEntry): string {
  if (entry.kind === 'input') {
    if (entry.value === 'checked' || entry.value === 'unchecked') {
      const name = entry.text ?? entry.testid ?? entry.component ?? 'field';
      return `toggled ${clip(name, 26)} · ${entry.value}`;
    }
    const where = entry.text ?? entry.testid ?? entry.component;
    const typed = `typed "${clip(entry.value ?? '', 32)}"`;
    return where ? `${typed} · ${clip(where, 22)}` : typed;
  }
  if (entry.text === 'pressed Enter') return 'pressed Enter';
  const what = entry.text ?? entry.testid ?? entry.component;
  return what ? `clicked ${clip(what, 44)}` : `went to ${entry.route}`;
}

interface RawEvent {
  type?: unknown;
  timestamp?: unknown;
  data?: { tag?: unknown; payload?: { i?: unknown; kind?: unknown; label?: unknown } };
}

/**
 * Step marks carried by the recording itself: rrweb custom events shaped
 * `{type:5, data:{tag:'qa-step', payload:{i, kind, label}}}` (contracts
 * § Step markers), offset from the first event's timestamp.
 */
export function marksFromEvents(events: unknown[]): StepMark[] {
  const base = (events[0] as RawEvent | undefined)?.timestamp;
  if (typeof base !== 'number') return [];
  const marks: StepMark[] = [];
  for (const raw of events) {
    const ev = raw as RawEvent | null;
    if (!ev || ev.type !== EVENT_TYPE_CUSTOM || typeof ev.timestamp !== 'number') continue;
    if (ev.data?.tag !== 'qa-step') continue;
    const payload = ev.data.payload ?? {};
    const offset = ev.timestamp - base;
    if (!Number.isFinite(offset)) continue;
    const i = typeof payload.i === 'number' ? payload.i : marks.length + 1;
    const label = typeof payload.label === 'string' && payload.label ? payload.label : `step ${i}`;
    marks.push({
      offset: Math.max(0, offset),
      i,
      label,
      ...(typeof payload.kind === 'string' ? { kind: payload.kind } : {}),
    });
  }
  marks.sort((a, b) => a.offset - b.offset);
  return marks;
}

/**
 * Fallback for recordings made before step markers existed: derive marks from
 * the report's click_trail, whose `ts` are wall-clock like the events'. Entries
 * outside the recording window are dropped (the trail can start long before the
 * kept rrweb checkout windows).
 */
export function marksFromTrail(
  steps: readonly ClickTrailEntry[],
  base: number,
  totalTime: number,
): StepMark[] {
  const marks: StepMark[] = [];
  steps.forEach((entry, index) => {
    if (!entry || typeof entry.ts !== 'number') return;
    const offset = entry.ts - base;
    if (!Number.isFinite(offset) || offset < 0 || offset > totalTime) return;
    marks.push({
      offset,
      i: index + 1,
      label: trailLabel(entry),
      ...(entry.kind ? { kind: entry.kind } : {}),
    });
  });
  marks.sort((a, b) => a.offset - b.offset);
  return marks;
}

/** Index of the last mark reached at time `t` (0 when none has been). */
function stepAt(marks: readonly StepMark[], t: number): number {
  let idx = 0;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark && mark.offset <= t + REACHED_EPS_MS) idx = i;
  }
  return idx;
}

/**
 * The time to actually SEEK to for a step — the SETTLED frame, not the instant
 * of the event (contracts § Player UX). Pausing exactly at `mark.offset` freezes
 * the recording before the DOM reacted, so a step captioned `typed "…"` showed
 * an empty field. We give the page `SETTLE_MS` to react, but never cross into
 * the next step (stay `NEXT_GUARD_MS` clear of it) or past the end of the
 * recording, and never move backwards from the step itself.
 */
export function settledOffset(
  marks: readonly StepMark[],
  index: number,
  totalTime: number,
): number {
  const mark = marks[index];
  if (!mark) return 0;
  const next = marks[index + 1];
  const ceiling = next ? Math.min(next.offset - NEXT_GUARD_MS, totalTime) : totalTime;
  return Math.max(mark.offset, Math.min(mark.offset + SETTLE_MS, ceiling));
}

/**
 * Final outcome frame (contracts § Player UX): when the recording keeps running
 * `RESULT_MIN_TAIL_MS` or more past the last step, append a synthetic mark near
 * the very end so the result of that last action — an error banner, a success
 * toast — is always the closing frame. It participates in the rail, autoplay,
 * keys and side-clicks like any other mark, but carries no trail row.
 */
export function withResultMark(marks: readonly StepMark[], totalTime: number): StepMark[] {
  const last = marks[marks.length - 1];
  if (!last || !Number.isFinite(totalTime)) return [...marks];
  if (totalTime - last.offset < RESULT_MIN_TAIL_MS) return [...marks];
  return [
    ...marks,
    {
      offset: Math.max(last.offset, totalTime - RESULT_BACK_MS),
      i: last.i + 1,
      label: 'result',
      synthetic: true,
    },
  ];
}

const CONTROL_BTN =
  'flex-none rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:cursor-not-allowed disabled:opacity-40';

interface ReplayPlayerProps {
  reportId: number;
  /** Which recording to load: the report's own (default) or the run's after-the-fix capture. */
  src?: 'report' | 'after';
  /** Chrome-bar caption — keeps the hero tabs' window language consistent. */
  label?: string;
  /**
   * The report's click_trail — the source of step marks (and their labels) for
   * recordings that predate the `qa-step` custom events.
   */
  steps?: readonly ClickTrailEntry[];
}

export function ReplayPlayer({ reportId, src = 'report', label, steps }: ReplayPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null); // letterbox viewport
  const mountRef = useRef<HTMLDivElement | null>(null); // rrweb root, scaled to fit
  const listRef = useRef<HTMLOListElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const sizeRef = useRef<{ w: number; h: number } | null>(null); // recorded viewport
  const playingRef = useRef(false);
  const marksRef = useRef<StepMark[]>([]);
  // Read inside the load effect only — a later trail edit must not refetch.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const [phase, setPhase] = useState<Phase>('loading');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);
  const [marks, setMarks] = useState<StepMark[]>([]);
  const [stepIndex, setStepIndex] = useState(0);

  // --- load ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let interval: number | null = null;

    // Scale the recorded viewport to fit (never up) and center it — letterbox.
    const fit = () => {
      const stage = stageRef.current;
      const mount = mountRef.current;
      const size = sizeRef.current;
      if (!stage || !mount || !size || size.w <= 0 || size.h <= 0) return;
      if (stage.clientWidth <= 0 || stage.clientHeight <= 0) return; // hidden tab
      const scale = Math.min(stage.clientWidth / size.w, stage.clientHeight / size.h, 1);
      mount.style.width = `${size.w}px`;
      mount.style.height = `${size.h}px`;
      mount.style.transform = `translate(-50%, -50%) scale(${scale})`;
    };

    (async () => {
      try {
        const res = await fetch(`/api/replay/${reportId}${src === 'after' ? '?src=after' : ''}`);
        if (!res.ok) throw new Error(`replay fetch ${res.status}`);
        const events: unknown = await res.json(); // throws on malformed JSON
        if (cancelled) return;
        // rrweb needs a meta + full-snapshot pair at minimum.
        if (!Array.isArray(events) || events.length < 2) throw new Error('empty recording');

        // Dynamic import — rrweb stays out of the server bundle entirely.
        const rrweb = await import('rrweb');
        if (cancelled || !mountRef.current) return;
        type ReplayerEvents = ConstructorParameters<typeof rrweb.Replayer>[0];
        const replayer = new rrweb.Replayer(events as ReplayerEvents, {
          root: mountRef.current,
          mouseTail: false,
          showWarning: false,
          speed: 1,
        });
        replayerRef.current = replayer;

        replayer.on('resize', (payload) => {
          const dim = payload as { width?: number; height?: number } | undefined;
          if (typeof dim?.width === 'number' && typeof dim?.height === 'number') {
            sizeRef.current = { w: dim.width, h: dim.height };
            fit();
          }
        });
        replayer.on('finish', () => {
          playingRef.current = false;
          setPlaying(false);
          const totalTime = replayer.getMetaData().totalTime;
          setCurrent(totalTime);
          if (marksRef.current.length > 0) setStepIndex(marksRef.current.length - 1);
        });

        replayer.pause(0); // first frame, paused (casts the meta event → resize)
        const totalTime = replayer.getMetaData().totalTime;
        setTotal(totalTime);

        // Marks: the recording's own qa-step events, else the report's trail,
        // else none (plain timeline for pre-marker recordings).
        let next = marksFromEvents(events).filter((mark) => mark.offset <= totalTime);
        if (next.length === 0) {
          const base = (events[0] as RawEvent | undefined)?.timestamp;
          const trail = stepsRef.current;
          if (typeof base === 'number' && trail && trail.length > 0) {
            next = marksFromTrail(trail, base, totalTime);
          }
        }
        // …plus the closing "result" frame when the recording outlives the
        // last step, so the outcome of that action is always shown.
        next = withResultMark(next, totalTime);
        marksRef.current = next;
        setMarks(next);
        setStepIndex(0);
        // Autoplay as continuous footage from the very top — the actual site
        // with the tester's cursor, clicks and typing unfolding in real time.
        setCurrent(0);
        replayer.play(0);
        playingRef.current = true;
        setPlaying(true);

        observer = new ResizeObserver(fit);
        if (stageRef.current) observer.observe(stageRef.current);
        interval = window.setInterval(() => {
          const r = replayerRef.current;
          if (!r || !playingRef.current) return;
          const at = Math.min(r.getCurrentTime(), r.getMetaData().totalTime);
          setCurrent(at);
          if (marksRef.current.length > 0) setStepIndex(stepAt(marksRef.current, at));
        }, TICK_MS);
        setPhase('ready');
      } catch {
        if (!cancelled) setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
      observer?.disconnect();
      const r = replayerRef.current;
      replayerRef.current = null;
      playingRef.current = false;
      marksRef.current = [];
      try {
        r?.destroy();
      } catch {
        // already torn down
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per recording
  }, [reportId, src]);

  const stepped = marks.length > 0;
  const currentMark = marks[stepIndex];
  const atFirst = stepIndex <= 0;
  const atLast = stepIndex >= marks.length - 1;

  // Keep the highlighted row visible without ever scrolling the page.
  useEffect(() => {
    const box = listRef.current;
    if (!box) return;
    const row = box.querySelector<HTMLElement>(`[data-step="${stepIndex}"]`);
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }, [stepIndex, marks]);

  /**
   * Jump to a step. While PLAYING: seek to the step's instant and keep playing
   * — the effect unfolds as footage. While PAUSED: land on its SETTLED frame
   * (the step's effect, not the instant of the event).
   */
  const goToStep = (index: number) => {
    const r = replayerRef.current;
    const list = marksRef.current;
    if (!r || list.length === 0) return;
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    const mark = list[clamped];
    if (!mark) return;
    setStepIndex(clamped);
    try {
      if (playingRef.current) {
        setCurrent(mark.offset);
        r.play(mark.offset);
      } else {
        const at = settledOffset(list, clamped, r.getMetaData().totalTime);
        setCurrent(at);
        r.pause(at);
      }
    } catch {
      // a malformed event mid-recording — keep the last good frame
    }
  };

  const togglePlay = () => {
    const r = replayerRef.current;
    if (!r) return;
    if (playingRef.current) {
      r.pause();
      playingRef.current = false;
      setPlaying(false);
      setCurrent(r.getCurrentTime());
      return;
    }
    const totalTime = r.getMetaData().totalTime;
    const at = current >= totalTime ? 0 : current;
    setCurrent(at);
    r.play(at);
    playingRef.current = true;
    setPlaying(true);
  };

  const seek = (t: number) => {
    const r = replayerRef.current;
    if (!r) return;
    setCurrent(t);
    if (marksRef.current.length > 0) setStepIndex(stepAt(marksRef.current, t));
    if (playingRef.current) r.play(t);
    else r.pause(t);
  };

  const toggleSpeed = () => {
    const next = speed === 1 ? 2 : 1;
    setSpeed(next);
    const r = replayerRef.current;
    if (!r) return;
    r.setConfig({ speed: next });
    if (playingRef.current) r.play(r.getCurrentTime()); // re-arm the timer at the new speed
  };

  const restart = () => {
    const r = replayerRef.current;
    if (!r) return;
    setStepIndex(0);
    setCurrent(0);
    r.play(0);
    playingRef.current = true;
    setPlaying(true);
  };

  // ← / → step, Home/End jump — ONLY while this card holds focus, and never
  // stolen from a field inside it, so the rest of the page keeps its keys.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (phase !== 'ready' || !stepped) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
        goToStep(stepIndex - 1);
        break;
      case 'ArrowRight':
        goToStep(stepIndex + 1);
        break;
      case 'Home':
        goToStep(0);
        break;
      case 'End':
        goToStep(marks.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="group"
      aria-label="Session replay — arrow keys step through the recording"
      className="overflow-hidden rounded-[10px] border border-line bg-stage focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-qa-bright"
    >
      {/* Browser-window chrome bar — same language as the preview embed. */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2.5 py-1.5">
        <span className="flex flex-none items-center gap-1" aria-hidden>
          <span className="size-2 rounded-full bg-red/40" />
          <span className="size-2 rounded-full bg-amber/40" />
          <span className="size-2 rounded-full bg-green/40" />
        </span>
        <span className="min-w-0 flex-1 truncate rounded-md border border-line-soft bg-stage px-2 py-0.5 font-mono text-[10.5px] text-ink-3">
          {label ?? (src === 'after' ? 'after the fix · replayed on the preview build' : 'before · what the tester saw')}
        </span>
        {phase === 'ready' ? (
          <span className="flex-none font-mono text-[10.5px] tabular-nums text-ink-3">
            {formatClock(total)}
          </span>
        ) : null}
      </div>

      {/* Letterboxed stage — same hero sizing as the preview embed. */}
      <div
        ref={stageRef}
        className="relative aspect-video w-full overflow-hidden bg-paper md:min-h-[460px]"
      >
        <div
          ref={mountRef}
          className="absolute left-1/2 top-1/2"
          style={{ transform: 'translate(-50%, -50%)' }}
        />

        {/* Side-click navigation: left third back, right third forward, inert middle. */}
        {phase === 'ready' && stepped ? (
          <>
            <button
              type="button"
              onClick={() => goToStep(stepIndex - 1)}
              disabled={atFirst}
              aria-label="Previous step"
              className="group absolute inset-y-0 left-0 w-1/3 cursor-pointer disabled:cursor-default"
            >
              <span className="absolute inset-0 bg-gradient-to-r from-ink/[0.07] to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-disabled:opacity-0" />
              <span className="absolute left-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full bg-stage/85 text-[13px] leading-none text-ink-2 opacity-0 shadow-card transition-opacity group-hover:opacity-100 group-disabled:opacity-0">
                ‹
              </span>
            </button>
            <div className="pointer-events-auto absolute inset-y-0 left-1/3 w-1/3" aria-hidden />
            <button
              type="button"
              onClick={() => goToStep(stepIndex + 1)}
              disabled={atLast}
              aria-label="Next step"
              className="group absolute inset-y-0 right-0 w-1/3 cursor-pointer disabled:cursor-default"
            >
              <span className="absolute inset-0 bg-gradient-to-l from-ink/[0.07] to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-disabled:opacity-0" />
              <span className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full bg-stage/85 text-[13px] leading-none text-ink-2 opacity-0 shadow-card transition-opacity group-hover:opacity-100 group-disabled:opacity-0">
                ›
              </span>
            </button>
          </>
        ) : null}

        {phase === 'loading' ? (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-ink-3">
            <span className="flex items-center gap-2">
              <span className="spinner" aria-hidden />
              loading replay…
            </span>
          </div>
        ) : null}
        {phase === 'error' ? (
          <div
            role="status"
            className="absolute inset-0 grid place-items-center px-4 text-center text-[12px] text-ink-3"
          >
            The session recording couldn&apos;t be loaded — it may be missing or malformed.
          </div>
        ) : null}
      </div>

      {stepped ? (
        <>
          {/* Rail (position + jump) with the slideshow controls beside it. */}
          <div className="flex items-center gap-2 border-t border-line bg-surface px-2.5 py-1.5">
            <div
              className="flex min-w-0 flex-1 items-center gap-[3px] overflow-x-auto"
              role="group"
              aria-label="Steps"
            >
              {marks.map((mark, index) => (
                <button
                  key={`${mark.i}-${mark.offset}-${index}`}
                  type="button"
                  onClick={() => goToStep(index)}
                  title={`${index + 1} · ${mark.label}`}
                  aria-label={`Step ${index + 1} of ${marks.length} — ${mark.label}`}
                  aria-current={index === stepIndex ? 'true' : undefined}
                  className="group min-w-[6px] flex-1 cursor-pointer py-1"
                >
                  <span
                    className={`block h-[5px] w-full rounded-full transition-colors ${
                      index === stepIndex
                        ? 'bg-qa'
                        : 'border border-line-soft bg-transparent group-hover:border-qa-bright'
                    }`}
                  />
                </button>
              ))}
            </div>
            <span className="sr-only" aria-live="polite">
              {currentMark ? `Step ${stepIndex + 1} of ${marks.length} — ${currentMark.label}` : ''}
            </span>
          </div>

          {/* Transport — the footage's own controls: play/pause, scrub, speed. */}
          <div className="flex items-center gap-2 border-t border-line bg-surface px-2.5 py-1.5">
            <button
              type="button"
              onClick={togglePlay}
              disabled={phase !== 'ready'}
              title={playing ? 'Pause' : 'Play'}
              aria-label={playing ? 'Pause replay' : 'Play replay'}
              className={CONTROL_BTN}
            >
              {playing ? '⏸' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(total, 1)}
              step={100}
              value={Math.min(current, Math.max(total, 1))}
              onChange={(event) => seek(Number(event.currentTarget.value))}
              disabled={phase !== 'ready'}
              aria-label="Replay progress"
              className="min-w-0 flex-1 accent-qa"
            />
            <span className="flex-none font-mono text-[10.5px] tabular-nums text-ink-3">
              {formatClock(current)} / {formatClock(total)}
            </span>
            <button
              type="button"
              onClick={toggleSpeed}
              disabled={phase !== 'ready'}
              aria-label={`Playback speed ${speed}x — click to switch`}
              className={CONTROL_BTN}
            >
              {speed}×
            </button>
            <button
              type="button"
              onClick={restart}
              disabled={phase !== 'ready'}
              title="Replay from the top"
              aria-label="Replay from the top"
              className={CONTROL_BTN}
            >
              ⟲
            </button>
          </div>

          {/* The numbered trail — one control with the video: clicking a row seeks. */}
          <ol
            ref={listRef}
            className="relative max-h-[140px] overflow-y-auto border-t border-line bg-surface"
          >
            {marks.map((mark, index) => (
              <li key={`row-${mark.i}-${mark.offset}-${index}`} data-step={index}>
                <button
                  type="button"
                  onClick={() => goToStep(index)}
                  aria-current={index === stepIndex ? 'step' : undefined}
                  className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11.5px] transition-colors ${
                    index === stepIndex ? 'bg-qa-soft text-qa' : 'text-ink-2 hover:bg-line-soft'
                  }`}
                >
                  <span className="w-4 flex-none text-right font-mono text-[10.5px] tabular-nums text-ink-3">
                    {index + 1}
                  </span>
                  <span className="flex-none text-[11px]" aria-hidden>
                    {stepIcon(mark.kind, mark.label)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{mark.label}</span>
                  <span className="flex-none font-mono text-[10px] tabular-nums text-ink-3">
                    {formatClock(mark.offset)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : (
        // No step marks anywhere (pre-marker recording without a usable trail):
        // the plain timeline, exactly as before.
        <div className="flex items-center gap-2 border-t border-line bg-surface px-2.5 py-1.5">
          <button
            type="button"
            onClick={togglePlay}
            disabled={phase !== 'ready'}
            aria-label={playing ? 'Pause replay' : 'Play replay'}
            className={CONTROL_BTN}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(total, 1)}
            step={100}
            value={Math.min(current, Math.max(total, 1))}
            onChange={(event) => seek(Number(event.currentTarget.value))}
            disabled={phase !== 'ready'}
            aria-label="Replay progress"
            className="min-w-0 flex-1 accent-qa"
          />
          <span className="flex-none font-mono text-[10.5px] tabular-nums text-ink-3">
            {formatClock(current)} / {formatClock(total)}
          </span>
          <button
            type="button"
            onClick={toggleSpeed}
            disabled={phase !== 'ready'}
            aria-label={`Playback speed ${speed}x — click to switch`}
            className={CONTROL_BTN}
          >
            {speed}×
          </button>
          <button
            type="button"
            onClick={restart}
            disabled={phase !== 'ready'}
            aria-label="Restart replay"
            className={CONTROL_BTN}
          >
            ⟲
          </button>
        </div>
      )}
    </div>
  );
}
