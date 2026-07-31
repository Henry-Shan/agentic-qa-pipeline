// Keyframe-player geometry + target resolution (contracts §Session replay,
// "Player UX … KEYFRAME slideshow"). Pure: no rrweb, no Replayer — a real
// jsdom iframe document stands in for the replayed page.

import { beforeEach, describe, expect, it } from 'vitest';
import { fitStage, projectPoint, stageZone, stepPoint, IDENTITY_TRANSFORM } from '../src/stage';

/** A replayed page lives in an iframe document — resolution must work there, not just in `document`. */
function replayedDoc(html: string): Document {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) throw new Error('no iframe document');
  doc.body.innerHTML = html;
  return doc;
}

/** jsdom lays nothing out — stub the rect the browser would have measured. */
function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('stepPoint — target resolution inside the replayed document', () => {
  it('follows selector → testid → component → text, one fallback at a time', () => {
    const doc = replayedDoc(`
      <button id="sel">Save</button>
      <button data-testid="save">Save</button>
      <div data-sentry-component="Panel">Save</div>
      <a href="#">Publish</a>`);
    const all = Array.from(doc.querySelectorAll('#sel, [data-testid="save"], [data-sentry-component="Panel"], a'));
    all.forEach((el, i) => stubRect(el, { left: i * 100, top: 0, width: 10, height: 10 }));

    const t = { scale: 1, left: 0, top: 0 };
    const step = { selector: '#sel', testid: 'save', component: 'Panel', text: 'Save' };
    expect(stepPoint(step, doc, t)).toEqual({ x: 5, y: 5 }); // #sel
    expect(stepPoint({ ...step, selector: '#gone' }, doc, t)).toEqual({ x: 105, y: 5 }); // testid
    expect(stepPoint({ selector: '#gone', component: 'Panel', text: 'Save' }, doc, t)).toEqual({ x: 205, y: 5 });
    expect(stepPoint({ selector: '#gone', testid: 'gone', text: 'Publish' }, doc, t)).toEqual({ x: 305, y: 5 });
  });

  it('tolerates an invalid selector and falls through to the testid', () => {
    const doc = replayedDoc(`<button data-testid="save">Save</button>`);
    stubRect(doc.querySelectorAll('[data-testid="save"]')[0]!, { left: 20, top: 40, width: 20, height: 10 });
    expect(stepPoint({ selector: ':::nope', testid: 'save' }, doc, IDENTITY_TRANSFORM)).toEqual({ x: 30, y: 45 });
  });

  it('is null (frame change, no cursor) when nothing resolves, and never throws', () => {
    const doc = replayedDoc(`<button>Other</button>`);
    expect(stepPoint({ selector: '#gone', testid: 'gone', component: 'Gone', text: 'Nope' }, doc, IDENTITY_TRANSFORM)).toBeNull();
    expect(stepPoint(undefined, doc, IDENTITY_TRANSFORM)).toBeNull();
    expect(stepPoint({ text: 'Other' }, null, IDENTITY_TRANSFORM)).toBeNull();
    expect(stepPoint({}, doc, IDENTITY_TRANSFORM)).toBeNull();
  });

  it('skips hidden matches the way the live replay engine does', () => {
    const doc = replayedDoc(`
      <button id="sel" hidden>Save</button>
      <button data-testid="save">Save</button>`);
    stubRect(doc.querySelectorAll('[data-testid="save"]')[0]!, { left: 0, top: 0, width: 8, height: 8 });
    expect(stepPoint({ selector: '#sel', testid: 'save' }, doc, IDENTITY_TRANSFORM)).toEqual({ x: 4, y: 4 });
  });
});

describe('fitStage — the letterbox transform', () => {
  it('contain-fits a wide recording and centers the slack vertically', () => {
    // 1600×1000 recording into a 400×250 stage: exact fit, no letterbox.
    expect(fitStage(400, 250, 1600, 1000)).toEqual({ scale: 0.25, left: 0, top: 0 });
    // 1000×1000 into 400×250: height binds (0.25), 275px of horizontal slack.
    expect(fitStage(400, 250, 1000, 1000)).toEqual({ scale: 0.25, left: 75, top: 0 });
    // 1600×400 into 400×400: width binds (0.25), 150px of vertical slack.
    expect(fitStage(400, 400, 1600, 400)).toEqual({ scale: 0.25, left: 0, top: 150 });
  });

  it('falls back to identity rather than NaN when a dimension is missing', () => {
    expect(fitStage(0, 250, 1600, 1000)).toEqual(IDENTITY_TRANSFORM);
    expect(fitStage(400, 250, 1600, 0)).toEqual(IDENTITY_TRANSFORM);
    expect(fitStage(400, 250, Number.NaN, 1000)).toEqual(IDENTITY_TRANSFORM);
  });
});

describe('projectPoint — iframe rect → overlay coordinates', () => {
  it('maps the rect center through the stage scale and offset', () => {
    const t = fitStage(400, 250, 1000, 1000); // scale .25, left 75, top 0
    // An element at (200,400) sized 100×50 inside the recording.
    expect(projectPoint({ left: 200, top: 400, width: 100, height: 50 }, t)).toEqual({
      x: 75 + 250 * 0.25,
      y: 0 + 425 * 0.25,
    });
  });

  it('is the identity for an unscaled, unoffset stage', () => {
    expect(projectPoint({ left: 10, top: 20, width: 4, height: 6 }, IDENTITY_TRANSFORM)).toEqual({ x: 12, y: 23 });
  });

  it('honors a letterbox offset on both axes', () => {
    const t = { scale: 0.5, left: 30, top: 12 };
    expect(projectPoint({ left: 0, top: 0, width: 40, height: 20 }, t)).toEqual({ x: 40, y: 17 });
  });
});

describe('stageZone — side-click navigation', () => {
  const W = 300; // thirds at 100 / 200

  it('steps back in the left third, forward in the right third, nowhere in the middle', () => {
    expect(stageZone(0, W)).toBe(-1);
    expect(stageZone(99, W)).toBe(-1);
    expect(stageZone(100, W)).toBe(0); // boundary belongs to the inert middle
    expect(stageZone(150, W)).toBe(0);
    expect(stageZone(200, W)).toBe(0);
    expect(stageZone(201, W)).toBe(1);
    expect(stageZone(W, W)).toBe(1);
  });

  it('is inert for a zero-width stage or a nonsense coordinate', () => {
    expect(stageZone(10, 0)).toBe(0);
    expect(stageZone(Number.NaN, W)).toBe(0);
    expect(stageZone(10, Number.NaN)).toBe(0);
  });
});
