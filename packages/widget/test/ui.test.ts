// Drawer behavior end-to-end in jsdom. Recording is EXPLICIT (contract
// §Session replay): clicks/typing/screen are captured only between the
// drawer's ⏺ Start and Finish — these tests drive that window and assert the
// trail list, the Finish pill and the sink lifecycle. rrweb's record() may or
// may not arm under jsdom; the widget treats a failed arm as an empty
// recording, so nothing here depends on rrweb emitting events.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBuffers, type Buffers } from '../src/buffers';
import { createUI, type WidgetUI } from '../src/ui';

// jsdom has no canvas — captureShot would only log a wall of "not implemented".
// The drawer opens with `shot: null`, exactly as it does on a page where the
// capture fails.
vi.mock('modern-screenshot', () => ({
  domToCanvas: () => Promise.reject(new Error('no canvas in jsdom')),
}));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Trail notifications are debounced ~120ms inside buffers. */
const settle = (): Promise<void> => sleep(200);

let buffers: Buffers;
let ui: WidgetUI;

function shadow(): ShadowRoot {
  const root = ui.host.shadowRoot;
  if (!root) throw new Error('widget shadow root missing');
  return root;
}

const drawer = (): HTMLElement | null => shadow().querySelector('.qa-drawer');
const steps = (): string[] =>
  Array.from(shadow().querySelectorAll('.replay-list li.replay-step .rs-lbl')).map((n) => n.textContent ?? '');
const countLabel = (): string => shadow().querySelector('.cap-count')?.textContent ?? '';
const recordBtn = (): HTMLButtonElement => {
  const btn = shadow().querySelector<HTMLButtonElement>('.qa-record');
  if (!btn) throw new Error('record button missing');
  return btn;
};
const pillEl = (): HTMLButtonElement => {
  const pill = shadow().querySelector<HTMLButtonElement>('.qa-pill');
  if (!pill) throw new Error('pill missing');
  return pill;
};

function clickPage(label: string): void {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
  btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** fab → picker (Esc skips it) → screenshot (null in jsdom) → drawer. */
async function openDrawer(): Promise<void> {
  ui.open();
  await sleep(0);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  for (let i = 0; i < 10 && !drawer(); i++) await sleep(10);
  if (!drawer()) throw new Error('drawer never opened');
}

beforeEach(() => {
  document.body.innerHTML = '<button>Alpha</button><button>Beta</button><button>Gamma</button>';
  buffers = startBuffers();
  ui = createUI({ endpoint: 'https://qa.example.test', token: 'x' }, buffers);
});

afterEach(() => {
  buffers.dispose();
  ui.host.remove();
  document.body.innerHTML = '';
});

describe('drawer — explicit recording (⏺ Start / Finish)', () => {
  it('opens with no steps, "not recorded yet" and a Record button', async () => {
    clickPage('Alpha'); // pre-recording activity never enters the report
    await settle();
    await openDrawer();
    expect(steps().length).toBe(0);
    expect(countLabel()).toBe('not recorded yet');
    expect(recordBtn().textContent).toBe('⏺ Record the steps');
    expect(shadow().querySelector('.live-hint')?.textContent).toBe(
      'Recording captures your clicks, typing and screen until you press Finish.',
    );
  });

  it('captures only the steps between Start and Finish', async () => {
    clickPage('Alpha'); // before Start — excluded
    await settle();
    await openDrawer();

    recordBtn().click(); // Start → collapses to the red Finish pill
    expect((drawer() as HTMLElement).style.display).toBe('none');
    expect(pillEl().classList.contains('rec')).toBe(true);
    expect(pillEl().textContent).toContain('Finish');

    clickPage('Beta');
    clickPage('Gamma');
    await settle();
    expect(Number(shadow().querySelector('.pill-count')?.textContent)).toBe(2);

    pillEl().click(); // Finish → back to the report
    expect((drawer() as HTMLElement).style.display).toBe('');
    expect(steps()).toEqual(['Beta', 'Gamma']);
    expect(countLabel()).toBe('2 steps');
    expect(recordBtn().textContent).toBe('↻ Re-record the steps');

    clickPage('Alpha'); // after Finish — excluded
    await settle();
    expect(steps()).toEqual(['Beta', 'Gamma']);
  });

  it('re-record discards the previous take', async () => {
    await openDrawer();
    recordBtn().click();
    clickPage('Beta');
    await settle();
    pillEl().click(); // Finish take 1
    expect(steps()).toEqual(['Beta']);

    recordBtn().click(); // ↻ Re-record
    clickPage('Gamma');
    await settle();
    pillEl().click(); // Finish take 2
    expect(steps()).toEqual(['Gamma']);
  });

  it('installs the step sink at Start and clears it at Finish', async () => {
    const spy = vi.spyOn(buffers, 'setStepSink');
    await openDrawer();
    recordBtn().click();
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function));
    pillEl().click();
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  it('discards a live take when the drawer is closed', async () => {
    const spy = vi.spyOn(buffers, 'setStepSink');
    await openDrawer();
    recordBtn().click();
    (shadow().querySelector('.drawer-close') as HTMLButtonElement).click();
    expect(drawer()).toBeNull();
    expect(spy).toHaveBeenLastCalledWith(null);
  });
});

describe('drawer — steps only, no video', () => {
  it('shows the (empty) trail list and mounts NO replay player', async () => {
    await openDrawer();
    expect(shadow().querySelector('.replay-list')).not.toBeNull();
    expect(shadow().querySelector('.rr-player, .rr-stage, .rr-rail, .rr-foot')).toBeNull();
  });
});

describe('drawer — collapse to a pill', () => {
  it('collapses to a pill and restores all form state', async () => {
    await openDrawer();
    const desc = shadow().querySelector('.desc') as HTMLTextAreaElement;
    desc.value = 'the save button does nothing';

    (shadow().querySelector('.drawer-collapse') as HTMLButtonElement).click();
    expect(pillEl().classList.contains('rec')).toBe(false); // plain collapse, not recording
    expect((drawer() as HTMLElement).style.display).toBe('none');

    pillEl().click();
    expect(shadow().querySelector('.qa-pill')).toBeNull();
    expect((drawer() as HTMLElement).style.display).toBe('');
    expect((shadow().querySelector('.desc') as HTMLTextAreaElement).value).toBe(
      'the save button does nothing',
    );
  });

  it('Escape never discards the report — it collapses instead', async () => {
    await openDrawer();
    const desc = shadow().querySelector('.desc') as HTMLTextAreaElement;
    desc.value = 'half-written report';

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(drawer()).not.toBeNull(); // NOT discarded
    expect((drawer() as HTMLElement).style.display).toBe('none');
    expect(shadow().querySelector('.qa-pill')).not.toBeNull();

    pillEl().click();
    expect((shadow().querySelector('.desc') as HTMLTextAreaElement).value).toBe('half-written report');
  });
});
