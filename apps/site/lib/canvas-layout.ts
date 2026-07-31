// Pure geometry + layout for the /canvas view. No DOM, no React — deterministic
// so server render, hydration, and every client recompute agree.
//
// Layout model (Figma reference): fixed SECTION containers stack VERTICALLY,
// one per row, in a fixed order. Every section has the same comfortable width;
// height is auto from its content grid — block pairs (screenshot card + sticky
// note) flow left→right and wrap within the section width. Empty sections
// collapse to a slim chip-only bar. Saved positions are absolute world coords
// and override the grid slot; section rects are sized from the default grid
// only, so layout never depends on drag state.

import type { QaReport } from '@/lib/types';

// ---- block pair cell (screenshot card beside its sticky note) ----
export const SHOT_W = 200;
export const SHOT_H = 140;
export const STICKY_W = 200;
export const PAIR_GAP = 14;
export const PAIR_W = SHOT_W + PAIR_GAP + STICKY_W; // 414
export const PAIR_H = 200; // grid cell height (shot 140 / clamped sticky ~150)

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

/** Fixed-order sections stacked top→bottom, one per row, sized to content. */
export function computeSections(reports: QaReport[]): SectionSpec[] {
  const counts = new Map<SectionName, number>();
  for (const report of reports) {
    const name = sectionOf(report.route);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names: SectionName[] = [...SECTION_ORDER];
  if ((counts.get('other') ?? 0) > 0) names.push('other');

  const cols = columnsPerSection();
  const out: SectionSpec[] = [];
  let y = CANVAS_ORIGIN_Y;
  for (const name of names) {
    const count = counts.get(name) ?? 0;
    const rows = Math.ceil(count / cols);
    const h =
      count === 0
        ? EMPTY_SECTION_H
        : SECTION_PAD_TOP + rows * PAIR_H + (rows - 1) * CELL_GAP_Y + SECTION_PAD_BOTTOM;
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
