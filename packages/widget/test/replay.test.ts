import { beforeEach, describe, expect, it } from 'vitest';
import { resolveByText, resolveStep } from '../src/replay';

beforeEach(() => {
  document.body.innerHTML = '';
});

function get(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing fixture ${selector}`);
  return el;
}

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
