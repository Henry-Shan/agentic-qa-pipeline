// Autoplay for the keyframe slideshow (contracts §Session replay, "Player UX …
// Autoplay by default"): starts on step 1, advances every ~1.8s to the last
// step, stops there, never loops — and ANY manual navigation pauses it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOPLAY_STEP_MS, createAutoplay, type Autoplay } from '../src/autoplay';

/** A player stand-in: holds an index, records every seek autoplay asks for. */
function player(total: number) {
  const state = { index: total > 0 ? 0 : -1, total, seeks: [] as number[], playing: [] as boolean[] };
  const auto: Autoplay = createAutoplay({
    index: () => state.index,
    total: () => state.total,
    go: (i) => {
      state.index = i;
      state.seeks.push(i);
    },
    onChange: (p) => state.playing.push(p),
  });
  return { state, auto };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('autoplay — advance and stop at the end', () => {
  it('walks one step per beat and stops on the last one, without looping', () => {
    const { state, auto } = player(4);
    auto.start();
    expect(auto.playing()).toBe(true);

    vi.advanceTimersByTime(AUTOPLAY_STEP_MS);
    expect(state.index).toBe(1);
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 2);
    expect(state.index).toBe(3); // last step
    expect(state.seeks).toEqual([1, 2, 3]);

    // The beat after the last step finds nothing to advance to: it stops there.
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS);
    expect(auto.playing()).toBe(false);
    expect(state.index).toBe(3);

    // And it never comes back on its own.
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 5);
    expect(state.index).toBe(3);
    expect(state.seeks).toEqual([1, 2, 3]);
  });

  it('advances at ~1.8s, not sooner', () => {
    const { state, auto } = player(3);
    auto.start();
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS - 1);
    expect(state.index).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.index).toBe(1);
  });

  it('reports playing state changes for the ▶/⏸ button', () => {
    const { state, auto } = player(2);
    auto.start();
    expect(state.playing).toEqual([true]);
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 2);
    expect(state.playing).toEqual([true, false]);
  });

  it('does nothing at all with no steps', () => {
    const { state, auto } = player(0);
    auto.start();
    expect(auto.playing()).toBe(false);
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 3);
    expect(state.seeks).toEqual([]);
  });
});

describe('autoplay — manual navigation pauses it', () => {
  it('stops on stop() and never advances again until restarted', () => {
    const { state, auto } = player(5);
    auto.start();
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS);
    expect(state.index).toBe(1);

    auto.stop(); // ← key / side-click / rail tick / trail row
    expect(auto.playing()).toBe(false);
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 4);
    expect(state.index).toBe(1); // the manual position is respected

    auto.start();
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS);
    expect(state.index).toBe(2); // resumes from where the tester left it
  });

  it('toggles both ways and is idempotent', () => {
    const { auto } = player(4);
    auto.toggle();
    expect(auto.playing()).toBe(true);
    auto.start(); // a second start must not double the beat
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS);
    auto.toggle();
    expect(auto.playing()).toBe(false);
    auto.stop();
    expect(auto.playing()).toBe(false);
  });

  it('▶ on the last step replays from step 1 instead of sitting at the end', () => {
    const { state, auto } = player(3);
    state.index = 2;
    auto.start();
    expect(state.index).toBe(0);
    expect(auto.playing()).toBe(true);
  });
});

describe('autoplay — ⟲ restart and live append', () => {
  it('restart parks on step 1 and plays from there', () => {
    const { state, auto } = player(3);
    auto.start();
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 2);
    expect(state.index).toBe(2);

    auto.restart();
    expect(state.index).toBe(0);
    expect(auto.playing()).toBe(true);
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS);
    expect(state.index).toBe(1);
  });

  it('walks into steps appended while it is running', () => {
    const { state, auto } = player(2);
    auto.start();
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS);
    expect(state.index).toBe(1); // the last step, for now

    state.total = 4; // the tester kept clicking — live append
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 2);
    expect(state.index).toBe(3);
    expect(auto.playing()).toBe(true);
  });

  it('dispose stops the beat for good', () => {
    const { state, auto } = player(5);
    auto.start();
    auto.dispose();
    vi.advanceTimersByTime(AUTOPLAY_STEP_MS * 5);
    expect(state.index).toBe(0);
    auto.start();
    expect(auto.playing()).toBe(false);
  });
});
