'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { getBrowserClient } from '@/lib/supabase/client';
import { useLive } from '@/lib/use-live';
import { latestByReport, upsertReport } from '@/lib/merge';
import { TABS, tabOf, type TabKey } from '@/lib/status';
import type { QaReport, QaRun } from '@/lib/types';
import { ReportCard } from '@/components/board/report-card';
import { ViewSwitch } from '@/components/view-switch';

export function Board({
  initialReports,
  initialRuns,
}: {
  initialReports: QaReport[];
  initialRuns: QaRun[];
}) {
  const [reports, setReports] = useState<QaReport[]>(initialReports);
  const [runs, setRuns] = useState<Record<number, QaRun>>(() => latestByReport(initialRuns));
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
  }, []);

  useLive(
    'qa-board',
    [{ table: 'qa_reports' }, { table: 'qa_runs' }],
    (table, row) => {
      if (table === 'qa_reports') {
        const report = row as unknown as QaReport;
        setReports((prev) => upsertReport(prev, report));
      } else {
        const run = row as unknown as QaRun;
        setRuns((prev) => {
          const current = prev[run.report_id];
          if (current && current.id > run.id) return prev;
          return { ...prev, [run.report_id]: run };
        });
      }
    },
    () => void refetch(),
  );

  const counts: Record<TabKey, number> = { all: reports.length, fixing: 0, preview: 0, queued: 0, shipped: 0 };
  for (const report of reports) {
    const key = tabOf(report.status);
    if (key) counts[key]++;
  }

  const visible = tab === 'all' ? reports : reports.filter((r) => tabOf(r.status) === tab);

  return (
    <div>
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
