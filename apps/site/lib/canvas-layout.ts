// Pure geometry + layout for the /canvas view. No DOM, no React — deterministic
// so server render, hydration, and every client recompute agree.
//
// Layout model (Figma reference): fixed SECTION containers stack VERTICALLY,
// one per row, in a fixed order. Every section has the same comfortable width;
// height is auto from its content grid — block pairs (screenshot card + sticky
// note) flow left→right and wrap within the section width. Empty sections
// collapse to a slim chip-only bar. Saved positions are absolute world coords
// and override the grid slot; section rects are sized from the default grid
// only, so layout never depends on drag state. A report's section comes from
// its route unless its pos row carries a `section` override (drag-into-section).

import type { QaReport } from '@/lib/types';

// ---- block pair cell (screenshot card beside its sticky note) ----
export const SHOT_W = 320;
export const SHOT_H = 224; // proportional to the old 200×140 card, under the ~240 cap
export const STICKY_W = 200;
export const PAIR_GAP = 14;
export const PAIR_W = SHOT_W + PAIR_GAP + STICKY_W; // 534
export const PAIR_H = 240; // grid cell height (shot 224 / clamped sticky ~150)

// Estimated footprint of a free text label — used only to anchor arrows.
export const TEXT_BLOCK_W = 120;
export const TEXT_BLOCK_H = 28;

// ---- section chrome ----
export const SECTION_W = 1180; // fixed width — one section per row
export const SECTION_PAD_X = 28;
export const SECTION_PAD_TOP = 64; // 28px content padding + room for the label chip
export const SECTION_PAD_BOTTOM = 28;
export const CELL_GAP_X = 32;
export const CELL_GAP_Y = 36;
export const EMPTY_SECTION_H = 56; // slim chip-only bar, full section width
export const SECTION_GAP = 24; // vertical gap between stacked sections
export const CANVAS_ORIGIN_X = 60;
export const CANVAS_ORIGIN_Y = 60;

export type SectionName =
  | 'directory'
  | 'inventory'
  | 'order requests'
  | 'tools & machines'
  | 'reservation'
  | 'invoices'
  | 'messages'
  | 'settings'
  | 'other';

/** Fixed top→bottom order. `other` is appended only when something maps to it. */
export const SECTION_ORDER: readonly SectionName[] = [
  'directory',
  'inventory',
  'order requests',
  'tools & machines',
  'reservation',
  'invoices',
  'messages',
  'settings',
];

/** First path segment → section. */
const SEGMENT_TO_SECTION: Record<string, SectionName> = {
  directory: 'directory',
  inventory: 'inventory',
  orders: 'order requests',
  requests: 'order requests',
  tools: 'tools & machines',
  reservations: 'reservation',
  invoices: 'invoices',
  inbox: 'messages',
  settings: 'settings',
};

/** Representative route a section stamps onto reports created inside it. */
export const SECTION_ROUTE: Record<SectionName, string> = {
  directory: '/directory',
  inventory: '/inventory',
  'order requests': '/requests',
  'tools & machines': '/tools',
  reservation: '/reservations',
  invoices: '/invoices',
  messages: '/inbox',
  settings: '/settings',
  other: '/',
};

export function routeOf(report: QaReport): string {
  return report.route?.trim() || '/';
}

export function sectionOf(route: string | null | undefined): SectionName {
  const seg = (route ?? '').split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  return SEGMENT_TO_SECTION[seg] ?? 'other';
}

/** Guards a stored qa_canvas_blocks.section value (free text in the DB). */
export function isSectionName(s: string | null | undefined): s is SectionName {
  return !!s && s in SECTION_ROUTE;
}

export interface SectionSpec {
  name: SectionName;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Reports whose default grid slot lives in this section. */
  count: number;
  /** Block-pair columns that fit inside the section width. */
  cols: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Block-pair columns that fit in the fixed section width (≥1). */
function columnsPerSection(): number {
  const innerW = SECTION_W - SECTION_PAD_X * 2;
  return Math.max(1, Math.floor((innerW + CELL_GAP_X) / (PAIR_W + CELL_GAP_X)));
}

/** Section height for `count` member pairs at `cols` columns (0 → slim chip bar). */
export function sectionHeight(count: number, cols: number): number {
  if (count <= 0) return EMPTY_SECTION_H;
  const rows = Math.ceil(count / Math.max(1, cols));
  return SECTION_PAD_TOP + rows * PAIR_H + (rows - 1) * CELL_GAP_Y + SECTION_PAD_BOTTOM;
}

/**
 * Fixed-order sections stacked top→bottom, one per row, sized to content.
 * `sectionFor` resolves a report's section — callers pass the per-block
 * `section` override (when set) layered over the route-derived default.
 */
export function computeSections(
  reports: QaReport[],
  sectionFor: (report: QaReport) => SectionName = (r) => sectionOf(r.route),
): SectionSpec[] {
  const counts = new Map<SectionName, number>();
  for (const report of reports) {
    const name = sectionFor(report);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names: SectionName[] = [...SECTION_ORDER];
  if ((counts.get('other') ?? 0) > 0) names.push('other');

  const cols = columnsPerSection();
  const out: SectionSpec[] = [];
  let y = CANVAS_ORIGIN_Y;
  for (const name of names) {
    const count = counts.get(name) ?? 0;
    const h = sectionHeight(count, cols);
    out.push({ name, x: CANVAS_ORIGIN_X, y, w: SECTION_W, h, count, cols });
    y += h + SECTION_GAP;
  }
  return out;
}

/** Default grid slot (absolute world coords) for pair `index` in a section. */
export function defaultPairPos(section: SectionSpec, index: number): Point {
  const cols = Math.max(1, section.cols);
  return {
    x: section.x + SECTION_PAD_X + (index % cols) * (PAIR_W + CELL_GAP_X),
    y: section.y + SECTION_PAD_TOP + Math.floor(index / cols) * (PAIR_H + CELL_GAP_Y),
  };
}

/** Section whose rect contains the world point, or null (open canvas). */
export function sectionAt(sections: SectionSpec[], x: number, y: number): SectionSpec | null {
  for (const s of sections) {
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
  }
  return null;
}

// ---- arrow geometry ----

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function edgeMidpoints(r: Rect): Point[] {
  return [
    { x: r.x + r.w / 2, y: r.y }, // top
    { x: r.x + r.w, y: r.y + r.h / 2 }, // right
    { x: r.x + r.w / 2, y: r.y + r.h }, // bottom
    { x: r.x, y: r.y + r.h / 2 }, // left
  ];
}

/** Closest pair of edge midpoints between two block rects — arrow anchor points. */
export function nearestEdgeAnchors(a: Rect, b: Rect): { from: Point; to: Point } {
  const as = edgeMidpoints(a);
  const bs = edgeMidpoints(b);
  let best: { from: Point; to: Point } = {
    from: { x: a.x + a.w / 2, y: a.y },
    to: { x: b.x + b.w / 2, y: b.y },
  };
  let bestD = Infinity;
  for (const p of as) {
    for (const q of bs) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { from: p, to: q };
      }
    }
  }
  return best;
}
