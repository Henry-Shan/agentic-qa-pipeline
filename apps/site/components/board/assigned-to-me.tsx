'use client';

// "Assigned to me" — every signed-in tester's personal task list, pinned above
// the board's filter tabs (contracts § "Assigned to me"). Membership lives in
// lib/merge.ts `inPersonalBand` so the server fetch and the live client filter
// agree: reports ASSIGNED to the tester's display name in any non-cancelled
// status, plus blocked reports they filed.
//
// Row content per the contract: blocked rows LEAD with the worker's needs_human
// hand-off — collapsed to its first line with an expand chevron — and carry an
// "<name> is on it" chip; non-blocked assigned rows show the status pill and
// the run's log tail. Every row links to its task.
//
// The section ALWAYS renders: an empty tester gets a quiet empty state instead
// of a vanishing band, so it stays a stable home. The amber treatment is
// reserved for when something is actually blocked.

import { useState } from 'react';
import Link from 'next/link';
import { relativeAge } from '@/lib/format';
import { AssigneeChip } from '@/components/assignee-chip';
import { boldSpans, firstLine, NeedsHumanText } from '@/components/needs-human-text';
import { StatusPill } from '@/components/status-pill';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';

export function AssignedToMe({
  items,
  events,
  runs,
}: {
  /** The tester's task-list rows, newest first (deduped by the board). */
  items: QaReport[];
  /** Latest needs_human event per report id. */
  events: Record<number, QaEvent>;
  /** Latest run per report id (for the log_tail line). */
  runs: Record<number, QaRun>;
}) {
  const needsHumanCount = items.filter((report) => report.status === 'blocked').length;
  const alert = needsHumanCount > 0;

  return (
    <section
      aria-label="Assigned to me"
      className={`mb-4 overflow-hidden rounded-[14px] border shadow-card ${
        alert ? 'border-amber/30 bg-amber-soft/50' : 'border-line bg-stage'
      }`}
    >
      <div
        className={`flex items-center gap-2 border-b px-4 pb-2 pt-3 ${
          alert ? 'border-amber/20' : 'border-line-soft'
        }`}
      >
        {alert ? <span className="working-dot flex-none text-amber" aria-hidden /> : null}
        <h2
          className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${
            alert ? 'text-amber' : 'text-ink-3'
          }`}
        >
          Assigned to me
        </h2>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${
            alert ? 'bg-amber/15 text-amber' : 'bg-line-soft text-ink-2'
          }`}
        >
          {items.length}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] leading-[1.5] text-ink-3">
          Nothing assigned to you — filed reports that get blocked will land here.
        </p>
      ) : (
        <ul>
          {items.map((report) => (
            <BandRow
              key={report.id}
              report={report}
              event={events[report.id]}
              run={runs[report.id]}
              alert={alert}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function BandRow({
  report,
  event,
  run,
  alert,
}: {
  report: QaReport;
  event?: QaEvent;
  run?: QaRun;
  /** The section is in its amber state — match the row hairlines to it. */
  alert: boolean;
}) {
  const [open, setOpen] = useState(false);
  const blocked = report.status === 'blocked';
  const message = event?.message ?? null;
  const expandable = blocked && message !== null;

  return (
    <li className={`border-t px-4 py-3 first:border-t-0 ${alert ? 'border-amber/15' : 'border-line-soft'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13.5px] font-semibold">{report.title}</span>
            {blocked ? <AssigneeChip assignee={report.assignee} /> : null}
            <span suppressHydrationWarning className="text-[11.5px] text-ink-3">
              {relativeAge(report.created_at)}
            </span>
          </div>
          <div className="mt-1">
            {blocked ? (
              message ? (
                open ? (
                  <NeedsHumanText text={message} />
                ) : (
                  <p className="truncate text-[12.5px] text-ink-2">{boldSpans(firstLine(message))}</p>
                )
              ) : (
                <p className="text-[12.5px] text-ink-2">
                  Blocked — waiting on a human. Open the task for the details.
                </p>
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
        {expandable ? (
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
