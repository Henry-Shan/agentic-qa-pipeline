import { STATUS_PILL } from '@/lib/status';
import type { ReportStatus } from '@/lib/types';

/**
 * `runStatus` refines the report's own status: a queued report whose last run
 * was INTERRUPTED is not waiting to start, it is waiting to RESUME — and that
 * resume is automatic, so the pill must not read like something needs doing.
 */
export function StatusPill({ status, runStatus }: { status: ReportStatus; runStatus?: string }) {
  const paused = status === 'queued' && runStatus === 'interrupted';
  const pill = paused
    ? { label: 'Paused — resumes automatically', cls: 'bg-amber-soft text-amber', working: true }
    : STATUS_PILL[status];
  return (
    <span
      className={`flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold ${pill.cls}`}
    >
      {pill.working ? <span className="working-dot" /> : null}
      {pill.label}
    </span>
  );
}
