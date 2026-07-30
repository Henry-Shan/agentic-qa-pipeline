import { beforeEach, describe, expect, it } from 'vitest';
import { annotationOf, buildSelector, elementMeta } from '../src/selector';

beforeEach(() => {
  document.body.innerHTML = '';
});

function byTestId(id: string): Element {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing fixture ${id}`);
  return el;
}

describe('buildSelector', () => {
  it('prefers a unique data-testid', () => {
    document.body.innerHTML = `<div><button data-testid="save">Save</button></div>`;
    expect(buildSelector(byTestId('save'))).toBe('[data-testid="save"]');
  });

  it('skips a duplicated data-testid but still resolves the element uniquely', () => {
    document.body.innerHTML = `
      <div class="a"><button data-testid="dup">One</button></div>
      <div class="b"><button data-testid="dup">Two</button></div>`;
    const target = document.querySelector('.b button');
    if (!target) throw new Error('fixture');
    const sel = buildSelector(target);
    expect(sel).not.toBe('[data-testid="dup"]');
    const found = document.querySelectorAll(sel);
    expect(found.length).toBe(1);
    expect(found[0]).toBe(target);
  });

  it('uses the id when present and unique', () => {
    document.body.innerHTML = `<div id="app"><span id="target">x</span></div>`;
    const el = document.getElementById('target');
    if (!el) throw new Error('fixture');
    expect(buildSelector(el)).toBe('#target');
  });

  it('builds a tag.class:nth-of-type chain that matches exactly one element', () => {
    document.body.innerHTML = `
      <div class="list">
        <div class="row"><button>a</button><button>b</button></div>
        <div class="row"><button>c</button><button>d</button></div>
      </div>`;
    const rows = document.querySelectorAll('.row');
    const target = rows[1]?.children[1];
    if (!target) throw new Error('fixture');
    const sel = buildSelector(target);
    const found = document.querySelectorAll(sel);
    expect(found.length).toBe(1);
    expect(found[0]).toBe(target);
    expect(sel).toContain('nth-of-type');
  });

  it('anchors on an ancestor id when one exists', () => {
    document.body.innerHTML = `<div id="panel"><ul><li>one</li><li>two</li></ul></div>`;
    const target = document.querySelectorAll('li')[1];
    if (!target) throw new Error('fixture');
    const sel = buildSelector(target);
    expect(sel.startsWith('#panel')).toBe(true);
    expect(document.querySelector(sel)).toBe(target);
  });

  it('caps the chain at 5 parts', () => {
    let html = '<span>deep</span>';
    for (let i = 0; i < 9; i++) html = `<div>${html}</div>`;
    document.body.innerHTML = html;
    const target = document.querySelector('span');
    if (!target) throw new Error('fixture');
    const sel = buildSelector(target);
    expect(sel.split(' > ').length).toBeLessThanOrEqual(5);
  });
});

describe('elementMeta', () => {
  it('reads sentry component/file, testid and trimmed text from the closest ancestors', () => {
    document.body.innerHTML = `
      <section data-sentry-component="InventoryView" data-sentry-source-file="InventoryView.tsx">
        <button data-testid="save">  Save
          changes   now </button>
      </section>`;
    const meta = elementMeta(byTestId('save'));
    expect(meta.component).toBe('InventoryView');
    expect(meta.sourceFile).toBe('InventoryView.tsx');
    expect(meta.testid).toBe('save');
    expect(meta.text).toBe('Save changes now');
  });

  it('reads plain component/file annotations (data-component family) from the closest ancestors', () => {
    document.body.innerHTML = `
      <section data-component="OrderTable" data-source-file="OrderTable.tsx">
        <button data-testid="submit">Submit</button>
      </section>`;
    const meta = elementMeta(byTestId('submit'));
    expect(meta.component).toBe('OrderTable');
    expect(meta.sourceFile).toBe('OrderTable.tsx');
  });

  it('omits fields that are absent', () => {
    document.body.innerHTML = `<div><em></em></div>`;
    const el = document.querySelector('em');
    if (!el) throw new Error('fixture');
    expect(elementMeta(el)).toEqual({});
  });

  it('clamps text to 120 chars', () => {
    document.body.innerHTML = `<p>${'y'.repeat(300)}</p>`;
    const el = document.querySelector('p');
    if (!el) throw new Error('fixture');
    expect(elementMeta(el).text?.length).toBe(120);
  });
});

describe('annotationOf', () => {
  it('reads the sentry attribute family', () => {
    document.body.innerHTML = `
      <div data-sentry-component="Board" data-sentry-source-file="Board.tsx"><span id="t">x</span></div>`;
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    expect(annotationOf(el)).toEqual({ component: 'Board', sourceFile: 'Board.tsx' });
  });

  it('reads the plain attribute family', () => {
    document.body.innerHTML = `
      <div data-component="Board" data-source-file="Board.tsx"><span id="t">x</span></div>`;
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    expect(annotationOf(el)).toEqual({ component: 'Board', sourceFile: 'Board.tsx' });
  });

  it('prefers the sentry attribute when both families are set on one element', () => {
    document.body.innerHTML = `
      <div data-sentry-component="SentryName" data-component="PlainName" id="t">x</div>`;
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    expect(annotationOf(el).component).toBe('SentryName');
  });

  it('takes the first non-empty value walking up, even across families', () => {
    document.body.innerHTML = `
      <div data-sentry-component="Outer" data-sentry-source-file="Outer.tsx">
        <div data-component="Inner">
          <span id="t">x</span>
        </div>
      </div>`;
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    const annotation = annotationOf(el);
    expect(annotation.component).toBe('Inner'); // closest ancestor wins regardless of family
    expect(annotation.sourceFile).toBe('Outer.tsx'); // source-file resolved independently
  });

  it('skips empty attribute values and keeps walking up', () => {
    document.body.innerHTML = `
      <div data-component="Outer">
        <div data-sentry-component=""><span id="t">x</span></div>
      </div>`;
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    expect(annotationOf(el).component).toBe('Outer');
  });

  it('returns an empty annotation when nothing is annotated', () => {
    document.body.innerHTML = `<div><span id="t">x</span></div>`;
    const el = document.getElementById('t');
    if (!el) throw new Error('fixture');
    expect(annotationOf(el)).toEqual({});
  });
});
