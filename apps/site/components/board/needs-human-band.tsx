'use client';

// "Needs {displayName}" — the signed-in tester's personal TASK LIST, pinned
// above the board's filter tabs (contracts § Assignment / § Needs-a-human):
// reports ASSIGNED to their display name (any non-cancelled status, marked
// with an "assigned" chip) plus blocked reports they filed. Each row shows
// the worker's needs_human hand-off when one exists — collapsed to its first
// line with an expand chevron — otherwise the status pill and latest log tail.

import { useState } from 'react';
import Link from 'next/link';
import { relativeAge } from '@/lib/format';
import { useDisplayName } from '@/lib/display-names';
import { boldSpans, firstLine, NeedsHumanText } from '@/components/needs-human-text';
import { StatusPill } from '@/components/status-pill';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';

export interface BandItem {
  report: QaReport;
  /** True when the report is assigned to the signed-in tester's display name. */
  assigned: boolean;
}

export function NeedsHumanBand({
  items,
  events,
  runs,
  userEmail,
}: {
  /** The tester's task-list rows, newest first (deduped by the board). */
  items: BandItem[];
  /** Latest needs_human event per report id. */
  events: Record<number, QaEvent>;
  /** Latest run per report id (for the log_tail fallback line). */
  runs: Record<number, QaRun>;
  userEmail: string;
}) {
  const name = useDisplayName(userEmail);
  if (items.length === 0) return null;

  return (
    <section
      aria-label={`Needs ${name}`}
      className="mb-4 overflow-hidden rounded-[14px] border border-amber/30 bg-amber-soft/50 shadow-card"
    >
      <div className="flex items-center gap-2 border-b border-amber/20 px-4 pb-2 pt-3">
        <span className="working-dot flex-none text-amber" aria-hidden />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-amber">
          Needs {name}
        </h2>
      </div>
      <ul>
        {items.map(({ report, assigned }) => (
          <BandRow
            key={report.id}
            report={report}
            assigned={assigned}
            event={events[report.id]}
            run={runs[report.id]}
          />
        ))}
      </ul>
    </section>
  );
}

function BandRow({
  report,
  assigned,
  event,
  run,
}: {
  report: QaReport;
  assigned: boolean;
  event?: QaEvent;
  run?: QaRun;
}) {
  const [open, setOpen] = useState(false);
  const message = event?.message ?? null;

  return (
    <li className="border-t border-amber/15 px-4 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13.5px] font-semibold">{report.title}</span>
            {assigned ? (
              <span className="rounded-full bg-qa-soft px-2 py-0.5 text-[10.5px] font-semibold text-qa">
                assigned
              </span>
            ) : null}
            <span suppressHydrationWarning className="text-[11.5px] text-ink-3">
              {relativeAge(report.created_at)}
            </span>
          </div>
          <div className="mt-1">
            {message ? (
              open ? (
                <NeedsHumanText text={message} />
              ) : (
                <p className="truncate text-[12.5px] text-ink-2">{boldSpans(firstLine(message))}</p>
              )
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                <StatusPill status={report.status} />
                {run?.log_tail ? (
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-3">
                    ▸ {run.log_tail}
                  </span>
                ) : null}
              </div>
            )}
          </div>
          <Link
            href={`/task/${report.id}`}
            className="mt-1.5 inline-block text-[12.5px] font-semibold text-qa hover:underline"
          >
            Open task →
          </Link>
        </div>
        {message ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Collapse summary' : 'Expand summary'}
            onClick={() => setOpen((v) => !v)}
            className="flex-none rounded-md p-1 text-amber transition-colors hover:bg-amber/10"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              aria-hidden
              className={`transition-transform ${open ? 'rotate-180' : ''}`}
            >
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
      </div>
    </li>
  );
}
