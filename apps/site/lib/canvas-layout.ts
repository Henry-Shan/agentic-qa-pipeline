// Pure geometry + layout for the /canvas view. No DOM, no React — deterministic
// so server render, hydration, and every client recompute agree.

import type { QaReport } from '@/lib/types';

export const FRAME_W = 240;
export const FRAME_Y = 150;
export const FRAME_X0 = 250;
export const FRAME_STEP = 560;
export const STICKY_W = 200;
export const SPINE_Y = 70;
export const DEFAULT_FRAME_H = 320;
export const DEFAULT_STICKY_H = 120;

/** Statuses that no longer count as "open" work for the frame chip. */
const CLOSED = new Set<QaReport['status']>(['shipped', 'verified', 'cancelled']);

export interface FrameSpec {
  route: string;
  x: number;
  /** Newest report on this route that has a screenshot — fills the frame body. */
  shotReportId: number | null;
  openCount: number;
  total: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function routeOf(report: QaReport): string {
  return report.route?.trim() || '/';
}

/** '/inventory/edit-item' → 'Inventory · Edit item'; '/' → 'Home'. */
export function humanizeRoute(route: string): string {
  const segments = route.split('/').filter(Boolean);
  if (segments.length === 0) return 'Home';
  return segments
    .map((s) => s.replace(/[-_]+/g, ' ').trim())
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .join(' · ');
}

/** One frame per route, left→right, busiest route first (ties: route name). */
export function computeFrames(reports: QaReport[]): FrameSpec[] {
  const groups = new Map<string, QaReport[]>();
  for (const report of reports) {
    const route = routeOf(report);
    const group = groups.get(route);
    if (group) group.push(report);
    else groups.set(route, [report]);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  return sorted.map(([route, group], i) => {
    let shotReportId: number | null = null;
    for (const r of group) {
      if (r.screenshots.length > 0 && (shotReportId === null || r.id > shotReportId)) shotReportId = r.id;
    }
    return {
      route,
      x: FRAME_X0 + i * FRAME_STEP,
      shotReportId,
      openCount: group.filter((r) => !CLOSED.has(r.status)).length,
      total: group.length,
    };
  });
}

/** Deterministic column beside a frame for stickies without a saved position. */
export function autoPlace(frameX: number, index: number): Point {
  return { x: frameX + FRAME_W + 24 + (index % 2) * 18, y: FRAME_Y + index * 168 };
}

/** Midpoint of the rect edge nearest to (cx, cy). */
export function nearestEdgeMidpoint(rect: Rect, cx: number, cy: number): Point {
  if (cx < rect.x) return { x: rect.x, y: rect.y + rect.h / 2 };
  if (cx > rect.x + rect.w) return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
  return cy < rect.y
    ? { x: rect.x + rect.w / 2, y: rect.y }
    : { x: rect.x + rect.w / 2, y: rect.y + rect.h };
}

/** Wire start on the sticky's edge nearest to the target (reference geometry). */
export function stickyEdgePoint(rect: Rect, target: Point): Point {
  const sx = target.x > rect.x + rect.w ? rect.x + rect.w : target.x < rect.x ? rect.x : rect.x + rect.w / 2;
  const sy =
    sx === rect.x || sx === rect.x + rect.w
      ? rect.y + rect.h / 2
      : target.y > rect.y
        ? rect.y + rect.h
        : rect.y;
  return { x: sx, y: sy };
}

/** Dashed bezier path between two points (horizontal S-curve). */
export function wirePath(from: Point, to: Point): string {
  const mx = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x} ${to.y}`;
}

/** Route of the frame whose center is horizontally nearest to x; '/' if none. */
export function nearestFrameRoute(frames: FrameSpec[], x: number): string {
  let best = '/';
  let bestDist = Infinity;
  for (const frame of frames) {
    const d = Math.abs(frame.x + FRAME_W / 2 - x);
    if (d < bestDist) {
      bestDist = d;
      best = frame.route;
    }
  }
  return best;
}
