// Step markers ↔ player marks (contracts §Session replay, "Step markers" and
// "Player UX … step-based"). Pure: no rrweb, no DOM — both the recorder side
// (record.ts emits `addCustomEvent('qa-step', {i, kind, label})`) and the player
// side (ui.ts reads them back) agree on the shapes defined here.
//
// A recording carries its own step index inside the event stream, so a player
// never has to guess where the interactions are. Marks are read back from
// `{type: 5, data: {tag: 'qa-step', payload: {i, kind, label}}}` custom events
// at `ev.timestamp - events[0].timestamp`. Recordings made before markers
// existed fall back to offsets derived from the trail entries' own timestamps.

import { stepLabel } from './trail-list';
import type { ClickTrailEntry, StepMark } from './types';

/** rrweb custom-event tag — `addCustomEvent(QA_STEP_TAG, mark)`. */
export const QA_STEP_TAG = 'qa-step';
/** rrweb EventType.Custom. */
const CUSTOM_EVENT = 5;

/** A step the player can park on: `pause(offset)` puts the frame at that interaction. */
export interface PlayerMark {
  /** Milliseconds from the first buffered event. */
  offset: number;
  /** 1-based trail step index (from the marker payload, or the entry's position). */
  i: number;
  /** The short human string the numbered step list renders. */
  label: string;
  /** The trailing "result" frame — no interaction of its own (see withResultMark). */
  synthetic?: boolean;
}

/** How long the page gets to react before we consider a step's frame settled. */
export const SETTLE_MS = 700;
/** Stay clear of the next step so a settled frame never shows the following one. */
const NEXT_GUARD_MS = 50;
/** Only append a closing "result" frame when the recording really outlives the last step. */
const RESULT_MIN_TAIL_MS = 500;
/** How far back from the end the closing frame sits. */
const RESULT_BACK_MS = 50;

/**
 * The time to actually SEEK to for a step — the SETTLED frame, not the instant
 * of the event (contract §Player UX). Pausing exactly at `mark.offset` freezes
 * the recording before the DOM reacted, so a step captioned `typed "…"` showed
 * an empty field. Give the page `SETTLE_MS`, but never cross into the next step
 * or past the end, and never move backwards from the step itself.
 */
export function settledOffset(
  marks: readonly PlayerMark[],
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
 * Final outcome frame (contract §Player UX): when the recording keeps running
 * past the last step, append a synthetic mark near the very end so the result
 * of that last action — an error banner, a success toast — is always the
 * closing frame.
 */
export function withResultMark(marks: readonly PlayerMark[], totalTime: number): PlayerMark[] {
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

/** The bit of an rrweb event the mark reader touches. */
export interface MarkableEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

function baselineOf(events: readonly MarkableEvent[], baseline?: number): number | undefined {
  if (typeof baseline === 'number' && Number.isFinite(baseline)) return baseline;
  const first = events[0];
  return first ? first.timestamp : undefined;
}

/**
 * Marks carried BY the recording: every `qa-step` custom event, in stream order.
 * Malformed payloads are ignored rather than trusted — recordings are display
 * data that may come from an older widget.
 */
export function extractStepMarks(events: readonly MarkableEvent[], baseline?: number): PlayerMark[] {
  const t0 = baselineOf(events, baseline);
  if (t0 === undefined) return [];
  const marks: PlayerMark[] = [];
  for (const event of events) {
    if (!event || event.type !== CUSTOM_EVENT) continue;
    const data = event.data as { tag?: unknown; payload?: unknown } | null | undefined;
    if (!data || data.tag !== QA_STEP_TAG) continue;
    const payload = data.payload as Partial<StepMark> | null | undefined;
    if (!payload || typeof payload.i !== 'number' || typeof payload.label !== 'string') continue;
    marks.push({ offset: Math.max(0, event.timestamp - t0), i: payload.i, label: payload.label });
  }
  return marks;
}

/**
 * Fallback for recordings with no markers: the trail entries' own `ts`, relative
 * to the recording's first event. Steps that predate the buffered window are
 * dropped (negative offsets); later ones clamp to the recording's length.
 */
export function trailMarks(
  entries: readonly ClickTrailEntry[],
  baseline: number,
  totalTime?: number,
): PlayerMark[] {
  const marks: PlayerMark[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry.ts !== 'number') return;
    const raw = entry.ts - baseline;
    if (!Number.isFinite(raw) || raw < 0) return;
    const offset = typeof totalTime === 'number' && Number.isFinite(totalTime) ? Math.min(raw, totalTime) : raw;
    marks.push({ offset, i: index + 1, label: stepLabel(entry) });
  });
  return marks;
}

/**
 * The marks a player should show: the recording's own `qa-step` events when it
 * has any, else the trail-derived fallback. An empty result means "no steps to
 * park on" — the player keeps a plain timeline.
 */
export function playerMarks(
  events: readonly MarkableEvent[],
  trail: readonly ClickTrailEntry[] = [],
  baseline?: number,
  totalTime?: number,
): PlayerMark[] {
  const own = extractStepMarks(events, baseline);
  if (own.length > 0) return own;
  const t0 = baselineOf(events, baseline);
  if (t0 === undefined) return [];
  return trailMarks(trail, t0, totalTime);
}

/** Clamp a step index into 0…total-1 (−1 when there are no steps) — stepping never wraps. */
export function clampStep(index: number, total: number): number {
  if (total <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return Math.min(total - 1, Math.max(0, Math.trunc(index)));
}

/**
 * The mark to park on for a 1-based trail step (a click in the numbered list):
 * the exact one, else the last mark at or before it — a recording whose buffered
 * window starts mid-session simply parks on its own first frame.
 */
export function markForStep(marks: readonly PlayerMark[], step: number): number {
  if (marks.length === 0) return -1;
  let best = -1;
  for (let k = 0; k < marks.length; k++) {
    const mark = marks[k];
    if (!mark) continue;
    if (mark.i === step) return k;
    if (mark.i < step) best = k;
  }
  return best === -1 ? 0 : best;
}

/**
 * `Step N of M · <label>` — the accessible name of a tick on the rail. There is
 * no caption row any more (contract "Player UX": no `N / M · label` row) — the
 * rail is the position indicator and the highlighted trail row is the caption,
 * so this string is the only place the numbering is spelled out, for
 * screen-reader users.
 */
export function stepAriaLabel(marks: readonly PlayerMark[], index: number): string {
  const at = clampStep(index, marks.length);
  const mark = at >= 0 ? marks[at] : undefined;
  return mark ? `Step ${at + 1} of ${marks.length} · ${mark.label}` : '';
}
