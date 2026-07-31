'use client';

// Prominent amber hand-off card shown on the task page when the run settled
// `blocked` and the worker stored a needs_human summary (contracts § Needs-a-
// human). Rendered above Claude's log.

import { useDisplayName } from '@/lib/display-names';
import { NeedsHumanText } from '@/components/needs-human-text';
import type { QaEvent, QaReport } from '@/lib/types';

export function NeedsHumanCard({ report, event }: { report: QaReport; event: QaEvent }) {
  const reporter = useDisplayName(report.reporter_email);
  return (
    <div className="mb-4 rounded-[14px] border border-amber/30 bg-amber-soft/50 p-4 shadow-card">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="working-dot flex-none text-amber" aria-hidden />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-amber">
          Needs {report.reporter_email ? reporter : 'a human'}
        </h2>
      </div>
      <NeedsHumanText text={event.message ?? ''} />
    </div>
  );
}
