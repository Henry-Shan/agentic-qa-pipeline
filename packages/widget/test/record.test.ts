// Recorder (contracts §Session replay): window pruning across checkouts, the
// record() options the contract mandates, input masking, and the
// replayEvents submit field's cap/omission behavior. rrweb itself is mocked —
// these tests drive the emit callback with fake events and checkout flags.

import { describe, expect, it, vi } from 'vitest';
import { QA_STEP_TAG } from '../src/marks';
import {
  maskInputValue,
  REPLAY_MAX_CHARS,
  replayDoneMessage,
  replayEventsField,
  startRecorder,
  type RecordFn,
  type Recorder,
} from '../src/record';

type AnyEvent = { type: number; data: unknown; timestamp: number };
type Emit = (event: AnyEvent, isCheckout?: boolean) => void;

/** Mock rrweb record(): captures the options, exposes emit, counts stops. */
function mockRecord() {
  let emit: Emit | null = null;
  let options: Parameters<RecordFn>[0] | null = null;
  let stops = 0;
  const fn: RecordFn = (opts) => {
    options = opts;
    emit = opts.emit as Emit;
    return () => {
      stops++;
    };
  };
  return {
    fn,
    emit: (event: AnyEvent, isCheckout?: boolean) => {
      if (!emit) throw new Error('record() not called');
      emit(event, isCheckout);
    },
    options: () => {
      if (!options) throw new Error('record() not called');
      return options;
    },
    stops: () => stops,
  };
}

let nextTs = 1000;
const ev = (type: number, data: unknown = {}): AnyEvent => ({ type, data, timestamp: nextTs++ });
const meta = () => ev(4, { href: 'http://x/', width: 1440, height: 900 });
const snap = () => ev(2, { node: {}, initialOffset: { left: 0, top: 0 } });
const inc = (n: number) => ev(3, { source: 0, n });

/** rrweb emits the checkout Meta + FullSnapshot pair BOTH flagged isCheckout. */
function checkoutBurst(emit: (e: AnyEvent, c?: boolean) => void): AnyEvent[] {
  const m = meta();
  const s = snap();
  emit(m, true);
  emit(s, true);
  return [m, s];
}

describe('startRecorder — record() options (contract §Session replay)', () => {
  it('passes checkoutEveryNms 60_000, blockSelector and the per-element maskInputFn', () => {
    const mock = mockRecord();
    startRecorder(mock.fn);
    const opts = mock.options();
    expect(opts.checkoutEveryNms).toBe(60_000);
    expect(opts.blockSelector).toBe('[data-qa-pipeline]');
    expect(opts.maskInputFn).toBe(maskInputValue);
    // Typed values must reach the replay (contract: masking mirrors the trail
    // rules) — the blanket mask is off; maskInputValue decides per element.
    expect(opts.maskAllInputs).toBe(false);
    // Text-entry surfaces are routed through maskInputFn…
    expect(opts.maskInputOptions?.text).toBe(true);
    expect(opts.maskInputOptions?.textarea).toBe(true);
    expect(opts.maskInputOptions?.password).toBe(true);
    // …but never <select>: rrweb keys option[selected] off this flag, which
    // would blank every dropdown's chosen value in the replay.
    expect(opts.maskInputOptions?.select).toBe(false);
  });

  it('survives a record() that throws — empty recorder, no crash', () => {
    const recorder = startRecorder(() => {
      throw new Error('rrweb refused');
    });
    expect(recorder.events()).toEqual([]);
    expect(recorder.byteEstimate()).toBe(2); // '[]'
    expect(() => recorder.dispose()).not.toThrow();
  });
});

describe('startRecorder — checkout window pruning', () => {
  it('buffers everything before the first checkout', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn);
    const all = [meta(), snap(), inc(1), inc(2)];
    for (const e of all) mock.emit(e);
    expect(recorder.events()).toEqual(all);
  });

  it('keeps the previous + current windows; each checkout drops the window before the previous one', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn);

    const w0 = [meta(), snap(), inc(1)];
    for (const e of w0) mock.emit(e);

    const w1 = checkoutBurst(mock.emit);
    const w1inc = [inc(2), inc(3)];
    for (const e of w1inc) mock.emit(e);
    // two windows live: w0 (previous) + w1 (current)
    expect(recorder.events()).toEqual([...w0, ...w1, ...w1inc]);

    const w2 = checkoutBurst(mock.emit);
    const w2inc = [inc(4)];
    for (const e of w2inc) mock.emit(e);
    // w0 dropped — only w1 (previous) + w2 (current) remain
    expect(recorder.events()).toEqual([...w1, ...w1inc, ...w2, ...w2inc]);

    const w3 = checkoutBurst(mock.emit);
    // w1 dropped in turn
    expect(recorder.events()).toEqual([...w2, ...w2inc, ...w3]);
  });

  it('keeps the checkout Meta + FullSnapshot pair together at the head of the new window (rotates once per burst)', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn);
    for (const e of [meta(), snap()]) mock.emit(e);
    checkoutBurst(mock.emit); // w1
    const w2 = checkoutBurst(mock.emit); // w1 → previous; the burst must not split
    checkoutBurst(mock.emit); // w2 → previous
    const events = recorder.events();
    // previous window is exactly w2: Meta first, FullSnapshot second
    expect(events[0]).toBe(w2[0]);
    expect(events[1]).toBe(w2[1]);
    expect(events[0]?.type).toBe(4);
    expect(events[1]?.type).toBe(2);
  });

  it('byteEstimate matches JSON.stringify(events()).length exactly', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn);
    expect(recorder.byteEstimate()).toBe(JSON.stringify([]).length);
    for (const e of [meta(), snap(), inc(1)]) mock.emit(e);
    checkoutBurst(mock.emit);
    mock.emit(inc(2));
    expect(recorder.byteEstimate()).toBe(JSON.stringify(recorder.events()).length);
  });

  it('dispose() stops rrweb and releases the buffers', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn);
    for (const e of [meta(), snap()]) mock.emit(e);
    recorder.dispose();
    expect(mock.stops()).toBe(1);
    expect(recorder.events()).toEqual([]);
    recorder.dispose(); // idempotent
    expect(mock.stops()).toBe(1);
  });
});

// Step markers (contract §Session replay): the ACTIVE recorder turns a trail
// step into `addCustomEvent('qa-step', {i, kind, label})`.
describe('Recorder.mark — qa-step custom events', () => {
  const mark = { i: 3, kind: 'click', label: 'Save' } as const;

  it('emits addCustomEvent("qa-step", {i, kind, label}) verbatim', () => {
    const mock = mockRecord();
    const add = vi.fn();
    const recorder = startRecorder(mock.fn, add);
    recorder.mark(mark);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(QA_STEP_TAG, mark);
    expect(QA_STEP_TAG).toBe('qa-step');
  });

  it('lands in this recorder buffer as a type-5 custom event the players read back', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn, (tag, payload) =>
      mock.emit({ type: 5, data: { tag, payload }, timestamp: nextTs++ }),
    );
    for (const e of [meta(), snap()]) mock.emit(e);
    recorder.mark(mark);
    const last = recorder.events().at(-1) as unknown as AnyEvent;
    expect(last.type).toBe(5);
    expect(last.data).toEqual({ tag: 'qa-step', payload: mark });
  });

  it('no-ops when the recorder never armed', () => {
    const add = vi.fn();
    const recorder = startRecorder(() => {
      throw new Error('rrweb refused');
    }, add);
    expect(() => recorder.mark(mark)).not.toThrow();
    expect(add).not.toHaveBeenCalled();
  });

  it('no-ops after dispose() — nothing is recording any more', () => {
    const mock = mockRecord();
    const add = vi.fn();
    const recorder = startRecorder(mock.fn, add);
    recorder.dispose();
    recorder.mark(mark);
    expect(add).not.toHaveBeenCalled();
  });

  it('swallows rrweb throwing "please add custom event after start recording"', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn, () => {
      throw new Error('please add custom event after start recording');
    });
    expect(() => recorder.mark(mark)).not.toThrow();
  });
});

describe('maskInputValue — mirrors the click-trail privacy rules', () => {
  const input = (attrs: Record<string, string>): HTMLInputElement => {
    const el = document.createElement('input');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  it('records what the tester typed — a replay must show it', () => {
    expect(maskInputValue('laser kit', input({ type: 'search' }))).toBe('laser kit');
    expect(maskInputValue('someone@example.com', input({ type: 'email' }))).toBe(
      'someone@example.com',
    );
    expect(maskInputValue('hello', input({ type: 'text' }))).toBe('hello');
    expect(maskInputValue('hello', input({}))).toBe('hello');
  });

  it('always masks password / cc / otp fields', () => {
    expect(maskInputValue('hunter2!', input({ type: 'password' }))).toBe('********');
    expect(maskInputValue('4242424242424242', input({ type: 'text', autocomplete: 'cc-number' }))).toBe(
      '*'.repeat(16),
    );
    expect(maskInputValue('123456', input({ type: 'text', autocomplete: 'one-time-code otp' }))).toBe('******');
    // even a perverse type=search flagged sensitive stays masked
    expect(maskInputValue('secret', input({ type: 'search', autocomplete: 'current-password' }))).toBe('******');
  });

  it('records textarea and select values like any other non-sensitive field', () => {
    expect(maskInputValue('long note', document.createElement('textarea'))).toBe('long note');
    expect(maskInputValue('Option A', document.createElement('select'))).toBe('Option A');
  });
});

const stub = (events: AnyEvent[]): Pick<Recorder, 'events'> => ({
  events: () => events as never,
});

describe('replayEventsField — IngestBody.replayEvents cap/omission', () => {

  it('omits the field when there is no recorder or nothing recorded', () => {
    expect(replayEventsField(null)).toBeUndefined();
    expect(replayEventsField(stub([]))).toBeUndefined();
  });

  it('returns the stringified events when under the cap', () => {
    const events = [meta(), snap(), inc(1)];
    expect(replayEventsField(stub(events))).toBe(JSON.stringify(events));
  });

  it('omits the field entirely when the STRINGIFIED size exceeds 8_000_000 chars', () => {
    const big = ev(3, { blob: 'x'.repeat(REPLAY_MAX_CHARS) }); // > cap only after stringify
    expect(replayEventsField(stub([big]))).toBeUndefined();
    // right at the cap it still sends: construct a payload whose JSON length ≤ cap
    const under = ev(3, { blob: 'x'.repeat(1000) });
    const json = replayEventsField(stub([under]));
    expect(json).toBe(JSON.stringify([under]));
    expect(json!.length).toBeLessThanOrEqual(REPLAY_MAX_CHARS);
  });
});

// After-the-fix recording (contract §Session replay): message 9 carries the
// rrweb recording of the replay execution, under the same 8M-char cap.
describe('replayDoneMessage — message 9 with the after-the-fix recording', () => {
  it('keeps the shown/skipped semantics and the exact message type', () => {
    const msg = replayDoneMessage({ shown: 7, skipped: 2 }, null);
    expect(msg).toEqual({ type: 'qa-pipeline:replay-done', shown: 7, skipped: 2 });
    expect('events' in msg).toBe(false); // omitted, not undefined
  });

  it('includes the stringified recording when it is under the cap', () => {
    const events = [meta(), snap(), inc(1)];
    const msg = replayDoneMessage({ shown: 3, skipped: 0 }, stub(events));
    expect(msg.type).toBe('qa-pipeline:replay-done');
    expect(msg.shown).toBe(3);
    expect(msg.skipped).toBe(0);
    expect(msg.events).toBe(JSON.stringify(events));
    expect(msg.events!.length).toBeLessThanOrEqual(REPLAY_MAX_CHARS);
  });

  it('omits events when the recording exceeds the cap', () => {
    const big = ev(3, { blob: 'x'.repeat(REPLAY_MAX_CHARS) });
    const msg = replayDoneMessage({ shown: 4, skipped: 1 }, stub([big]));
    expect(msg.events).toBeUndefined();
    expect('events' in msg).toBe(false);
    expect(msg).toEqual({ type: 'qa-pipeline:replay-done', shown: 4, skipped: 1 });
  });

  it('omits events when the dedicated recorder captured nothing', () => {
    expect(replayDoneMessage({ shown: 0, skipped: 0 }, stub([])).events).toBeUndefined();
  });

  it('works against a real (mocked-rrweb) dedicated recorder, and disposal releases it', () => {
    const mock = mockRecord();
    const recorder = startRecorder(mock.fn);
    const events = [meta(), snap(), inc(1)];
    for (const e of events) mock.emit(e);

    const msg = replayDoneMessage({ shown: 2, skipped: 1 }, recorder);
    expect(msg.events).toBe(JSON.stringify(events));

    recorder.dispose(); // stopped at replay end — the ambient recorder is untouched
    expect(mock.stops()).toBe(1);
    expect(replayDoneMessage({ shown: 2, skipped: 1 }, recorder).events).toBeUndefined();
  });
});
