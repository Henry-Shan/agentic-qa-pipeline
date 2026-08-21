import { STATUS_PILL } from '@/lib/status';
import type { ReportStatus } from '@/lib/types';

/**
 * `runStatus` refines the report's own status: a queued report whose last run
 * was INTERRUPTED is not waiting to start, it is waiting to RESUME — and that
 * resume is automatic, so the pill must not read like something needs doing.
 *
 * `previewStatus`/`previewUrl` do the same for a report sitting at `preview`.
 * That status only records that a preview was once built; the dev server behind
 * it is evicted whenever the machine needs the room. Reading "Preview live" for a
 * server that is not running sends people looking for a button that is not there,
 * so the pill distinguishes three real states:
 *
 *   live                        → "Preview live"
 *   asleep, permanent URL       → "Preview waiting" (opening it starts it)
 *   no shareable URL at all     → "Preview not deployed"
 */
export function StatusPill({
  status,
  runStatus,
  previewStatus,
  previewUrl,
}: {
  status: ReportStatus;
  runStatus?: string;
  previewStatus?: string | null;
  previewUrl?: string | null;
}) {
  const paused = status === 'queued' && runStatus === 'interrupted';
  let pill = paused
    ? { label: 'Paused — resumes automatically', cls: 'bg-amber-soft text-amber', working: true }
    : STATUS_PILL[status];
  let title: string | undefined;

  if (!paused && status === 'preview' && previewStatus !== 'live') {
    // A localhost URL is only openable on the machine that built it, so it does
    // not count as deployed for anyone reading this board.
    if (previewUrl?.startsWith('https://')) {
      pill = { label: 'Preview waiting', cls: 'bg-line-soft text-ink-2' };
      title = 'The preview is asleep. Opening it starts it back up — about a minute.';
    } else {
      pill = { label: 'Preview not deployed', cls: 'bg-line-soft text-ink-3' };
      title = 'A preview was built but is not reachable from here.';
    }
  }

  return (
    <span
      title={title}
      className={`flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold ${pill.cls}`}
    >
      {pill.working ? <span className="working-dot" /> : null}
      {pill.label}
    </span>
  );
}
