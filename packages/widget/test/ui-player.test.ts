// The drawer's mini player, wired end-to-end in jsdom (contracts §Session
// replay, "Player UX … KEYFRAME slideshow"). rrweb's Replayer is faked — this
// asserts the WIDGET's behavior around it: what chrome exists, that each step
// is a `pause(mark.offset)`, that it autoplays on mount, and that every manual
// navigation (side-click, ← / →, rail tick, trail row) pauses that autoplay.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Fake rrweb Replayer: records every seek, renders a wrapper + iframe like the real one. */
const { FakeReplayer } = vi.hoisted(() => {
  class FakeReplayer {
    static last: FakeReplayer | null = null;
    wrapper = document.createElement('div');
    iframe = document.createElement('iframe');
    /** Every `pause(offset)` the player asked for, in order. */
    seeks: number[] = [];

    constructor(_events: unknown[], opts: { root: HTMLElement }) {
      FakeReplayer.last = this;
      this.iframe.setAttribute('width', '1000');
      this.iframe.setAttribute('height', '800');
      this.wrapper.appendChild(this.iframe);
      opts.root.appendChild(this.wrapper);
    }
    on(): void {}
    getMetaData() {
      return { totalTime: 10_000, startTime: 0, endTime: 10_000 };
    }
    getCurrentTime(): number {
      return 0;
    }
    pause(offset?: number): void {
      if (typeof offset === 'number') this.seeks.push(offset);
    }
    play(): void {}
    setConfig(): void {}
    destroy(): void {
      this.wrapper.remove();
    }
  }
  return { FakeReplayer };
});

type FakePlayer = InstanceType<typeof FakeReplayer>;

vi.mock('rrweb', () => ({ Replayer: FakeReplayer, record: () => () => undefined }));
vi.mock('modern-screenshot', () => ({ domToCanvas: () => Promise.reject(new Error('no canvas in jsdom')) }));

import { startBuffers, type Buffers } from '../src/buffers';
import { createUI, type WidgetUI } from '../src/ui';
import { QA_STEP_TAG } from '../src/marks';

const T0 = 1_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (): Promise<void> => sleep(200);

/**
 * A recording whose own `qa-step` markers point at trail steps 2, 3 and 4 (the
 * three page clicks below — step 1 is the initial route marker), 300ms apart.
 */
function recorderWithSteps() {
  const events: Array<{ type: number; timestamp: number; data: unknown }> = [
    { type: 4, timestamp: T0, data: { href: 'http://x/', width: 1000, height: 800 } },
    { type: 2, timestamp: T0 + 1, data: {} },
  ];
  [2, 3, 4].forEach((i, k) => {
    events.push({
      type: 5,
      timestamp: T0 + 300 * (k + 1),
      data: { tag: QA_STEP_TAG, payload: { i, kind: 'click', label: `label${i}` } },
    });
  });
  return { events: () => events, byteEstimate: () => 64, mark: () => undefined, dispose: () => undefined };
}

let buffers: Buffers;
let ui: WidgetUI;

function shadow(): ShadowRoot {
  const root = ui.host.shadowRoot;
  if (!root) throw new Error('widget shadow root missing');
  return root;
}
const q = <T extends Element>(sel: string): T | null => shadow().querySelector<T>(sel);
const drawer = (): HTMLElement | null => q('.qa-drawer');
const player = (): FakePlayer => {
  if (!FakeReplayer.last) throw new Error('no Replayer was constructed');
  return FakeReplayer.last;
};
const activeTick = (): number => Array.from(shadow().querySelectorAll('.rr-tick')).findIndex((t) => t.classList.contains('on'));
const playBtn = (): HTMLButtonElement => {
  const btn = q<HTMLButtonElement>('.rr-foot .rr-btn');
  if (!btn) throw new Error('no play button');
  return btn;
};

function clickPage(label: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** jsdom lays nothing out: give the stage a 300px-wide box so the thirds are real. */
function stageBox(): HTMLElement {
  const stage = q<HTMLElement>('.rr-stage');
  if (!stage) throw new Error('no stage');
  stage.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 180, right: 300, bottom: 180, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return stage;
}

/** Click a third of the stage: 'left' | 'middle' | 'right'. */
function clickStage(where: 'left' | 'middle' | 'right'): void {
  const x = where === 'left' ? 20 : where === 'middle' ? 150 : 280;
  stageBox().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: 90 }));
}

async function openDrawer(): Promise<void> {
  ui.open();
  await sleep(0);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  for (let i = 0; i < 10 && !drawer(); i++) await sleep(10);
  if (!drawer()) throw new Error('drawer never opened');
  await sleep(20); // the player mounts on the next frame
}

beforeEach(async () => {
  FakeReplayer.last = null;
  document.body.innerHTML = '<button>Alpha</button><button>Beta</button><button>Gamma</button>';
  buffers = startBuffers();
  ui = createUI({ endpoint: 'https://qa.example.test', token: 'x' }, buffers, recorderWithSteps());
  clickPage('Alpha');
  clickPage('Beta');
  clickPage('Gamma');
  await settle();
  await openDrawer();
});

afterEach(() => {
  buffers.dispose();
  ui.host.remove();
  document.body.innerHTML = '';
});

describe('mini player — the slideshow chrome', () => {
  it('has a stage, a tick rail and ▶/⏸ ⟲ ↻ — and no Prev/Next, caption or speed control', () => {
    expect(q('.rr-stage')).not.toBeNull();
    expect(shadow().querySelectorAll('.rr-tick').length).toBe(3);
    expect(Array.from(shadow().querySelectorAll('.rr-foot .rr-btn')).map((b) => b.textContent)).toEqual([
      '⏸',
      '⟲',
      '↻',
    ]);
    // The removed step-BUTTON player: no Prev/Next pair, no `N / M · label`
    // caption row, no 1×/2× toggle.
    expect(q('.rr-step')).toBeNull();
    expect(q('.rr-cap')).toBeNull();
    expect(q('.rr-speed')).toBeNull();
    expect(Array.from(shadow().querySelectorAll('button')).map((b) => b.textContent)).not.toContain('◀ Prev');
    expect(Array.from(shadow().querySelectorAll('button')).map((b) => b.textContent)).not.toContain('Next ▶');
  });

  it('mounts a cursor overlay above the stage and three side-click zones', () => {
    const stage = q<HTMLElement>('.rr-stage');
    expect(stage?.querySelector('.rr-cursor-layer .rr-cursor')).not.toBeNull();
    expect(stage?.querySelectorAll('.rr-edge').length).toBe(3);
  });

  it('opens on step 1 — pause(offset) at the first mark — and autoplays', () => {
    // pause(0) applies the Meta/first frame; then step 1 = the first qa-step
    // marker's offset, relative to the recording.
    expect(player().seeks).toEqual([0, 300]);
    expect(activeTick()).toBe(0);
    expect(playBtn().textContent).toBe('⏸'); // autoplay by default
  });
});

describe('mini player — navigation pauses autoplay', () => {
  it('steps forward on a right-third click and back on a left-third one', () => {
    clickStage('right');
    expect(activeTick()).toBe(1);
    expect(player().seeks.at(-1)).toBe(600);
    expect(playBtn().textContent).toBe('▶'); // manual navigation paused autoplay

    clickStage('left');
    expect(activeTick()).toBe(0);
    expect(player().seeks.at(-1)).toBe(300);
  });

  it('ignores the inert middle third', () => {
    const before = player().seeks.length;
    clickStage('middle');
    expect(activeTick()).toBe(0);
    expect(player().seeks.length).toBe(before);
  });

  it('never steps past either end', () => {
    clickStage('left'); // already on step 1
    expect(activeTick()).toBe(0);
    clickStage('right');
    clickStage('right');
    clickStage('right');
    clickStage('right');
    expect(activeTick()).toBe(2); // the last of three steps
  });

  it('← / → step the slideshow, but not while a text field has focus', () => {
    const panel = drawer() as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(activeTick()).toBe(1);
    expect(playBtn().textContent).toBe('▶');
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(activeTick()).toBe(0);

    const desc = q<HTMLTextAreaElement>('.desc');
    desc?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(activeTick()).toBe(0); // the caret moved, the slideshow did not
  });

  it('jumps to any step from the tick rail', () => {
    const ticks = Array.from(shadow().querySelectorAll<HTMLButtonElement>('.rr-tick'));
    ticks[2]?.click();
    expect(activeTick()).toBe(2);
    expect(player().seeks.at(-1)).toBe(900);
    expect(playBtn().textContent).toBe('▶');
  });

  it('▶/⏸ toggles autoplay', () => {
    expect(playBtn().textContent).toBe('⏸');
    playBtn().click();
    expect(playBtn().textContent).toBe('▶');
    playBtn().click();
    expect(playBtn().textContent).toBe('⏸');
  });

  it('⟲ restarts from step 1 and plays again', () => {
    clickStage('right');
    clickStage('right');
    expect(activeTick()).toBe(2);
    const restart = Array.from(shadow().querySelectorAll<HTMLButtonElement>('.rr-foot .rr-btn')).find(
      (b) => b.textContent === '⟲',
    );
    restart?.click();
    expect(activeTick()).toBe(0);
    expect(player().seeks.at(-1)).toBe(300);
    expect(playBtn().textContent).toBe('⏸');
  });
});

describe('mini player — two-way sync with the numbered trail list', () => {
  it('lights the trail row the player is parked on', () => {
    clickStage('right'); // step 2 of the rail = trail step 3
    const rows = Array.from(shadow().querySelectorAll('.replay-list li'));
    const active = rows.findIndex((r) => r.classList.contains('active'));
    expect(active).toBe(2); // 0-based trail index of the marker's `i: 3`
  });

  it('seeks the player when a trail row is clicked', () => {
    const rows = Array.from(shadow().querySelectorAll<HTMLElement>('.replay-list li.replay-step'));
    rows[3]?.click(); // trail step 4 → the third marker
    expect(player().seeks.at(-1)).toBe(900);
    expect(activeTick()).toBe(2);
    expect(playBtn().textContent).toBe('▶'); // a row click is manual navigation
  });
});
