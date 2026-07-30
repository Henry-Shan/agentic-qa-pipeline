import { STATUS_PILL } from '@/lib/status';
import type { ReportStatus } from '@/lib/types';

export function StatusPill({ status }: { status: ReportStatus }) {
  const pill = STATUS_PILL[status];
  return (
    <span
      className={`flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold ${pill.cls}`}
    >
      {pill.working ? <span className="working-dot" /> : null}
      {pill.label}
    </span>
  );
}
