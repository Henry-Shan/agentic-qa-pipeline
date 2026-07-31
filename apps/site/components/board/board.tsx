'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { getBrowserClient } from '@/lib/supabase/client';
import { useLive } from '@/lib/use-live';
import { latestByReport, upsertReport } from '@/lib/merge';
import { TABS, tabOf, type TabKey } from '@/lib/status';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';
import { ReportCard } from '@/components/board/report-card';
import { NeedsHumanBand } from '@/components/board/needs-human-band';
import { ViewSwitch } from '@/components/view-switch';

/** Latest needs_human event per report id. */
function latestNeedsHuman(events: QaEvent[]): Record<number, QaEvent> {
  const map: Record<number, QaEvent> = {};
  for (const event of events) {
    const current = map[event.report_id];
    if (!current || event.id > current.id) map[event.report_id] = event;
  }
  return map;
}

export function Board({
  initialReports,
  initialRuns,
  initialNeedsHuman,
  userEmail,
}: {
  initialReports: QaReport[];
  initialRuns: QaRun[];
  initialNeedsHuman: QaEvent[];
  userEmail: string;
}) {
  const [reports, setReports] = useState<QaReport[]>(initialReports);
  const [runs, setRuns] = useState<Record<number, QaRun>>(() => latestByReport(initialRuns));
  const [needsHuman, setNeedsHuman] = useState<Record<number, QaEvent>>(() =>
    latestNeedsHuman(initialNeedsHuman),
  );
  const [tab, setTab] = useState<TabKey>('all');

  const refetch = useCallback(async () => {
    const supabase = getBrowserClient();
    const { data: reportRows } = await supabase
      .from('qa_reports')
      .select('*')
      .order('id', { ascending: false })
      .limit(100);
    if (!reportRows) return;
    const fresh = reportRows as QaReport[];
    setReports(fresh);
    if (fresh.length === 0) return;
    const { data: runRows } = await supabase
      .from('qa_runs')
      .select('*')
      .in(
        'report_id',
        fresh.map((r) => r.id),
      )
      .order('id', { ascending: false });
    if (runRows) setRuns(latestByReport(runRows as QaRun[]));

    // Hand-off summaries for the "Needs {name}" band — only the signed-in
    // user's blocked reports can appear there.
    const blockedIds = fresh
      .filter((r) => r.status === 'blocked' && r.reporter_email === userEmail)
      .map((r) => r.id);
    if (blockedIds.length === 0) return;
    const { data: eventRows } = await supabase
      .from('qa_events')
      .select('*')
      .eq('type', 'needs_human')
      .in('report_id', blockedIds)
      .order('id', { ascending: false });
    if (eventRows) setNeedsHuman((prev) => ({ ...prev, ...latestNeedsHuman(eventRows as QaEvent[]) }));
  }, [userEmail]);

  useLive(
    'qa-board',
    [{ table: 'qa_reports' }, { table: 'qa_runs' }, { table: 'qa_events', filter: 'type=eq.needs_human' }],
    (table, row) => {
      if (table === 'qa_reports') {
        const report = row as unknown as QaReport;
        setReports((prev) => upsertReport(prev, report));
      } else if (table === 'qa_runs') {
        const run = row as unknown as QaRun;
        setRuns((prev) => {
          const current = prev[run.report_id];
          if (current && current.id > run.id) return prev;
          return { ...prev, [run.report_id]: run };
        });
      } else {
        const event = row as unknown as QaEvent;
        if (event.type !== 'needs_human') return;
        setNeedsHuman((prev) => {
          const current = prev[event.report_id];
          if (current && current.id > event.id) return prev;
          return { ...prev, [event.report_id]: event };
        });
      }
    },
    () => void refetch(),
  );

  // Cancelled reports never show on the board — a cancelled row is a tombstone
  // the worker is still tearing down (it deletes the row when done).
  const live = reports.filter((r) => r.status !== 'cancelled');

  // Blocked reports filed by the signed-in user — pinned above the tabs.
  const needsMe = live.filter((r) => r.status === 'blocked' && r.reporter_email === userEmail);

  const counts: Record<TabKey, number> = { all: live.length, fixing: 0, preview: 0, queued: 0, shipped: 0 };
  for (const report of live) {
    const key = tabOf(report.status);
    if (key) counts[key]++;
  }

  const visible = tab === 'all' ? live : live.filter((r) => tabOf(r.status) === tab);

  return (
    <div>
      {needsMe.length > 0 ? (
        <NeedsHumanBand reports={needsMe} events={needsHuman} userEmail={userEmail} />
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <ViewSwitch active="list" />
          <div
            className="flex flex-wrap gap-0.5 rounded-lg border border-line bg-stage p-0.5"
            role="tablist"
            aria-label="Filter reports"
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-[7px] px-3 py-1 text-[12.5px] font-semibold transition-colors ${
                  tab === t.key ? 'bg-qa-soft text-qa' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {t.label} <b className="ml-0.5 tabular-nums">{counts[t.key]}</b>
              </button>
            ))}
          </div>
        </div>
        <Link
          href="/capture"
          className="inline-flex flex-none items-center gap-1.5 rounded-lg bg-qa px-4 py-2 text-[13px] font-bold text-on-accent shadow-card transition-colors hover:bg-qa-bright"
        >
          ＋ Report an issue
        </Link>
      </div>

      {visible.length === 0 ? (
        <div className="card py-10 text-center text-[13px] text-ink-3">
          Nothing here yet — reports filed from the widget inside example.com land on this board.
        </div>
      ) : (
        visible.map((report) => <ReportCard key={report.id} report={report} run={runs[report.id]} />)
      )}
    </div>
  );
}
