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
      className="card mb-3.5 block transition-colors hover:border-qa-bright"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold">{report.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-3">
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
                className="rounded-full bg-qa-soft px-2 py-0.5 text-[11px] font-semibold text-qa"
              >
                assigned · {report.assignee}
              </span>
            ) : null}
            {codeHint ? <span className="truncate font-mono">{codeHint}</span> : null}
            {report.console_log.length > 0 ? <span>console error attached</span> : null}
          </div>
        </div>
        <StatusPill status={report.status} />
      </div>

      <Pipeline status={report.status} />

      {fixing && run?.log_tail ? (
        <div className="mt-3 truncate rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-2">
          ▸ {run.log_tail}
        </div>
      ) : null}

      {report.status === 'blocked' && needsHuman ? (
        <div className="mt-3 truncate rounded-lg border border-amber/25 bg-amber-soft px-3 py-2 text-xs text-amber">
          {firstLine(needsHuman)}
        </div>
      ) : null}
    </Link>
  );
}
