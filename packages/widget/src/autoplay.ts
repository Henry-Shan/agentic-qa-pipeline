// Autoplay for the drawer's keyframe slideshow (contracts §Session replay,
// "Player UX … Autoplay by default").
//
// The player opens on step 1 and walks to the last step on its own, one step
// every ~1.8s (glide + dwell), then stops. It NEVER loops and never runs past
// the end. Any manual navigation — keys, side-click, rail tick, trail row —
// pauses it; ▶/⏸ toggles it (▶ on the last step restarts from step 1, which is
// also what ⟲ does).
//
// The host is injected so this is testable with fake timers and carries no DOM.

/** ~1.8s per step: the 450ms cursor glide plus dwell on the frame. */
export const AUTOPLAY_STEP_MS = 1_800;

export interface AutoplayHost {
  /** Current 0-based step index (−1 when there are no steps). */
  index(): number;
  /** Number of steps available right now — may GROW while playing (live append). */
  total(): number;
  /** Park the player on a step (the same seek manual navigation uses). */
  go(index: number): void;
  /** Playing state changed — repaint ▶/⏸. */
  onChange?(playing: boolean): void;
}

export interface Autoplay {
  playing(): boolean;
  /** Start advancing. On the last step it restarts from step 1 (never loops mid-run). */
  start(): void;
  /** Stop advancing — used by ⏸ and by every manual navigation. */
  stop(): void;
  toggle(): void;
  /** Jump to step 1 and play from there (⟲). */
  restart(): void;
  dispose(): void;
}

export function createAutoplay(host: AutoplayHost, stepMs: number = AUTOPLAY_STEP_MS): Autoplay {
  let timer: number | null = null;
  let disposed = false;

  const announce = (playing: boolean): void => {
    try {
      host.onChange?.(playing);
    } catch {
      /* a painter must never break playback */
    }
  };

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    announce(false);
  }

  /**
   * One beat. Stopping is LAZY — we stop when there is nothing left to advance
   * to, not on arrival at the last step, so steps appended while autoplay runs
   * (contract: live append) are walked into instead of orphaned.
   */
  function tick(): void {
    const next = host.index() + 1;
    if (next >= host.total()) {
      stop();
      return;
    }
    host.go(next);
  }

  function start(): void {
    if (disposed) return;
    const total = host.total();
    if (total <= 0) return;
    if (host.index() >= total - 1) host.go(0); // parked on the end — ▶ replays from step 1
    if (timer !== null) return;
    timer = setInterval(tick, stepMs) as unknown as number;
    announce(true);
  }

  return {
    playing: () => timer !== null,
    start,
    stop,
    toggle: () => (timer !== null ? stop() : start()),
    restart: () => {
      if (disposed || host.total() <= 0) return;
      host.go(0);
      if (timer === null) start();
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
