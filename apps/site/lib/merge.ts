// Realtime merge helpers for the board list.

import type { QaReport, QaRun } from '@/lib/types';

/** Latest run per report id (rows may arrive in any order). */
export function latestByReport(runs: QaRun[]): Record<number, QaRun> {
  const map: Record<number, QaRun> = {};
  for (const run of runs) {
    const current = map[run.report_id];
    if (!current || run.id > current.id) map[run.report_id] = run;
  }
  return map;
}

/** Insert-or-replace a report, newest first, capped at the page size (100). */
export function upsertReport(list: QaReport[], report: QaReport): QaReport[] {
  const next = list.filter((r) => r.id !== report.id);
  next.push(report);
  next.sort((a, b) => b.id - a.id);
  return next.slice(0, 100);
}
