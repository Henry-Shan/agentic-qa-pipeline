// Pure geometry + layout for the /canvas view. No DOM, no React — deterministic
// so server render, hydration, and every client recompute agree.
//
// Layout model: fixed Figma-style SECTION containers (directory, inventory, …)
// flow left→right and wrap into rows. Inside a section each report renders as
// an independent block pair (screenshot card + sticky note) packed into an
// index-based grid. Saved positions are absolute world coords and override the
// grid slot; section rects are sized from the default grid only, so layout
// never depends on drag state.

import type { QaReport } from '@/lib/types';

// ---- block pair cell (screenshot card beside its sticky note) ----
export const SHOT_W = 200;
export const SHOT_H = 140;
export const STICKY_W = 200;
export const PAIR_GAP = 14;
export const PAIR_W = SHOT_W + PAIR_GAP + STICKY_W; // 414
export const PAIR_H = 200; // grid cell height (shot 140 / clamped sticky ~150)

// ---- section chrome ----
export const SECTION_PAD_X = 28;
export const SECTION_PAD_TOP = 60; // room for the label chip
export const SECTION_PAD_BOTTOM = 28;
export const CELL_GAP_X = 32;
export const CELL_GAP_Y = 36;
export const SECTION_COLS = 2; // block pairs per row inside a section
export const EMPTY_SECTION_W = 240;
export const EMPTY_SECTION_H = 54; // just the chip, like an empty Figma section
export const SECTION_GAP = 48; // gap between sections on the canvas
export const CANVAS_ORIGIN_X = 60;
export const CANVAS_ORIGIN_Y = 60;
export const ROW_MAX_W = 2040; // wrap sections into a new row past this width

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

/** Fixed on-canvas order. `other` is appended only when something maps to it. */
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
}

export interface Point {
  x: number;
  y: number;
}

/** Fixed sections sized to their content, flowed into wrapping rows. */
export function computeSections(reports: QaReport[]): SectionSpec[] {
  const counts = new Map<SectionName, number>();
  for (const report of reports) {
    const name = sectionOf(report.route);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names: SectionName[] = [...SECTION_ORDER];
  if ((counts.get('other') ?? 0) > 0) names.push('other');

  const sized = names.map((name) => {
    const count = counts.get(name) ?? 0;
    if (count === 0) return { name, w: EMPTY_SECTION_W, h: EMPTY_SECTION_H, count };
    const cols = Math.min(SECTION_COLS, count);
    const rows = Math.ceil(count / cols);
    return {
      name,
      w: SECTION_PAD_X * 2 + cols * PAIR_W + (cols - 1) * CELL_GAP_X,
      h: SECTION_PAD_TOP + rows * PAIR_H + (rows - 1) * CELL_GAP_Y + SECTION_PAD_BOTTOM,
      count,
    };
  });

  const out: SectionSpec[] = [];
  let x = CANVAS_ORIGIN_X;
  let y = CANVAS_ORIGIN_Y;
  let rowH = 0;
  for (const s of sized) {
    if (x > CANVAS_ORIGIN_X && x + s.w > ROW_MAX_W) {
      x = CANVAS_ORIGIN_X;
      y += rowH + SECTION_GAP;
      rowH = 0;
    }
    out.push({ ...s, x, y });
    x += s.w + SECTION_GAP;
    rowH = Math.max(rowH, s.h);
  }
  return out;
}

/** Default grid slot (absolute world coords) for pair `index` in a section. */
export function defaultPairPos(section: SectionSpec, index: number): Point {
  const cols = Math.min(SECTION_COLS, Math.max(1, section.count));
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
