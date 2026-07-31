'use client';

// "Assign to <me>" — a single secondary button in the task action row
// (contracts § Assignment). No picker: the only assignment this control offers
// is to the SIGNED-IN tester's own display name. Once the report is theirs the
// button becomes a quiet "Assigned to <me>" chip with a × to unassign. A
// report assigned to someone else still shows the button, so taking it over is
// one click.
//
// Assigning writes qa_reports.assignee and logs a system event "assigned to
// <name> by <assigner>"; unassigning clears it and logs the same way. The
// update is verified to have hit a row before the event is inserted — the
// report may have been deleted while this tab was open (see lib/report-gone).

import { useState } from 'react';
import { getBrowserClient } from '@/lib/supabase/client';
import { useDisplayName } from '@/lib/display-names';
import { guardReport } from '@/lib/report-gone';

interface Props {
  reportId: number;
  /** Current qa_reports.assignee (display name) or null. */
  assignee: string | null;
  userEmail: string;
  /** The report row is gone — the page swaps to its deleted state. */
  onReportGone: () => void;
}

export function AssignControl({ reportId, assignee, userEmail, onReportGone }: Props) {
  const myName = useDisplayName(userEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = assignee === myName;

  // Supabase returns errors as VALUES, and a zero-row update returns no error
  // at all — so the update is checked both ways before anything claims success.
  async function assign(name: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const updated = await guardReport(
      () =>
        supabase
          .from('qa_reports')
          .update({ assignee: name })
          .eq('id', reportId)
          .select('id')
          .maybeSingle(),
      { requireRow: true },
    );
    if (updated.status === 'gone') {
      onReportGone();
      return;
    }
    if (updated.status === 'error') {
      setBusy(false);
      setError(`Could not ${name ? 'assign' : 'unassign'} — ${updated.message}`);
      return;
    }
    const logged = await guardReport(() =>
      supabase.from('qa_events').insert({
        report_id: reportId,
        type: 'system',
        message: name ? `assigned to ${name} by ${myName}` : `unassigned by ${myName}`,
      }),
    );
    if (logged.status === 'gone') {
      onReportGone();
      return;
    }
    setBusy(false);
    if (logged.status === 'error') setError(`Saved, but logging the event failed — ${logged.message}`);
  }

  return (
    <div className="relative flex-none">
      {mine ? (
        <span className="flex h-9 items-center gap-1.5 rounded-lg border border-qa/40 bg-qa-soft pl-3 pr-1.5 text-[12.5px] font-semibold text-qa">
          Assigned to {myName}
          <button
            onClick={() => void assign(null)}
            disabled={busy}
            aria-label={`Unassign ${myName}`}
            title="Unassign"
            className="grid h-6 w-6 place-items-center rounded-md text-[13px] leading-none text-qa transition-colors hover:bg-qa/15 disabled:opacity-50"
          >
            ×
          </button>
        </span>
      ) : (
        <button
          onClick={() => void assign(myName)}
          disabled={busy}
          className="h-9 rounded-lg border border-qa/40 bg-stage px-3 text-[12.5px] font-semibold text-qa transition-colors hover:bg-qa-soft disabled:opacity-50"
        >
          Assign to {myName}
        </button>
      )}

      {/* Absolute so an error never changes the height of the action row. */}
      {error ? (
        <p
          role="alert"
          className="absolute left-0 top-full z-10 mt-1 w-56 max-w-[70vw] text-[11.5px] font-medium leading-[1.45] text-red"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
