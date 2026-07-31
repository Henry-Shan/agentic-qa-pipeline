'use client';

// Session replay player (contracts § Session replay): an rrweb Replayer over
// the recording fetched from /api/replay/[id] (302 → 10-min signed URL; fetch
// follows the redirect). `src` picks which recording — the report's own
// ("Before (the report)", default) or the run's after-the-fix capture
// (?src=after). rrweb is imported DYNAMICALLY inside the effect so it never
// lands in the server bundle. Window-styled card in the same chrome language as
// the preview embed; the recorded viewport is letterboxed and scaled to fit the
// stage. Minimal controls: play/pause, progress, 1×/2×, restart — starts paused
// on the first frame. Malformed or empty recordings get a quiet error note
// instead of a broken player.

import 'rrweb/dist/style.css';
import { useEffect, useRef, useState } from 'react';
import type { Replayer } from 'rrweb';

type Phase = 'loading' | 'ready' | 'error';

// Progress-poll cadence while playing.
const TICK_MS = 100;

function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const CONTROL_BTN =
  'flex-none rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:cursor-not-allowed disabled:opacity-40';

interface ReplayPlayerProps {
  reportId: number;
  /** Which recording to load: the report's own (default) or the run's after-the-fix capture. */
  src?: 'report' | 'after';
  /** Chrome-bar caption — keeps the hero tabs' window language consistent. */
  label?: string;
}

export function ReplayPlayer({ reportId, src = 'report', label }: ReplayPlayerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null); // letterbox viewport
  const mountRef = useRef<HTMLDivElement | null>(null); // rrweb root, scaled to fit
  const replayerRef = useRef<Replayer | null>(null);
  const sizeRef = useRef<{ w: number; h: number } | null>(null); // recorded viewport
  const playingRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('loading');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(0);

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
          setCurrent(replayer.getMetaData().totalTime);
        });

        replayer.pause(0); // first frame, paused (casts the meta event → resize)
        setTotal(replayer.getMetaData().totalTime);

        observer = new ResizeObserver(fit);
        if (stageRef.current) observer.observe(stageRef.current);
        interval = window.setInterval(() => {
          const r = replayerRef.current;
          if (!r || !playingRef.current) return;
          setCurrent(Math.min(r.getCurrentTime(), r.getMetaData().totalTime));
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
      try {
        r?.destroy();
      } catch {
        // already torn down
      }
    };
  }, [reportId, src]);

  const togglePlay = () => {
    const r = replayerRef.current;
    if (!r) return;
    if (playingRef.current) {
      r.pause();
      playingRef.current = false;
      setPlaying(false);
      setCurrent(r.getCurrentTime());
    } else {
      const totalTime = r.getMetaData().totalTime;
      const at = current >= totalTime ? 0 : current; // finished → play again
      if (at === 0) setCurrent(0);
      r.play(at);
      playingRef.current = true;
      setPlaying(true);
    }
  };

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
    const r = replayerRef.current;
    if (!r) return;
    setCurrent(0);
    r.play(0);
    playingRef.current = true;
    setPlaying(true);
  };

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-stage">
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

      {/* Minimal controls: play/pause · progress · 1×/2× · restart. */}
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
    </div>
  );
}
