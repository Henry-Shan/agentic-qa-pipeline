// Session recorder (contracts §Session replay): wraps rrweb `record()` from
// page load, armed alongside the other buffers (same activation gates — it only
// starts when the widget's config resolved). Memory-bounded: checkoutEveryNms
// 60_000 and only the last TWO checkout windows are kept (≈ the final 1-2
// minutes) — on each checkout the window before the previous one is dropped.
//
// IMPORT CHOICE (measured, esbuild --bundle --minify, rrweb 2.1.1):
//   record from 'rrweb'                 57.4KB gz | record from '@rrweb/record'   23.2KB gz
// The drawer no longer replays video (only the task page does, in the site
// bundle), so the widget needs the RECORDER only — the lighter scoped package.
// The widget needs BOTH record (here) and Replayer (drawer mini player, ui.ts).
// The two scoped packages each re-bundle the shared snapshot/mirror code, so
// pulling both named imports from the single 'rrweb' package tree-shakes
// lightest overall — that is the choice ('rrweb' has sideEffects:false and
// __PURE__ annotations, so the unused exports drop cleanly).

import { record } from '@rrweb/record';

// The scoped record-only package hangs addCustomEvent off `record` itself.
const addCustomEvent = record.addCustomEvent;
import type { eventWithTime } from '@rrweb/types';
import { QA_STEP_TAG } from './marks';
import type { StepMark } from './types';

const CHECKOUT_EVERY_MS = 60_000;
/** IngestBody.replayEvents client cap — measured AFTER JSON.stringify (contract). */
export const REPLAY_MAX_CHARS = 8_000_000;

// Mirrors buffers.ts HARD PRIVACY RULE — password/cc/otp stay masked unconditionally.
const SENSITIVE_AUTOCOMPLETE_RE = /password|cc-|card|otp/i;

/**
 * The input types rrweb routes through `maskInputFn` (contract §Session replay:
 * masking mirrors the click-trail rules EXACTLY). rrweb only consults
 * `maskInputFn` for the types/tags flagged here — everything else is recorded
 * verbatim and never reaches our function — so the flag list must cover every
 * text-entry surface, and `maskInputValue` below decides per element.
 *
 * `select` is deliberately FALSE: rrweb keys `option[selected]` off
 * `maskInputOptions.select` (rrweb-snapshot serializeNode), so turning it on
 * blanks the chosen option of EVERY dropdown in the replay. A `<select>` has no
 * typed value, so the typed-value rule has nothing to protect there.
 */
export const MASK_INPUT_OPTIONS: Record<string, boolean> = {
  color: true,
  date: true,
  'datetime-local': true,
  email: true,
  month: true,
  number: true,
  range: true,
  search: true,
  tel: true,
  text: true,
  time: true,
  url: true,
  week: true,
  textarea: true,
  password: true,
  select: false,
};

export interface Recorder {
  /** Concatenated buffered events: previous checkout window + current one. */
  events(): eventWithTime[];
  /**
   * Emit a trail-step marker into the recording (contract §Session replay):
   * `addCustomEvent('qa-step', {i, kind, label})`. A no-op when this recorder
   * never armed, was disposed, or rrweb is not recording — marking must never
   * throw into the capture path.
   */
  mark(mark: StepMark): void;
  /** Exact length JSON.stringify(events()) would have, computed lazily. */
  byteEstimate(): number;
  /** Stop recording and release the buffered windows. */
  dispose(): void;
}

/** rrweb's addCustomEvent — injectable for tests. */
export type AddCustomEventFn = (tag: string, payload: unknown) => void;

/** The subset of rrweb's record() the recorder needs — injectable for tests. */
export type RecordFn = (options: {
  emit: (event: eventWithTime, isCheckout?: boolean) => void;
  checkoutEveryNms?: number;
  blockSelector?: string;
  maskAllInputs?: boolean;
  maskInputOptions?: Record<string, boolean>;
  maskInputFn?: (text: string, element: HTMLElement) => string;
}) => (() => void) | undefined;

/** The click trail's rule (buffers.ts `isSensitiveField`), applied to an rrweb element. */
function isSensitive(element: HTMLElement): boolean {
  const attrType = (element.getAttribute('type') ?? '').toLowerCase();
  const liveType = typeof (element as HTMLInputElement).type === 'string'
    ? (element as HTMLInputElement).type.toLowerCase()
    : '';
  if (element.tagName === 'INPUT' && (attrType === 'password' || liveType === 'password')) return true;
  return SENSITIVE_AUTOCOMPLETE_RE.test(element.getAttribute('autocomplete') ?? '');
}

/**
 * maskInputFn (contract §Session replay): the replay MUST show what the tester
 * actually typed — a step captioned `typed "…"` over an empty field is useless —
 * so typed values pass through UNMASKED, mirroring the click-trail rules exactly:
 * only `type=password` and fields whose autocomplete matches
 * `password|cc-|card|otp` are masked, and those unconditionally.
 */
export function maskInputValue(text: string, element: HTMLElement): string {
  return isSensitive(element) ? '*'.repeat(text.length) : text;
}

export function startRecorder(
  recordFn: RecordFn = record as RecordFn,
  addCustom: AddCustomEventFn = addCustomEvent as AddCustomEventFn,
): Recorder {
  // Two checkout windows: `previous` + `current`. events() concatenates them.
  let previous: eventWithTime[] = [];
  let current: eventWithTime[] = [];
  const META = 4; // EventType.Meta
  const FULL_SNAPSHOT = 2; // EventType.FullSnapshot

  let stop: (() => void) | undefined;
  try {
    stop = recordFn({
      emit: (event, isCheckout) => {
        // rrweb emits a checkout as a Meta + FullSnapshot pair, BOTH flagged
        // isCheckout (rrweb takeFullSnapshot). Rotate exactly on the
        // FullSnapshot and carry the just-pushed Meta into the new window —
        // the Replayer needs Meta before FullSnapshot to size its frame.
        if (isCheckout && event.type === FULL_SNAPSHOT) {
          const head: eventWithTime[] = [];
          const last = current[current.length - 1];
          if (last && last.type === META) {
            current.pop();
            head.push(last);
          }
          previous = current; // the window BEFORE the previous one is dropped here
          current = head;
        }
        current.push(event);
      },
      checkoutEveryNms: CHECKOUT_EVERY_MS,
      blockSelector: '[data-qa-pipeline]', // never records the widget's own UI
      // rrweb 2.1.1 (record(): `maskAllInputs === true ? {…everything…} :
      // maskInputOptions ?? {password:true}`) — maskAllInputs:true would REPLACE
      // our map, so it stays false and the explicit map decides which fields
      // reach maskInputFn. Verified against node_modules/rrweb typings +
      // rrweb-snapshot `maskInputValue`, which only calls maskInputFn for a
      // flagged tag/type.
      maskAllInputs: false,
      maskInputOptions: MASK_INPUT_OPTIONS,
      maskInputFn: maskInputValue,
    });
  } catch {
    stop = undefined; // rrweb failed to arm — the recorder stays empty, never throws
  }

  return {
    events: () => [...previous, ...current],
    mark: (mark) => {
      if (!stop) return; // never armed, or already disposed
      try {
        addCustom(QA_STEP_TAG, mark);
      } catch {
        // rrweb's addCustomEvent throws when nothing is recording — the step
        // is still in the trail, it just carries no marker in this recording.
      }
    },
    byteEstimate: () => {
      // Exact serialized size: Σ item lengths + (n-1) commas + 2 brackets.
      let n = 0;
      let sum = 0;
      for (const window of [previous, current]) {
        for (const event of window) {
          sum += JSON.stringify(event).length;
          n++;
        }
      }
      return sum + Math.max(0, n - 1) + 2;
    },
    dispose: () => {
      try {
        stop?.();
      } catch {
        /* already stopped */
      }
      stop = undefined;
      previous = [];
      current = [];
    },
  };
}

/**
 * IngestBody.replayEvents (contract §Session replay): JSON.stringify of the
 * buffered events — undefined when there is no recording, nothing recorded yet,
 * or the string exceeds the 8_000_000-char client cap (measured AFTER
 * stringify; the field is dropped entirely, never truncated).
 */
export function replayEventsField(recorder: Pick<Recorder, 'events'> | null): string | undefined {
  if (!recorder) return undefined;
  const events = recorder.events();
  if (events.length === 0) return undefined;
  const json = JSON.stringify(events);
  return json.length > REPLAY_MAX_CHARS ? undefined : json;
}

/** Message 9 (contracts §Replay) — the tally, plus the after-the-fix recording. */
export interface ReplayDoneMessage {
  type: 'qa-pipeline:replay-done';
  shown: number;
  skipped: number;
  /** JSON of the rrweb recording of THIS replay execution; omitted over the 8M-char cap. */
  events?: string;
}

/**
 * After-the-fix recording (contract §Session replay): message 9 carries the
 * rrweb recording of the replay execution itself, under the SAME 8_000_000-char
 * cap as replayEvents — omitted entirely when over, when nothing was recorded,
 * or when no dedicated recorder was armed. shown/skipped semantics unchanged.
 */
export function replayDoneMessage(
  result: { shown: number; skipped: number },
  recorder: Pick<Recorder, 'events'> | null,
): ReplayDoneMessage {
  const message: ReplayDoneMessage = {
    type: 'qa-pipeline:replay-done',
    shown: result.shown,
    skipped: result.skipped,
  };
  const events = replayEventsField(recorder);
  if (events !== undefined) message.events = events;
  return message;
}
