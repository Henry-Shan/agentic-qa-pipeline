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
const fab = (): HTMLButtonElement => {
  const btn = shadow().querySelector<HTMLButtonElement>('.qa-fab');
  if (!btn) throw new Error('record button missing');
  return btn;
};
const seg = (label: string): HTMLButtonElement => {
  const btn = Array.from(shadow().querySelectorAll<HTMLButtonElement>('.qa-seg > button')).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`segment "${label}" missing`);
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

/** Press record, do `actions`, press stop — the drawer opens with that window. */
async function record(actions: () => void = () => undefined): Promise<void> {
  fab().click(); // start
  await sleep(0);
  actions();
  await settle();
  fab().click(); // stop → the form opens already holding the recording
  for (let i = 0; i < 20 && !drawer(); i++) await sleep(10);
  if (!drawer()) throw new Error('drawer never opened');
}

/** Open the form with an empty recording (nothing done in between). */
const openDrawer = (): Promise<void> => record();

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

describe('the record button drives everything', () => {
  it('starts idle, then counts steps live while recording', async () => {
    expect(fab().textContent).toContain('Record');
    fab().click();
    await sleep(0);
    expect(fab().classList.contains('rec')).toBe(true);
    expect(fab().textContent).toContain('Stop');

    clickPage('Beta');
    clickPage('Gamma');
    await settle();
    expect(fab().textContent).toContain('2 steps');
  });

  it('captures only what happened between start and stop', async () => {
    clickPage('Alpha'); // before start — excluded
    await settle();
    await record(() => {
      clickPage('Beta');
      clickPage('Gamma');
    });
    expect(steps()).toEqual(['Beta', 'Gamma']);
    expect(countLabel()).toBe('2 steps');

    clickPage('Alpha'); // after stop — excluded
    await settle();
    expect(steps()).toEqual(['Beta', 'Gamma']);
  });

  it('installs the step sink at start and clears it at stop', async () => {
    const spy = vi.spyOn(buffers, 'setStepSink');
    fab().click();
    await sleep(0);
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function));
    fab().click();
    for (let i = 0; i < 20 && !drawer(); i++) await sleep(10);
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  it('hides itself while the form is open and returns after discarding', async () => {
    await openDrawer();
    expect(fab().hidden).toBe(true);
    (shadow().querySelector('.drawer-close') as HTMLButtonElement).click();
    expect(drawer()).toBeNull();
    expect(fab().hidden).toBe(false);
    expect(fab().textContent).toContain('Record');
  });
});

describe('drawer — how it is filed and what runs it', () => {
  it('defaults to a bug on opus, and both are switchable', async () => {
    await openDrawer();
    expect(seg('Bug').getAttribute('aria-pressed')).toBe('true');
    expect(seg('opus').getAttribute('aria-pressed')).toBe('true');

    seg('New feature').click();
    expect(seg('New feature').getAttribute('aria-pressed')).toBe('true');
    expect(seg('Bug').getAttribute('aria-pressed')).toBe('false');

    seg('sonnet').click();
    expect(seg('sonnet').getAttribute('aria-pressed')).toBe('true');
    expect(seg('opus').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows where the recording started', async () => {
    await openDrawer();
    const where = shadow().querySelector('.chips')?.textContent ?? '';
    expect(where).toContain('page');
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
