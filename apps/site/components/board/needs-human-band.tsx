'use client';

// "Needs {displayName}" — the personal blocked-reports band pinned above the
// board's filter tabs (contracts § Needs-a-human). Lists reports blocked on the
// signed-in tester, each collapsed to the first line of the worker's
// needs_human hand-off with an expand chevron.

import { useState } from 'react';
import Link from 'next/link';
import { relativeAge } from '@/lib/format';
import { useDisplayName } from '@/lib/display-names';
import { boldSpans, firstLine, NeedsHumanText } from '@/components/needs-human-text';
import type { QaEvent, QaReport } from '@/lib/types';

export function NeedsHumanBand({
  reports,
  events,
  userEmail,
}: {
  /** Blocked reports filed by the signed-in user, newest first. */
  reports: QaReport[];
  /** Latest needs_human event per report id. */
  events: Record<number, QaEvent>;
  userEmail: string;
}) {
  const name = useDisplayName(userEmail);
  if (reports.length === 0) return null;

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
        {reports.map((report) => (
          <BandItem key={report.id} report={report} event={events[report.id]} />
        ))}
      </ul>
    </section>
  );
}

function BandItem({ report, event }: { report: QaReport; event?: QaEvent }) {
  const [open, setOpen] = useState(false);
  const message = event?.message ?? null;

  return (
    <li className="border-t border-amber/15 px-4 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13.5px] font-semibold">{report.title}</span>
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
              <p className="text-[12.5px] italic text-ink-3">Claude is writing the hand-off…</p>
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
