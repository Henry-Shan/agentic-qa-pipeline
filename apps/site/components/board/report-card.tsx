'use client';

import Link from 'next/link';
import { initialOf, relativeAge } from '@/lib/format';
import { useDisplayName } from '@/lib/display-names';
import type { QaReport, QaRun } from '@/lib/types';
import { StatusPill } from '@/components/status-pill';
import { Pipeline } from '@/components/pipeline';
import { firstLine } from '@/components/needs-human-text';

export function ReportCard({
  report,
  run,
  needsHuman,
}: {
  report: QaReport;
  run?: QaRun;
  /** Hand-off summary for a blocked report — its first line previews on the card. */
  needsHuman?: string;
}) {
  const fixing = report.status === 'running' || report.status === 'rework';
  const codeHint = report.source_file ?? report.component;
  const reporter = useDisplayName(report.reporter_email);

  return (
    <Link
      href={`/task/${report.id}`}
      className="sheet mb-2 block px-4 py-3 transition-colors hover:bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[14px] font-medium leading-snug">{report.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-3">
            <span className="flex items-center gap-1.5" title={report.reporter_email ?? undefined}>
              <span className="avatar">{initialOf(reporter)}</span>
              {reporter} ·{' '}
              <span suppressHydrationWarning>{relativeAge(report.created_at)}</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                report.kind === 'feature' ? 'bg-qa-soft text-qa' : 'bg-line-soft text-ink-2'
              }`}
            >
              {report.kind === 'feature' ? 'feature request' : 'bug'}
            </span>
            {report.assignee ? (
              <span
                title={`Assigned to ${report.assignee}`}
                className="rounded-full bg-qa-soft px-2 py-0.5 text-[11.5px] font-medium text-qa"
              >
                assigned · {report.assignee}
              </span>
            ) : null}
            {codeHint ? <span className="truncate font-mono">{codeHint}</span> : null}
            {report.console_log.length > 0 ? <span>console error attached</span> : null}
          </div>
        </div>
        <StatusPill status={report.status} runStatus={run?.status} />
      </div>

      <Pipeline status={report.status} />

      {fixing && run?.log_tail ? (
        <div className="mt-2 truncate rounded-[7px] bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-2">
          ▸ {run.log_tail}
        </div>
      ) : null}

      {report.status === 'blocked' && needsHuman ? (
        <div className="mt-2 truncate rounded-[7px] bg-amber-soft px-2.5 py-1.5 text-[12px] text-amber">
          {firstLine(needsHuman)}
        </div>
      ) : null}
    </Link>
  );
}
