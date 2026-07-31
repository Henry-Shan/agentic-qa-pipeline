// Keyframe-player geometry (contracts §Session replay, "Player UX … KEYFRAME
// slideshow"). Pure math + pure DOM reads, unit-tested in test/stage.test.ts.
//
// The replayed page is rendered at the TESTER's viewport size inside rrweb's
// iframe; the drawer shows it letterboxed inside a ~16:10 stage. `fitStage`
// computes that letterbox transform (the exact one applied to
// `replayer.wrapper`), and `projectPoint` maps a rect measured INSIDE the
// replay iframe into the overlay layer that sits above the stage — so the
// synthetic cursor lands on the pixel the tester actually clicked.

import { resolveStep, type ResolvableStep } from './resolve';

export interface Point {
  x: number;
  y: number;
}

/** The letterbox transform applied to the replayer wrapper: scale, then offset inside the stage. */
export interface StageTransform {
  scale: number;
  left: number;
  top: number;
}

/** Just the bits of a DOMRect the projection reads (so tests can hand in plain objects). */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const IDENTITY_TRANSFORM: StageTransform = { scale: 1, left: 0, top: 0 };

/**
 * Contain-fit `w×h` (the recorded viewport) into `cw×ch` (the stage box):
 * uniform scale, centered on the axis with slack. Non-positive inputs yield the
 * identity transform rather than NaN/Infinity.
 */
export function fitStage(cw: number, ch: number, w: number, h: number): StageTransform {
  if (!(cw > 0) || !(ch > 0) || !(w > 0) || !(h > 0)) return { ...IDENTITY_TRANSFORM };
  const scale = Math.min(cw / w, ch / h);
  return {
    scale,
    left: Math.max(0, (cw - w * scale) / 2),
    top: Math.max(0, (ch - h * scale) / 2),
  };
}

/**
 * Center of a rect measured inside the replay iframe → overlay coordinates.
 * The overlay shares the stage's box, and the iframe's own origin is the
 * wrapper's origin, so it is exactly `offset + rectCenter * scale`.
 */
export function projectPoint(rect: RectLike, t: StageTransform): Point {
  return {
    x: t.left + (rect.left + rect.width / 2) * t.scale,
    y: t.top + (rect.top + rect.height / 2) * t.scale,
  };
}

/**
 * Where a step's cursor should land, in overlay coordinates: resolve the step
 * inside the replayed document (selector → testid → component → text), measure
 * it, project it. `null` when it cannot be resolved or measured — the caller
 * then changes the frame with no cursor movement (never throws).
 */
export function stepPoint(
  entry: ResolvableStep | undefined,
  doc: Document | null | undefined,
  t: StageTransform,
): Point | null {
  if (!entry || !doc) return null;
  let el: Element | null = null;
  try {
    el = resolveStep(entry, doc);
  } catch {
    return null;
  }
  if (!el) return null;
  let rect: RectLike;
  try {
    rect = el.getBoundingClientRect();
  } catch {
    return null;
  }
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
  return projectPoint(rect, t);
}

/**
 * Side-click navigation: the LEFT third of the stage steps back (−1), the RIGHT
 * third steps forward (+1), the middle third is inert (0) so a stray click never
 * moves the slideshow.
 */
export function stageZone(offsetX: number, width: number): -1 | 0 | 1 {
  if (!(width > 0) || !Number.isFinite(offsetX)) return 0;
  if (offsetX < width / 3) return -1;
  if (offsetX > (width * 2) / 3) return 1;
  return 0;
}
