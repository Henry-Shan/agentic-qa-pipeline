'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { getBrowserClient } from '@/lib/supabase/client';
import { useLive } from '@/lib/use-live';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';
import { StatusPill } from '@/components/status-pill';
import { Pipeline } from '@/components/pipeline';
import { ReportContext } from '@/components/task/report-context';
import { GroundingChips } from '@/components/task/grounding-chips';
import { EventLog } from '@/components/task/event-log';
import { ResultCard } from '@/components/task/result-card';
import { SteerBox } from '@/components/task/steer-box';

interface Props {
  initialReport: QaReport;
  initialRun: QaRun | null;
  initialEvents: QaEvent[];
  userEmail: string;
}

export function TaskView({ initialReport, initialRun, initialEvents, userEmail }: Props) {
  const [report, setReport] = useState<QaReport>(initialReport);
  const [run, setRun] = useState<QaRun | null>(initialRun);
  const [events, setEvents] = useState<QaEvent[]>(initialEvents);
  const reportId = initialReport.id;

  const refetch = useCallback(async () => {
    const supabase = getBrowserClient();
    const [reportRes, runRes, eventsRes] = await Promise.all([
      supabase.from('qa_reports').select('*').eq('id', reportId).maybeSingle(),
      supabase.from('qa_runs').select('*').eq('report_id', reportId).order('id', { ascending: false }).limit(1),
      supabase
        .from('qa_events')
        .select('*')
        .eq('report_id', reportId)
        .order('id', { ascending: false })
        .limit(500),
    ]);
    if (reportRes.data) setReport(reportRes.data as QaReport);
    const latestRun = (runRes.data ?? [])[0] as QaRun | undefined;
    if (latestRun) setRun(latestRun);
    if (eventsRes.data) setEvents((eventsRes.data as QaEvent[]).slice().reverse());
  }, [reportId]);

  useLive(
    `qa-task-${reportId}`,
    [
      { table: 'qa_reports', filter: `id=eq.${reportId}` },
      { table: 'qa_runs', filter: `report_id=eq.${reportId}` },
      { table: 'qa_events', filter: `report_id=eq.${reportId}` },
    ],
    (table, row) => {
      if (table === 'qa_reports') {
        setReport(row as unknown as QaReport);
      } else if (table === 'qa_runs') {
        const next = row as unknown as QaRun;
        setRun((prev) => (prev && prev.id > next.id ? prev : next));
      } else {
        const event = row as unknown as QaEvent;
        setEvents((prev) =>
          prev.some((e) => e.id === event.id) ? prev : [...prev, event].sort((a, b) => a.id - b.id),
        );
      }
    },
    () => void refetch(),
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/" className="text-[13px] font-semibold text-qa">
          ← All reports
        </Link>
        <span className="font-mono text-[11.5px] text-ink-3">
          task #{report.id}
          {run?.branch ? ` · branch ${run.branch}` : ''}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-base font-semibold">{report.title}</h1>
        <StatusPill status={report.status} />
      </div>
      <Pipeline status={report.status} detail />

      <ReportContext report={report} />

      <div className="mt-5 grid gap-5 md:grid-cols-[3fr_2fr]">
        <div className="min-w-0">
          {run?.grounding?.length ? (
            <>
              <div className="cap-label">How Claude located it — full-stack trace</div>
              <GroundingChips chips={run.grounding} />
            </>
          ) : null}
          <div className="cap-label mt-4">Claude&apos;s log</div>
          <EventLog events={events} />
        </div>

        <div className="min-w-0">
          <div className="cap-label">Result</div>
          <ResultCard run={run} />
          <div className="cap-label mt-4">Talk to Claude — anytime</div>
          <SteerBox reportId={report.id} status={report.status} userEmail={userEmail} />
        </div>
      </div>
    </div>
  );
}
