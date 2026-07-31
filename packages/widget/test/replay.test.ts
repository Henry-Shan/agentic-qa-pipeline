import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveByText, resolveStep, startReplay, type ReplayHandle } from '../src/replay';
import type { ClickTrailEntry } from '../src/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

function get(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing fixture ${selector}`);
  return el;
}

describe('resolveStep — selector first', () => {
  it('resolves by selector before testid, component and text', () => {
    document.body.innerHTML = `
      <button id="sel">Save</button>
      <button data-testid="save" data-sentry-component="Panel">Save</button>`;
    const el = resolveStep({ selector: '#sel', testid: 'save', component: 'Panel', text: 'Save' });
    expect(el).toBe(get('#sel'));
  });

  it('falls back to testid when the selector matches nothing', () => {
    document.body.innerHTML = `<button data-testid="save">Save</button>`;
    expect(resolveStep({ selector: '#gone', testid: 'save' })).toBe(get('[data-testid="save"]'));
  });

  it('tolerates an invalid selector and falls back', () => {
    document.body.innerHTML = `<button data-testid="save">Save</button>`;
    expect(resolveStep({ selector: ':::nope', testid: 'save' })).toBe(get('[data-testid="save"]'));
  });

  it('skips hidden selector matches in favor of the fallback chain', () => {
    document.body.innerHTML = `
      <button id="sel" hidden>Save</button>
      <button data-testid="save">Save</button>`;
    expect(resolveStep({ selector: '#sel', testid: 'save' })).toBe(get('[data-testid="save"]'));
  });

  it('never resolves a selector inside the ignored (widget host) subtree', () => {
    document.body.innerHTML = `
      <div id="widget"><button class="go">Save</button></div>
      <button class="go" id="page">Save</button>`;
    expect(resolveStep({ selector: 'button.go' }, document, get('#widget'))).toBe(get('#page'));
  });
});

describe('resolveStep — fallback order', () => {
  it('resolves by data-testid first, even when component and text would also match', () => {
    document.body.innerHTML = `
      <div data-sentry-component="Panel"><span>Manage Lab Access</span></div>
      <button data-testid="manage-access">Manage Lab Access</button>`;
    const el = resolveStep({ testid: 'manage-access', component: 'Panel', text: 'Manage Lab Access' });
    expect(el).toBe(get('[data-testid="manage-access"]'));
  });

  it('falls back to component when the testid matches nothing', () => {
    document.body.innerHTML = `
      <section data-sentry-component="Panel"><button>Go</button></section>`;
    const el = resolveStep({ testid: 'gone', component: 'Panel' });
    expect(el).toBe(get('section'));
  });

  it('matches data-sentry-component before data-component', () => {
    document.body.innerHTML = `
      <div id="plain" data-component="Panel">a</div>
      <div id="sentry" data-sentry-component="Panel">b</div>`;
    expect(resolveStep({ component: 'Panel' })).toBe(get('#sentry'));
  });

  it('matches data-component when no sentry attribute matches', () => {
    document.body.innerHTML = `<div id="plain" data-component="Panel">a</div>`;
    expect(resolveStep({ component: 'Panel' })).toBe(get('#plain'));
  });

  it('falls back to visible text when testid and component both miss', () => {
    document.body.innerHTML = `<button>Manage Lab Access</button>`;
    const el = resolveStep({ testid: 'gone', component: 'Gone', text: 'Manage Lab Access' });
    expect(el).toBe(get('button'));
  });

  it('returns null for an unresolvable step and for route-only entries', () => {
    document.body.innerHTML = `<div>unrelated</div>`;
    expect(resolveStep({ testid: 'x', component: 'Y', text: 'zzz' })).toBeNull();
    expect(resolveStep({})).toBeNull();
  });

  it('skips hidden testid matches in favor of a visible one', () => {
    document.body.innerHTML = `
      <div hidden><button id="h" data-testid="save">Save</button></div>
      <button id="v" data-testid="save">Save</button>`;
    expect(resolveStep({ testid: 'save' })).toBe(get('#v'));
  });

  it('skips display:none and aria-hidden matches', () => {
    document.body.innerHTML = `
      <button data-testid="go" style="display:none">Go</button>
      <div aria-hidden="true"><button data-testid="go">Go</button></div>
      <button id="v" data-testid="go">Go</button>`;
    expect(resolveStep({ testid: 'go' })).toBe(get('#v'));
  });

  it('never resolves inside the ignored (widget host) subtree', () => {
    document.body.innerHTML = `
      <div id="widget"><button data-testid="save">Save</button></div>
      <button id="page" data-testid="save">Save</button>`;
    const ignore = get('#widget');
    expect(resolveStep({ testid: 'save' }, document, ignore)).toBe(get('#page'));
    expect(resolveStep({ text: 'Save' }, document, ignore)).toBe(get('#page'));
  });
});

describe('resolveByText', () => {
  it('prefers an exact interactive match over an exact non-interactive one', () => {
    document.body.innerHTML = `
      <span>Delete</span>
      <button id="btn">Delete</button>`;
    expect(resolveByText('Delete')).toBe(get('#btn'));
  });

  it('treats role="tab" and links as interactive', () => {
    document.body.innerHTML = `
      <div>Members</div>
      <div role="tab" id="tab">Members</div>`;
    expect(resolveByText('Members')).toBe(get('#tab'));
    document.body.innerHTML = `
      <p>Settings</p>
      <a id="link" href="/settings">Settings</a>`;
    expect(resolveByText('Settings')).toBe(get('#link'));
  });

  it('prefers exact over contains, even when the contains match is interactive', () => {
    document.body.innerHTML = `
      <button>Manage Lab Access now</button>
      <div id="exact">Manage Lab Access</div>`;
    expect(resolveByText('Manage Lab Access')).toBe(get('#exact'));
  });

  it('falls back to a contains match (truncated trail text)', () => {
    document.body.innerHTML = `<button id="b">Manage Lab Access for this workspace</button>`;
    // click-trail text is clamped to 40 chars — a prefix of the real label
    expect(resolveByText('Manage Lab Access for this workspace'.slice(0, 20))).toBe(get('#b'));
  });

  it('prefers the tightest contains match over a broad ancestor', () => {
    document.body.innerHTML = `
      <div id="broad">Lots of text around Manage Lab Access and more words here
        <span id="tight">around Manage Lab Access and</span>
      </div>`;
    expect(resolveByText('Manage Lab Access')).toBe(get('#tight'));
  });

  it('prefers an interactive contains match over a tighter non-interactive one', () => {
    document.body.innerHTML = `
      <span id="tight">A Save it x</span>
      <button id="btn">Save it now please, really</button>`;
    expect(resolveByText('Save it')).toBe(get('#btn'));
  });

  it('normalizes whitespace and case', () => {
    document.body.innerHTML = `<button id="b">  Manage
      Lab   Access </button>`;
    expect(resolveByText('manage lab access')).toBe(get('#b'));
  });

  it('ignores script/style text and returns null when nothing matches', () => {
    document.body.innerHTML = `<div><em>other</em></div>`;
    const script = document.createElement('script');
    script.textContent = 'const label = "Manage Lab Access";';
    document.body.appendChild(script);
    expect(resolveByText('Manage Lab Access')).toBeNull();
    expect(resolveByText('')).toBeNull();
  });
});

describe('startReplay — executes the real procedure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Set the page fixture, then mount the overlay container AFTER it (innerHTML wipes body). */
  function mount(fixtureHtml: string): HTMLElement {
    document.body.innerHTML = fixtureHtml;
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
  }

  function replay(container: HTMLElement, trail: ClickTrailEntry[], reducedMotion: boolean): ReplayHandle {
    return startReplay({ route: location.pathname, trail }, { container, reducedMotion });
  }

  async function finish(handle: ReplayHandle): Promise<{ shown: number; skipped: number } | null> {
    await vi.advanceTimersByTimeAsync(60_000);
    return handle.done;
  }

  it('performs a REAL click on the resolved element', async () => {
    const container = mount(`<button data-testid="go">Go</button>`);
    let clicks = 0;
    get('[data-testid="go"]').addEventListener('click', () => clicks++);
    const handle = replay(container, [{ ts: 1, route: location.pathname, kind: 'click', testid: 'go', text: 'Go' }], true);
    const result = await finish(handle);
    expect(clicks).toBe(1);
    expect(result).toEqual({ shown: 1, skipped: 0 });
  });

  it('treats kind-less entries as clicks (back-compat) and still clicks them', async () => {
    const container = mount(`<button data-testid="legacy">Old</button>`);
    let clicks = 0;
    get('[data-testid="legacy"]').addEventListener('click', () => clicks++);
    const handle = replay(container, [{ ts: 1, route: location.pathname, testid: 'legacy' }], true);
    const result = await finish(handle);
    expect(clicks).toBe(1);
    expect(result).toEqual({ shown: 1, skipped: 0 });
  });

  it('tolerates a click that navigates and resolves later steps against the new DOM', async () => {
    const container = mount(`<button data-testid="nav">Open</button>`);
    let afterClicks = 0;
    get('[data-testid="nav"]').addEventListener('click', () => {
      history.pushState({}, '', '/replay-nav-target');
      const btn = document.createElement('button');
      btn.setAttribute('data-testid', 'after');
      btn.textContent = 'After';
      btn.addEventListener('click', () => afterClicks++);
      document.body.appendChild(btn);
    });
    const handle = replay(
      container,
      [
        { ts: 1, route: '/start', kind: 'click', testid: 'nav', text: 'Open' },
        { ts: 2, route: '/replay-nav-target', kind: 'click', testid: 'after', text: 'After' },
      ],
      true,
    );
    const result = await finish(handle);
    expect(afterClicks).toBe(1);
    expect(result).toEqual({ shown: 2, skipped: 0 });
  });

  it('types into a controlled-like input via the native value setter, with input/change observed', async () => {
    const container = mount(`<label for="name">Name</label><input id="name" />`);
    const input = get('#name') as HTMLInputElement;
    const nativeGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get;
    if (!nativeGet) throw new Error('missing native value getter');
    const seen: string[] = [];
    let changes = 0;
    input.addEventListener('input', () => seen.push(String(nativeGet.call(input))));
    input.addEventListener('change', () => changes++);
    // React-style instance value tracker: a naive `input.value = x` write lands
    // HERE and would never reach the real DOM value.
    const naiveWrites: string[] = [];
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => 'tracked',
      set: (v: unknown) => {
        naiveWrites.push(String(v));
      },
    });
    const handle = replay(
      container,
      [{ ts: 1, route: location.pathname, kind: 'input', selector: '#name', value: 'abc' }],
      false, // animated path — character-by-character
    );
    const result = await finish(handle);
    expect(result).toEqual({ shown: 1, skipped: 0 });
    expect(seen).toEqual(['a', 'ab', 'abc']); // each keystroke dispatched 'input' with the real value set
    expect(changes).toBe(1);
    expect(nativeGet.call(input)).toBe('abc');
    expect(naiveWrites).toEqual([]); // the instance (tracker) setter was bypassed
    expect(document.activeElement).toBe(input);
  });

  it('caps character-by-character typing at 40 chars, then lands the full value at once', async () => {
    const long = 'z'.repeat(50);
    const container = mount(`<input id="big" />`);
    const input = get('#big') as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push(input.value));
    const handle = replay(
      container,
      [{ ts: 1, route: location.pathname, kind: 'input', selector: '#big', value: long }],
      false,
    );
    const result = await finish(handle);
    expect(result).toEqual({ shown: 1, skipped: 0 });
    expect(seen.length).toBe(41); // 40 typed chars + one final full-value set
    expect(seen[39]).toBe('z'.repeat(40));
    expect(seen[40]).toBe(long);
    expect(input.value).toBe(long);
  });

  it('sets the full value in one shot under reduced motion', async () => {
    const container = mount(`<input id="fast" />`);
    const input = get('#fast') as HTMLInputElement;
    const seen: string[] = [];
    let changes = 0;
    input.addEventListener('input', () => seen.push(input.value));
    input.addEventListener('change', () => changes++);
    const handle = replay(
      container,
      [{ ts: 1, route: location.pathname, kind: 'input', selector: '#fast', value: 'hello world' }],
      true,
    );
    const result = await finish(handle);
    expect(result).toEqual({ shown: 1, skipped: 0 });
    expect(seen).toEqual(['hello world']);
    expect(changes).toBe(1);
  });

  it('executes a select step by matching the option LABEL via the native setter, with change observed', async () => {
    const container = mount(
      `<select id="dept"><option value="1">Chemistry</option><option value="2">Molecular Biology</option></select>`,
    );
    const select = get('#dept') as HTMLSelectElement;
    const nativeGet = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.get;
    if (!nativeGet) throw new Error('missing native select value getter');
    const seen: string[] = [];
    let changes = 0;
    select.addEventListener('change', () => {
      changes++;
      seen.push(String(nativeGet.call(select)));
    });
    // React-style instance value tracker: a naive `select.value = x` write
    // lands HERE and would never reach the real DOM selection.
    const naiveWrites: string[] = [];
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: () => 'tracked',
      set: (v: unknown) => {
        naiveWrites.push(String(v));
      },
    });
    const handle = replay(
      container,
      [{ ts: 1, route: location.pathname, kind: 'input', selector: '#dept', value: 'Molecular Biology' }],
      true,
    );
    const result = await finish(handle);
    expect(result).toEqual({ shown: 1, skipped: 0 });
    expect(nativeGet.call(select)).toBe('2'); // label "Molecular Biology" matched back to its option
    expect(changes).toBe(1);
    expect(seen).toEqual(['2']);
    expect(naiveWrites).toEqual([]); // the instance (tracker) setter was bypassed
  });

  it('executes checkbox steps with a REAL click only when the recorded state differs', async () => {
    const container = mount(`<input type="checkbox" id="c" /><input type="checkbox" id="d" checked />`);
    const unchecked = get('#c') as HTMLInputElement;
    const alreadyChecked = get('#d') as HTMLInputElement;
    let clicksOnUnchecked = 0;
    let clicksOnChecked = 0;
    let changesOnUnchecked = 0;
    unchecked.addEventListener('click', () => clicksOnUnchecked++);
    unchecked.addEventListener('change', () => changesOnUnchecked++);
    alreadyChecked.addEventListener('click', () => clicksOnChecked++);
    const handle = replay(
      container,
      [
        { ts: 1, route: location.pathname, kind: 'input', selector: '#c', value: 'checked' },
        { ts: 2, route: location.pathname, kind: 'input', selector: '#d', value: 'checked' },
      ],
      true,
    );
    const result = await finish(handle);
    expect(result).toEqual({ shown: 2, skipped: 0 });
    expect(unchecked.checked).toBe(true);
    expect(clicksOnUnchecked).toBe(1); // real click — app handlers fired
    expect(changesOnUnchecked).toBe(1);
    expect(alreadyChecked.checked).toBe(true);
    expect(clicksOnChecked).toBe(0); // state already matched — no click
  });

  it("dispatches keydown/keyup Enter on the field for a 'pressed Enter' step", async () => {
    const container = mount(`<input id="q" />`);
    const input = get('#q') as HTMLInputElement;
    const keys: string[] = [];
    input.addEventListener('keydown', (e) => keys.push(`down:${(e as KeyboardEvent).key}`));
    input.addEventListener('keyup', (e) => keys.push(`up:${(e as KeyboardEvent).key}`));
    const handle = replay(
      container,
      [{ ts: 1, route: location.pathname, kind: 'click', text: 'pressed Enter', selector: '#q' }],
      true,
    );
    const result = await finish(handle);
    expect(result).toEqual({ shown: 1, skipped: 0 });
    expect(keys).toEqual(['down:Enter', 'up:Enter']);
    expect(document.activeElement).toBe(input);
  });

  it('counts an input step whose target is not a field as skipped', async () => {
    const container = mount(`<div id="box">just text</div>`);
    const handle = replay(
      container,
      [{ ts: 1, route: location.pathname, kind: 'input', selector: '#box', value: 'hi' }],
      true,
    );
    const result = await finish(handle);
    expect(result).toEqual({ shown: 0, skipped: 1 });
  });
});
