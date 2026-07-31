// The drawer's LIVE step list (contract §Widget drawer replay-first): steps
// recorded while the drawer is open must append without rebuilding the rows
// already on screen, flash briefly, keep the header count honest, and only
// auto-scroll when the tester was already following the newest step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrailList, isNearBottom, stepIcon, stepLabel, stepView } from '../src/trail-list';
import type { ClickTrailEntry } from '../src/types';

let ts = 1000;
const click = (text: string): ClickTrailEntry => ({ ts: ts++, route: '/labs', kind: 'click', text });
const route = (path: string): ClickTrailEntry => ({ ts: ts++, route: path });
const typed = (value: string, text = 'Notes'): ClickTrailEntry => ({
  ts: ts++,
  route: '/labs',
  kind: 'input',
  text,
  value,
});

const labels = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll('li.replay-step .rs-lbl')).map((n) => n.textContent ?? '');
const numbers = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll('li.replay-step .rs-num')).map((n) => n.textContent ?? '');
const rows = (el: HTMLElement): HTMLElement[] =>
  Array.from(el.querySelectorAll('li.replay-step')) as HTMLElement[];

// Default the geometry seam to "following the newest step" — jsdom has no layout.
const following = { nearBottom: () => true, reducedMotion: false } as const;

describe('stepView — icons and labels', () => {
  it('renders clicks, Enter presses, typing, toggles and route markers', () => {
    expect(stepView(click('Save'))).toEqual({ icon: '⊕', label: 'Save' });
    expect(stepView(click('pressed Enter'))).toEqual({ icon: '⏎', label: 'pressed Enter' });
    expect(stepView(typed('hello', 'Notes'))).toEqual({ icon: '⌨', label: 'typed "hello" · Notes' });
    expect(stepView({ ts: 1, route: '/x', kind: 'input', text: 'Agree', value: 'checked' })).toEqual({
      icon: '☑',
      label: 'toggled Agree · checked',
    });
    expect(stepView(route('/labs/7'))).toEqual({ icon: '→', label: '/labs/7' });
  });

  it('is composed from stepIcon + stepLabel — the label the marker payload carries', () => {
    for (const entry of [click('Save'), click('pressed Enter'), typed('hi'), route('/labs/7')]) {
      expect(stepView(entry)).toEqual({ icon: stepIcon(entry), label: stepLabel(entry) });
    }
  });
});

// Two-way sync with the mini player (contract "Player UX"): row → player via
// onPick, player → row via setActive.
describe('createTrailList — list ↔ player sync', () => {
  it('reports the 0-based row index when a row is clicked', () => {
    const picks: number[] = [];
    const list = createTrailList([click('Open'), click('Save'), route('/labs/7')], {
      ...following,
      onPick: (i) => picks.push(i),
    });
    rows(list.el)[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    rows(list.el)[2]?.querySelector('.rs-lbl')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picks).toEqual([1, 2]);
  });

  it('picks rows appended live, with no rebinding', () => {
    const a = click('Open');
    const picks: number[] = [];
    const list = createTrailList([a], { ...following, onPick: (i) => picks.push(i) });
    list.sync([a, click('Save')]);
    rows(list.el)[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picks).toEqual([1]);
  });

  it('ignores clicks on the empty-state row and stops after dispose()', () => {
    const picks: number[] = [];
    const list = createTrailList([], { ...following, onPick: (i) => picks.push(i) });
    list.el.querySelector('.replay-empty')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picks).toEqual([]);

    const a = click('Open');
    const live = createTrailList([a], { ...following, onPick: (i) => picks.push(i) });
    live.dispose();
    rows(live.el)[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picks).toEqual([]);
  });

  it('highlights exactly one row and reports it', () => {
    const list = createTrailList([click('Open'), click('Save'), click('Send')], following);
    expect(list.active()).toBe(-1);
    list.setActive(1);
    expect(list.active()).toBe(1);
    expect(rows(list.el).map((li) => li.classList.contains('active'))).toEqual([false, true, false]);
    list.setActive(2);
    expect(rows(list.el).map((li) => li.classList.contains('active'))).toEqual([false, false, true]);
  });

  it('clears the highlight on null or an out-of-range index', () => {
    const list = createTrailList([click('Open'), click('Save')], following);
    list.setActive(1);
    list.setActive(null);
    expect(list.active()).toBe(-1);
    list.setActive(9);
    expect(list.active()).toBe(-1);
    expect(rows(list.el).some((li) => li.classList.contains('active'))).toBe(false);
  });

  it('keeps the highlight on the same row while new steps append', () => {
    const a = click('Open');
    const b = click('Save');
    const list = createTrailList([a, b], following);
    list.setActive(0);
    list.sync([a, b, click('Send'), click('Done')]);
    expect(list.active()).toBe(0);
    expect(rows(list.el).map((li) => li.classList.contains('active'))).toEqual([true, false, false, false]);
  });

  it('marks the list pickable only when a picker is wired', () => {
    expect(createTrailList([], following).el.classList.contains('pickable')).toBe(false);
    expect(createTrailList([], { ...following, onPick: () => undefined }).el.classList.contains('pickable')).toBe(
      true,
    );
  });
});

describe('isNearBottom — "don\'t yank the view" rule', () => {
  it('is true at the bottom and within the slack, false once scrolled up', () => {
    expect(isNearBottom({ scrollTop: 320, scrollHeight: 500, clientHeight: 180 })).toBe(true);
    expect(isNearBottom({ scrollTop: 290, scrollHeight: 500, clientHeight: 180 })).toBe(true); // 30px slack
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 500, clientHeight: 180 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true); // empty list
  });
});

describe('createTrailList — initial render', () => {
  it('renders every entry numbered from 1', () => {
    const list = createTrailList([click('Open'), typed('abc'), route('/labs/7')], following);
    expect(numbers(list.el)).toEqual(['1', '2', '3']);
    expect(labels(list.el)).toEqual(['Open', 'typed "abc" · Notes', '/labs/7']);
    expect(list.count()).toBe(3);
  });

  it('shows an empty state with no steps, and no flash on the initial rows', () => {
    const list = createTrailList([], following);
    expect(list.count()).toBe(0);
    expect(list.el.querySelector('.replay-empty')).not.toBeNull();

    const filled = createTrailList([click('Open')], following);
    expect(rows(filled.el)[0]?.classList.contains('fresh')).toBe(false);
  });
});

describe('createTrailList — live append', () => {
  it('appends ONLY the new steps and leaves the existing rows untouched', () => {
    const a = click('Open');
    const b = typed('ab');
    const list = createTrailList([a, b], following);
    const before = rows(list.el);

    const c = click('Save');
    const result = list.sync([a, b, c]);

    expect(result.added).toBe(1);
    expect(result.total).toBe(3);
    expect(list.count()).toBe(3);
    const after = rows(list.el);
    expect(after[0]).toBe(before[0]); // same nodes — no re-render thrash
    expect(after[1]).toBe(before[1]);
    expect(labels(list.el)).toEqual(['Open', 'typed "ab" · Notes', 'Save']);
    expect(numbers(list.el)).toEqual(['1', '2', '3']);
  });

  it('is a no-op when nothing changed', () => {
    const entries = [click('Open')];
    const list = createTrailList(entries, following);
    const before = rows(list.el);
    const result = list.sync(entries.slice());
    expect(result).toMatchObject({ added: 0, updated: false, total: 1 });
    expect(rows(list.el)).toEqual(before);
  });

  it('fills an empty list once the first step arrives', () => {
    const list = createTrailList([], following);
    const result = list.sync([click('Open')]);
    expect(result.added).toBe(1);
    expect(list.el.querySelector('.replay-empty')).toBeNull();
    expect(labels(list.el)).toEqual(['Open']);
  });

  it('appends several steps at once (one debounced wake-up, a burst of steps)', () => {
    const a = click('Open');
    const list = createTrailList([a], following);
    const result = list.sync([a, click('Save'), typed('note'), route('/labs/7')]);
    expect(result.added).toBe(3);
    expect(numbers(list.el)).toEqual(['1', '2', '3', '4']);
    expect(list.count()).toBe(4);
  });
});

describe('createTrailList — coalesced updates', () => {
  it('repaints the newest row instead of appending one', () => {
    const first = click('Open');
    const entry = typed('ab');
    const list = createTrailList([first, entry], following);
    const before = rows(list.el);

    entry.value = 'abcd'; // same object, mutated in place by buffers
    const result = list.sync([first, entry]);

    expect(result.added).toBe(0);
    expect(result.updated).toBe(true);
    expect(rows(list.el)).toEqual(before); // same nodes
    expect(labels(list.el)).toEqual(['Open', 'typed "abcd" · Notes']);
    expect(list.count()).toBe(2);
  });
});

describe('createTrailList — auto-scroll', () => {
  it('scrolls to the newest step when already near the bottom', () => {
    const a = click('Open');
    const list = createTrailList([a], { nearBottom: () => true });
    expect(list.sync([a, click('Save')]).scrolled).toBe(true);
  });

  it('does NOT scroll when the tester scrolled up — the step still appends', () => {
    const a = click('Open');
    const list = createTrailList([a], { nearBottom: () => false });
    const result = list.sync([a, click('Save')]);
    expect(result.scrolled).toBe(false);
    expect(result.added).toBe(1);
    expect(labels(list.el)).toEqual(['Open', 'Save']);
  });
});

describe('createTrailList — flash (prefers-reduced-motion)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flashes appended rows and clears the class afterwards', () => {
    const a = click('Open');
    const list = createTrailList([a], following);
    list.sync([a, click('Save')]);
    const fresh = rows(list.el)[1];
    expect(fresh?.classList.contains('fresh')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(fresh?.classList.contains('fresh')).toBe(false);
  });

  it('never flashes under prefers-reduced-motion', () => {
    const a = click('Open');
    const list = createTrailList([a], { reducedMotion: true, nearBottom: () => true });
    list.sync([a, click('Save')]);
    expect(rows(list.el)[1]?.classList.contains('fresh')).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // nothing scheduled at all
  });

  it('dispose() clears pending flash timers', () => {
    const a = click('Open');
    const list = createTrailList([a], following);
    list.sync([a, click('Save')]);
    expect(vi.getTimerCount()).toBe(1);
    list.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createTrailList — ring eviction', () => {
  it('rebuilds and renumbers when the trail ring drops entries from the head', () => {
    const a = click('one');
    const b = click('two');
    const c = click('three');
    const list = createTrailList([a, b, c], following);

    const d = click('four'); // the ring evicted `a` and appended `d`
    const result = list.sync([b, c, d]);

    expect(labels(list.el)).toEqual(['two', 'three', 'four']);
    expect(numbers(list.el)).toEqual(['1', '2', '3']);
    expect(list.count()).toBe(3);
    expect(result.total).toBe(3);
  });

  it('rebuilds when the rendered tail is gone entirely', () => {
    const list = createTrailList([click('one'), click('two')], following);
    const fresh = [click('x'), click('y'), click('z')];
    list.sync(fresh);
    expect(labels(list.el)).toEqual(['x', 'y', 'z']);
    expect(list.count()).toBe(3);
  });
});
