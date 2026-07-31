// Parent-exists guard for task-page mutations.
//
// Every write on the task page hangs off a `qa_reports` row, and that row can
// disappear underneath an open tab: "Delete everything" queues a `destroy`
// message and the worker HARD-DELETES the report (contracts § destroy). Two
// failure shapes follow, and neither throws:
//
//   1. `update ... .eq('id', reportId)` matches ZERO rows — PostgREST returns
//      no error at all, so an unguarded caller happily reports success and
//      then trips over step 2.
//   2. `insert into qa_messages / qa_events` with that report_id — Postgres
//      raises FK violation 23503 (qa_events_report_id_fkey), surfaced as an
//      error VALUE.
//
// So: updates must prove they hit a row (`.select('id').maybeSingle()` →
// data null = gone) and inserts must classify 23503 as "gone" rather than as
// a generic failure. Never report success before the write is confirmed.

/** Shown when a write proves the report is gone; also the deleted-page copy. */
export const REPORT_GONE_MESSAGE = 'This report no longer exists — it was deleted.';

/** How long the deleted state stays up before returning to the board. */
export const REPORT_GONE_REDIRECT_MS = 1200;

interface WriteError {
  code?: string;
  message: string;
}

export interface WriteResult<T> {
  data: T | null;
  error: WriteError | null;
}

/** True when a failed write is an FK violation against a deleted report row. */
export function reportMissing(error: WriteError | null): boolean {
  if (!error) return false;
  return error.code === '23503' || /report_id_fkey/i.test(error.message);
}

export type GuardOutcome<T> =
  | { status: 'ok'; data: T | null }
  | { status: 'gone' }
  | { status: 'error'; message: string };

/**
 * Run one task-page mutation and classify the result as landed / parent gone /
 * genuinely failed.
 *
 * `requireRow` is for writes that TARGET the report row (updates): pair it
 * with `.select('id').maybeSingle()` so a zero-row match is read as "gone"
 * instead of silent success. Inserts that merely reference the report leave it
 * off — they are classified by the FK error.
 */
export async function guardReport<T>(
  run: () => PromiseLike<WriteResult<T>>,
  opts: { requireRow?: boolean } = {},
): Promise<GuardOutcome<T>> {
  const { data, error } = await run();
  if (error) {
    return reportMissing(error) ? { status: 'gone' } : { status: 'error', message: error.message };
  }
  if (opts.requireRow && data === null) return { status: 'gone' };
  return { status: 'ok', data };
}
