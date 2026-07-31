'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase/client';
import { useLive } from '@/lib/use-live';
import { useDisplayName } from '@/lib/display-names';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';
import { StatusPill } from '@/components/status-pill';
import { Pipeline } from '@/components/pipeline';
import { ConfirmDestroy, TrashIcon } from '@/components/confirm-delete';
import { ReportContext } from '@/components/task/report-context';
import { GroundingChips } from '@/components/task/grounding-chips';
import { NeedsHumanCard } from '@/components/task/needs-human-card';
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
  const router = useRouter();
  const [report, setReport] = useState<QaReport>(initialReport);
  const [run, setRun] = useState<QaRun | null>(initialRun);
  const [events, setEvents] = useState<QaEvent[]>(initialEvents);
  const [confirmingDestroy, setConfirmingDestroy] = useState(false);
  const [destroyBusy, setDestroyBusy] = useState(false);
  const [destroyError, setDestroyError] = useState<string | null>(null);
  const reporter = useDisplayName(report.reporter_email);
  const reportId = initialReport.id;

  // Blocked + a needs_human hand-off → prominent amber summary above the log
  // (contracts § Needs-a-human). Latest such event wins (events are id-sorted).
  let needsHuman: QaEvent | null = null;
  if (report.status === 'blocked') {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event && event.type === 'needs_human') {
        needsHuman = event;
        break;
      }
    }
  }

  // "Delete everything": queue a `destroy` message (the worker tears down the
  // run, PR, worktree, and row) and cancel the report. Supabase returns errors
  // as values, not throws — BOTH writes must be checked or failures vanish
  // silently. On success we navigate home immediately (the worker cleanup
  // continues in the background); on failure the button re-enables and the
  // actual error shows underneath it.
  async function destroyEverything() {
    if (destroyBusy) return;
    setDestroyBusy(true);
    setDestroyError(null);
    setConfirmingDestroy(false);
    const supabase = getBrowserClient();
    let { error } = await supabase
      .from('qa_messages')
      .insert({ report_id: reportId, kind: 'destroy', author_email: userEmail, body: '' });
    if (!error) {
      ({ error } = await supabase.from('qa_reports').update({ status: 'cancelled' }).eq('id', reportId));
    }
    if (error) {
      setDestroyBusy(false);
      setDestroyError(`Delete failed — ${error.message}`);
      return;
    }
    // Keep the button in its "Deleting…" state while the router swaps pages.
    router.replace('/');
  }

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
          {report.reporter_email ? (
            <>
              {' · '}
              <span title={report.reporter_email}>filed by {reporter}</span>
            </>
          ) : null}
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
          {needsHuman ? <NeedsHumanCard report={report} event={needsHuman} /> : null}
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
          <ResultCard run={run} report={report} />
          <div className="cap-label mt-4">Talk to Claude — anytime</div>
          <SteerBox reportId={report.id} status={report.status} userEmail={userEmail} />

          <div className="relative mt-5">
            <button
              onClick={() => setConfirmingDestroy((v) => !v)}
              disabled={destroyBusy}
              aria-busy={destroyBusy}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red/40 bg-stage px-3.5 py-2 text-[12.5px] font-semibold text-red transition-colors hover:bg-red-soft disabled:opacity-50"
            >
              {destroyBusy ? (
                <>
                  <span className="spinner" aria-hidden />
                  Deleting…
                </>
              ) : (
                <>
                  <TrashIcon size={13} />
                  Delete everything
                </>
              )}
            </button>
            {destroyError ? (
              <p role="alert" className="mt-1.5 text-[11.5px] font-medium leading-[1.45] text-red">
                {destroyError}
              </p>
            ) : null}
            {confirmingDestroy ? (
              <ConfirmDestroy
                className="absolute bottom-full right-0 z-20 mb-2 w-[250px]"
                busy={destroyBusy}
                onConfirm={() => void destroyEverything()}
                onCancel={() => setConfirmingDestroy(false)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
