// Step markers and the keyframe player's mark model (contracts §Session
// replay, "Step markers" + "Player UX … KEYFRAME slideshow"). Everything here
// is pure: no rrweb, no Replayer — synthetic event arrays in, marks out.

import { describe, expect, it, vi } from 'vitest';
import { startBuffers } from '../src/buffers';
import {
  stepAriaLabel,
  clampStep,
  extractStepMarks,
  markForStep,
  playerMarks,
  trailMarks,
  QA_STEP_TAG,
  type MarkableEvent,
} from '../src/marks';
import { startReplay } from '../src/replay';
import { stepKind, stepLabel, stepView } from '../src/trail-list';
import type { ClickTrailEntry, StepMark } from '../src/types';

const T0 = 1_000_000;

/** An rrweb `qa-step` custom event, exactly as record.ts emits it. */
const markEvent = (at: number, payload: unknown): MarkableEvent => ({
  type: 5,
  timestamp: T0 + at,
  data: { tag: QA_STEP_TAG, payload },
});
const meta = (at = 0): MarkableEvent => ({ type: 4, timestamp: T0 + at, data: {} });
const snap = (at = 1): MarkableEvent => ({ type: 2, timestamp: T0 + at, data: {} });
const inc = (at: number): MarkableEvent => ({ type: 3, timestamp: T0 + at, data: { source: 0 } });

const click = (text: string, ts = T0): ClickTrailEntry => ({ ts, route: '/labs', kind: 'click', text });

describe('stepLabel — one source of truth for list rows and marker payloads', () => {
  const cases: ClickTrailEntry[] = [
    { ts: 1, route: '/labs', kind: 'click', text: 'Save' },
    { ts: 2, route: '/labs', kind: 'click', text: 'pressed Enter' },
    { ts: 3, route: '/labs', kind: 'input', text: 'Notes', value: 'hello' },
    { ts: 4, route: '/labs', kind: 'input', text: 'Agree', value: 'checked' },
    { ts: 5, route: '/labs', kind: 'input', value: 'no label' },
    { ts: 6, route: '/labs', kind: 'click', testid: 'row-7' },
    { ts: 7, route: '/labs/7' },
  ];

  it('is exactly the string the drawer list renders in .rs-lbl', () => {
    for (const entry of cases) expect(stepLabel(entry)).toBe(stepView(entry).label);
  });

  it('is what buffers puts in the marker payload for every pushed step', () => {
    const marks: StepMark[] = [];
    document.body.innerHTML = '<button id="save">Save</button><input id="notes" aria-label="Notes" />';
    const buffers = startBuffers();
    buffers.setStepSink((mark) => marks.push(mark));
    try {
      document.querySelector('#save')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const trail = buffers.clickTrail();
      const pushed = trail[trail.length - 1];
      const mark = marks[marks.length - 1];
      expect(pushed).toBeDefined();
      expect(mark).toEqual({ i: trail.length, kind: 'click', label: stepLabel(pushed!) });
      expect(mark!.label).toBe(stepView(pushed!).label);
    } finally {
      buffers.dispose();
      document.body.innerHTML = '';
    }
  });

  it('is what the replay engine puts in the marker payload for the step it executes', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<button data-testid="go">Go</button>';
      const container = document.createElement('div');
      document.body.appendChild(container);
      const entry: ClickTrailEntry = { ts: 1, route: location.pathname, kind: 'click', testid: 'go', text: 'Go' };
      const marks: StepMark[] = [];
      const handle = startReplay(
        { route: location.pathname, trail: [entry] },
        { container, reducedMotion: true, onStep: (mark) => marks.push(mark) },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await handle.done;
      expect(marks).toEqual([{ i: 1, kind: 'click', label: stepLabel(entry) }]);
    } finally {
      vi.useRealTimers();
      document.body.innerHTML = '';
    }
  });
});

describe('stepKind — route markers vs clicks vs inputs', () => {
  it('reads the entry kind, and calls a metadata-less entry a route marker', () => {
    expect(stepKind({ ts: 1, route: '/labs', kind: 'click', text: 'Save' })).toBe('click');
    expect(stepKind({ ts: 1, route: '/labs', kind: 'input', value: 'x' })).toBe('input');
    expect(stepKind({ ts: 1, route: '/labs/7' })).toBe('route');
    // legacy trails recorded no `kind` — metadata still makes it a click
    expect(stepKind({ ts: 1, route: '/labs', testid: 'row-7' })).toBe('click');
  });
});

describe('extractStepMarks — marks the recording carries itself', () => {
  it('reads qa-step custom events at ev.timestamp - events[0].timestamp', () => {
    const events = [
      meta(),
      snap(),
      markEvent(120, { i: 1, kind: 'route', label: '/labs' }),
      inc(200),
      markEvent(1_500, { i: 2, kind: 'click', label: 'Save' }),
      markEvent(4_000, { i: 3, kind: 'input', label: 'typed "hi" · Notes' }),
    ];
    expect(extractStepMarks(events)).toEqual([
      { offset: 120, i: 1, label: '/labs' },
      { offset: 1_500, i: 2, label: 'Save' },
      { offset: 4_000, i: 3, label: 'typed "hi" · Notes' },
    ]);
  });

  it('honours an explicit baseline (the offsets the mounted Replayer was built on)', () => {
    const events = [markEvent(900, { i: 5, kind: 'click', label: 'Save' })];
    expect(extractStepMarks(events, T0)).toEqual([{ offset: 900, i: 5, label: 'Save' }]);
  });

  it('never returns a negative offset', () => {
    const events = [meta(500), markEvent(0, { i: 1, kind: 'click', label: 'Early' })];
    expect(extractStepMarks(events)).toEqual([{ offset: 0, i: 1, label: 'Early' }]);
  });

  it('ignores non-custom events, other tags and malformed payloads', () => {
    const events: MarkableEvent[] = [
      meta(),
      snap(),
      { type: 5, timestamp: T0 + 10, data: { tag: 'other', payload: { i: 1, label: 'nope' } } },
      { type: 5, timestamp: T0 + 20, data: { tag: QA_STEP_TAG, payload: { label: 'no index' } } },
      { type: 5, timestamp: T0 + 30, data: { tag: QA_STEP_TAG, payload: { i: 2 } } },
      { type: 5, timestamp: T0 + 40, data: { tag: QA_STEP_TAG } },
      { type: 5, timestamp: T0 + 50, data: null },
      markEvent(60, { i: 3, kind: 'click', label: 'Real' }),
    ];
    expect(extractStepMarks(events)).toEqual([{ offset: 60, i: 3, label: 'Real' }]);
  });

  it('returns nothing for an empty recording', () => {
    expect(extractStepMarks([])).toEqual([]);
  });
});

describe('trailMarks — the fallback for marker-less recordings', () => {
  it('derives offsets from the trail timestamps, numbering from 1', () => {
    const trail = [click('Open', T0 + 200), click('Save', T0 + 3_000)];
    expect(trailMarks(trail, T0)).toEqual([
      { offset: 200, i: 1, label: 'Open' },
      { offset: 3_000, i: 2, label: 'Save' },
    ]);
  });

  it('drops steps that predate the buffered window and clamps late ones into range', () => {
    const trail = [click('Before', T0 - 5_000), click('Inside', T0 + 1_000), click('After', T0 + 90_000)];
    expect(trailMarks(trail, T0, 10_000)).toEqual([
      { offset: 1_000, i: 2, label: 'Inside' },
      { offset: 10_000, i: 3, label: 'After' },
    ]);
  });
});

describe('playerMarks — markers first, trail second, plain timeline last', () => {
  const trail = [click('Open', T0 + 200), click('Save', T0 + 900)];

  it('prefers the recording own markers and ignores the trail entirely', () => {
    const events = [meta(), snap(), markEvent(500, { i: 4, kind: 'click', label: 'Marked' })];
    expect(playerMarks(events, trail)).toEqual([{ offset: 500, i: 4, label: 'Marked' }]);
  });

  it('falls back to the trail when the recording has no markers', () => {
    const events = [meta(), snap(), inc(300)];
    expect(playerMarks(events, trail)).toEqual([
      { offset: 200, i: 1, label: 'Open' },
      { offset: 900, i: 2, label: 'Save' },
    ]);
  });

  it('yields nothing (plain timeline) when neither markers nor usable trail exist', () => {
    expect(playerMarks([meta(), snap()], [])).toEqual([]);
    expect(playerMarks([], trail)).toEqual([]); // no recording → no baseline
    expect(playerMarks([meta(1_000), snap(1_001)], [click('Old', T0 - 1)])).toEqual([]);
  });
});

describe('clampStep — stepping never wraps', () => {
  it('clamps at both ends and reports -1 with no steps', () => {
    expect(clampStep(0 - 1, 5)).toBe(0); // ← on step 1 stays on step 1
    expect(clampStep(4 + 1, 5)).toBe(4); // → on the last step stays there
    expect(clampStep(2, 5)).toBe(2);
    expect(clampStep(99, 5)).toBe(4);
    expect(clampStep(-99, 5)).toBe(0);
    expect(clampStep(0, 0)).toBe(-1);
    expect(clampStep(Number.NaN, 3)).toBe(0);
  });

  it('walks a whole recording forward and back without overshooting', () => {
    const total = 3;
    let cur = 0;
    for (let i = 0; i < 10; i++) cur = clampStep(cur + 1, total);
    expect(cur).toBe(2);
    for (let i = 0; i < 10; i++) cur = clampStep(cur - 1, total);
    expect(cur).toBe(0);
  });
});

describe('markForStep — list row → mark (two-way sync)', () => {
  const marks = [
    { offset: 0, i: 1, label: 'a' },
    { offset: 10, i: 3, label: 'b' },
    { offset: 20, i: 7, label: 'c' },
  ];

  it('finds the exact mark for a step that has one', () => {
    expect(markForStep(marks, 1)).toBe(0);
    expect(markForStep(marks, 3)).toBe(1);
    expect(markForStep(marks, 7)).toBe(2);
  });

  it('falls back to the last mark at or before the step', () => {
    expect(markForStep(marks, 5)).toBe(1);
    expect(markForStep(marks, 99)).toBe(2);
  });

  it('parks on the first mark for steps that predate the buffered window', () => {
    expect(markForStep([{ offset: 0, i: 40, label: 'late' }], 2)).toBe(0);
  });

  it('reports -1 when there is nothing to park on', () => {
    expect(markForStep([], 3)).toBe(-1);
  });
});

// There is no caption ROW any more (contract: no `N / M · label`) — the rail is
// the position indicator, so the numbering survives only as each tick's
// accessible name.
describe('stepAriaLabel — the tick rail is the position indicator', () => {
  const marks = [
    { offset: 0, i: 1, label: '/labs' },
    { offset: 900, i: 2, label: 'Save' },
  ];

  it('numbers by position in the mark list', () => {
    expect(stepAriaLabel(marks, 0)).toBe('Step 1 of 2 · /labs');
    expect(stepAriaLabel(marks, 1)).toBe('Step 2 of 2 · Save');
  });

  it('clamps out-of-range indexes and is empty with no marks', () => {
    expect(stepAriaLabel(marks, 9)).toBe('Step 2 of 2 · Save');
    expect(stepAriaLabel([], 0)).toBe('');
  });
});
