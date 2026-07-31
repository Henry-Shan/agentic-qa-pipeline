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
// STEP-BASED, not scrubbed (contracts § Player UX): the primary controls are
// ◀ Prev / Next ▶ over the recording's step marks, with a caption `N / M ·
// <label>`, a clickable rail of ticks, and the numbered trail as a list that
// seeks. Seeking a step is `pause(offset)`, so the frame is exactly the moment
// of that interaction; the player opens PAUSED on step 1. Continuous playback
// survives only as a small ▶ auto-advance (the 1×/2× control is its speed).
// ← / → / Home / End work when the card itself has focus.
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
  /** 1-based step number as recorded. */
  i: number;
  label: string;
  kind?: string;
}

// Progress-poll cadence while auto-advancing.
const TICK_MS = 100;
// Slack so a mark exactly at the current time counts as reached.
const REACHED_EPS_MS = 1;
// rrweb custom-event type.
const EVENT_TYPE_CUSTOM = 5;

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

const CONTROL_BTN =
  'flex-none rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:cursor-not-allowed disabled:opacity-40';
const STEP_BTN =
  'flex-none rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:cursor-not-allowed disabled:opacity-40';

interface ReplayPlayerProps {
  reportId: number;
  /** Which recording to load: the report's own (default) or the run's after-the-fix capture. */
  src?: 'report' | 'after';
  /** Chrome-bar caption — keeps the hero tabs' window language consistent. */
  label?: string;
  /**
   * The report's click_trail — used ONLY to derive step marks for recordings
   * that predate the `qa-step` custom events.
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
        marksRef.current = next;
        setMarks(next);
        setStepIndex(0);
        const first = next[0];
        if (first) {
          replayer.pause(first.offset); // opens PAUSED on step 1
          setCurrent(first.offset);
        }

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
  }, [reportId, src]);

  const stepped = marks.length > 0;
  const currentMark = marks[stepIndex];

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

  /** Seek a step: `pause(offset)` — the exact frame of that interaction. */
  const seekStep = (index: number) => {
    const r = replayerRef.current;
    const list = marksRef.current;
    if (!r || list.length === 0) return;
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    const mark = list[clamped];
    if (!mark) return;
    playingRef.current = false;
    setPlaying(false);
    setStepIndex(clamped);
    setCurrent(mark.offset);
    r.pause(mark.offset);
  };

  const togglePlay = () => {
    const r = replayerRef.current;
    if (!r) return;
    if (playingRef.current) {
      r.pause();
      playingRef.current = false;
      setPlaying(false);
      const at = r.getCurrentTime();
      setCurrent(at);
      if (marksRef.current.length > 0) setStepIndex(stepAt(marksRef.current, at));
      return;
    }
    const totalTime = r.getMetaData().totalTime;
    // Finished → auto-advance again from the top (step 1 when stepped).
    const restartAt = marksRef.current[0]?.offset ?? 0;
    const at = current >= totalTime ? restartAt : current;
    setCurrent(at);
    if (marksRef.current.length > 0) setStepIndex(stepAt(marksRef.current, at));
    r.play(at);
    playingRef.current = true;
    setPlaying(true);
  };

  // Plain-timeline fallback only (no marks): scrub.
  const seek = (t: number) => {
    const r = replayerRef.current;
    if (!r) return;
    setCurrent(t);
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
    if (stepped) {
      seekStep(0); // back to step 1, paused
      return;
    }
    const r = replayerRef.current;
    if (!r) return;
    setCurrent(0);
    r.play(0);
    playingRef.current = true;
    setPlaying(true);
  };

  // ← / → step, Home/End jump — ONLY while this card holds focus, so the rest
  // of the page keeps its arrow keys.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (phase !== 'ready' || !stepped) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case 'ArrowLeft':
        seekStep(stepIndex - 1);
        break;
      case 'ArrowRight':
        seekStep(stepIndex + 1);
        break;
      case 'Home':
        seekStep(0);
        break;
      case 'End':
        seekStep(marks.length - 1);
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
          {/* Rail — one tick per step, current filled, all clickable. */}
          <div
            className="flex items-center gap-[3px] overflow-x-auto border-t border-line bg-surface px-2.5 pb-1 pt-2"
            role="group"
            aria-label="Steps"
          >
            {marks.map((mark, index) => (
              <button
                key={`${mark.i}-${mark.offset}-${index}`}
                type="button"
                onClick={() => seekStep(index)}
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

          {/* Step-first controls: Prev/Next · caption · auto-advance · speed · restart. */}
          <div className="flex flex-wrap items-center gap-2 bg-surface px-2.5 pb-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => seekStep(stepIndex - 1)}
              disabled={phase !== 'ready' || stepIndex === 0}
              aria-label="Previous step"
              className={STEP_BTN}
            >
              ◀ Prev
            </button>
            <button
              type="button"
              onClick={() => seekStep(stepIndex + 1)}
              disabled={phase !== 'ready' || stepIndex >= marks.length - 1}
              aria-label="Next step"
              className={STEP_BTN}
            >
              Next ▶
            </button>
            <span
              aria-live="polite"
              className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2"
              title={currentMark?.label}
            >
              <span className="font-mono tabular-nums text-ink-3">
                {stepIndex + 1} / {marks.length}
              </span>
              {currentMark ? <> · {currentMark.label}</> : null}
            </span>
            <button
              type="button"
              onClick={togglePlay}
              disabled={phase !== 'ready'}
              title={playing ? 'Pause auto-advance' : 'Auto-advance through the steps'}
              aria-label={playing ? 'Pause auto-advance' : 'Auto-advance through the steps'}
              className={CONTROL_BTN}
            >
              {playing ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              onClick={toggleSpeed}
              disabled={phase !== 'ready'}
              title={`Auto-advance speed ${speed}× — click to switch`}
              aria-label={`Auto-advance speed ${speed}x — click to switch`}
              className={CONTROL_BTN}
            >
              {speed}×
            </button>
            <button
              type="button"
              onClick={restart}
              disabled={phase !== 'ready'}
              title="Back to step 1"
              aria-label="Back to step 1"
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
                  onClick={() => seekStep(index)}
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
