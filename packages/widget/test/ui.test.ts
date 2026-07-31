// Drawer behavior end-to-end in jsdom (the user-reported bug: the trail froze
// the moment the drawer opened). The recorder is passed as null so the mini
// player takes its "recording just started" path and no rrweb Replayer is
// constructed — everything else is the real widget.

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
  ui = createUI({ endpoint: 'https://qa.example.test', token: 'x' }, buffers, null);
});

afterEach(() => {
  buffers.dispose();
  ui.host.remove();
  document.body.innerHTML = '';
});

describe('drawer — live trail (the drawer no longer freezes the trail)', () => {
  it('appends steps performed while the drawer is open, with a live count', async () => {
    clickPage('Alpha');
    await openDrawer();
    const before = steps().length;
    expect(countLabel()).toBe(`${before} steps`);

    // The tester keeps reproducing with the drawer open.
    clickPage('Beta');
    clickPage('Gamma');
    await settle();

    expect(steps().length).toBe(before + 2);
    expect(steps().slice(-2)).toEqual(['Beta', 'Gamma']);
    expect(countLabel()).toBe(`${before + 2} steps`);
  });

  it('flashes the newly appended step', async () => {
    await openDrawer();
    clickPage('Beta');
    await settle();
    const rows = Array.from(shadow().querySelectorAll('.replay-list li.replay-step'));
    expect(rows[rows.length - 1]?.classList.contains('fresh')).toBe(true);
  });

  it('shows the "keep using the app" hint under the header', async () => {
    await openDrawer();
    expect(shadow().querySelector('.live-hint')?.textContent).toBe(
      'Keep using the app — new steps keep recording.',
    );
  });

  it('stops listening once the drawer is discarded', async () => {
    await openDrawer();
    clickPage('Beta');
    await settle();
    const rendered = steps().length;
    (shadow().querySelector('.drawer-close') as HTMLButtonElement).click();
    expect(drawer()).toBeNull();

    clickPage('Gamma'); // still recorded into the buffer, nothing to render into
    await settle();
    expect(buffers.clickTrail().length).toBeGreaterThan(rendered);
  });
});

// Step markers (contract §Session replay): createUI wires the ambient sink so
// every trail step also lands in the recording as a `qa-step` custom event.
describe('ambient step markers', () => {
  it('marks every step the tester takes into the active recording', async () => {
    ui.host.remove();
    buffers.dispose();
    buffers = startBuffers();
    const mark = vi.fn();
    const recorder = { events: () => [], byteEstimate: () => 2, mark, dispose: () => undefined };
    ui = createUI({ endpoint: 'https://qa.example.test', token: 'x' }, buffers, recorder);

    clickPage('Alpha');
    clickPage('Beta');
    await settle();

    const trail = buffers.clickTrail();
    expect(mark).toHaveBeenCalledTimes(2);
    expect(mark).toHaveBeenNthCalledWith(1, { i: trail.length - 1, kind: 'click', label: 'Alpha' });
    expect(mark).toHaveBeenNthCalledWith(2, { i: trail.length, kind: 'click', label: 'Beta' });
  });

  it('never marks the widget own UI (clicks inside the shadow root are not steps)', async () => {
    ui.host.remove();
    buffers.dispose();
    buffers = startBuffers();
    const mark = vi.fn();
    ui = createUI({ endpoint: 'https://qa.example.test', token: 'x' }, buffers, {
      events: () => [],
      byteEstimate: () => 2,
      mark,
      dispose: () => undefined,
    });
    await openDrawer();
    mark.mockClear();
    (shadow().querySelector('.drawer-collapse') as HTMLButtonElement).click();
    await settle();
    expect(mark).not.toHaveBeenCalled();
  });
});

describe('drawer — the numbered list drives the player', () => {
  it('is pickable: rows are wired to seek the player', async () => {
    await openDrawer();
    expect(shadow().querySelector('.replay-list')?.classList.contains('pickable')).toBe(true);
  });
});

describe('drawer — collapse to a pill', () => {
  it('collapses to a pill with the live count and restores all form state', async () => {
    await openDrawer();
    const desc = shadow().querySelector('.desc') as HTMLTextAreaElement;
    desc.value = 'the save button does nothing';

    (shadow().querySelector('.drawer-collapse') as HTMLButtonElement).click();
    const pill = shadow().querySelector('.qa-pill') as HTMLButtonElement | null;
    expect(pill).not.toBeNull();
    expect((drawer() as HTMLElement).style.display).toBe('none');

    // Steps keep landing while collapsed — the pill count tracks them.
    const countBefore = Number(shadow().querySelector('.pill-count')?.textContent);
    clickPage('Beta');
    await settle();
    expect(Number(shadow().querySelector('.pill-count')?.textContent)).toBe(countBefore + 1);

    pill!.click();
    expect(shadow().querySelector('.qa-pill')).toBeNull();
    expect((drawer() as HTMLElement).style.display).toBe('');
    expect((shadow().querySelector('.desc') as HTMLTextAreaElement).value).toBe(
      'the save button does nothing',
    );
    expect(steps().slice(-1)).toEqual(['Beta']); // recorded while collapsed
  });

  it('Escape never discards the report — it collapses instead', async () => {
    await openDrawer();
    const desc = shadow().querySelector('.desc') as HTMLTextAreaElement;
    desc.value = 'half-written report';

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(drawer()).not.toBeNull(); // NOT discarded
    expect((drawer() as HTMLElement).style.display).toBe('none');
    expect(shadow().querySelector('.qa-pill')).not.toBeNull();

    (shadow().querySelector('.qa-pill') as HTMLButtonElement).click();
    expect((shadow().querySelector('.desc') as HTMLTextAreaElement).value).toBe('half-written report');
  });
});
