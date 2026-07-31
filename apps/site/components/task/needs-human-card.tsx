'use client';

// Prominent amber hand-off card shown on the task page whenever the report is
// `blocked` (contracts § Needs-a-human). It carries the ASSIGNMENT next to the
// heading — "<name> is on it", or "unassigned" if somehow null — because the
// worker auto-assigns the moment a report blocks (contracts § Auto-assign on
// block), so this is where the human reading the hand-off learns whose it is.
// The summary body appears once the worker has stored a needs_human event; a
// report that blocked on a posted question has none yet, and gets a pointer to
// the log instead. Rendered above Claude's log.

import { useDisplayName } from '@/lib/display-names';
import { AssigneeChip } from '@/components/assignee-chip';
import { NeedsHumanText } from '@/components/needs-human-text';
import type { QaEvent, QaReport } from '@/lib/types';

export function NeedsHumanCard({ report, event }: { report: QaReport; event: QaEvent | null }) {
  const reporter = useDisplayName(report.reporter_email);
  return (
    <div className="mb-4 rounded-[14px] border border-amber/30 bg-amber-soft/50 p-4 shadow-card">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="working-dot flex-none text-amber" aria-hidden />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-amber">
          Needs {report.reporter_email ? reporter : 'a human'}
        </h2>
        <AssigneeChip assignee={report.assignee} />
      </div>
      {event ? (
        <NeedsHumanText text={event.message ?? ''} />
      ) : (
        <p className="text-[12.5px] leading-[1.55] text-ink-2">
          Waiting on a human — the details are in Claude&apos;s log below.
        </p>
      )}
    </div>
  );
}
