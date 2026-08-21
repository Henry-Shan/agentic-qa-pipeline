import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { TaskView } from '@/components/task/task-view';
import type { QaEvent, QaExamination, QaReport, QaRun } from '@/lib/types';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reportId = Number(id);
  if (!Number.isInteger(reportId) || reportId <= 0) notFound();

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();

  const [reportRes, runRes, eventsRes, examRes] = await Promise.all([
    supabase.from('qa_reports').select('*').eq('id', reportId).maybeSingle(),
    supabase.from('qa_runs').select('*').eq('report_id', reportId).order('id', { ascending: false }).limit(1),
    supabase
      .from('qa_events')
      .select('*')
      .eq('report_id', reportId)
      .order('id', { ascending: false })
      .limit(500),
    supabase
      .from('qa_examinations')
      .select('*')
      .eq('report_id', reportId)
      .order('id', { ascending: false })
      .limit(1),
  ]);

  const report = reportRes.data as QaReport | null;
  if (!report) notFound();
  const run = ((runRes.data ?? [])[0] ?? null) as QaRun | null;
  const events = ((eventsRes.data ?? []) as QaEvent[]).slice().reverse();
  const examination = ((examRes.data ?? [])[0] ?? null) as QaExamination | null;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-6">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
        {report.lane ? (
          <span
            title={report.lane_reason ?? undefined}
            className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
              report.lane === 'fast'
                ? 'bg-green-soft text-green'
                : report.lane === 'infra'
                  ? 'bg-amber-soft text-amber'
                  : 'bg-line-soft text-ink-2'
            }`}
          >
            {report.lane === 'fast' ? 'fast lane' : report.lane === 'infra' ? 'infra — needs a human' : 'full pipeline'}
          </span>
        ) : null}
        {report.lane_reason ? <span className="min-w-0 truncate">{report.lane_reason}</span> : null}
      </div>
      <TaskView
        initialReport={report}
        initialRun={run}
        initialEvents={events}
        initialExamination={examination}
        userEmail={userData.user?.email ?? ''}
      />
    </main>
  );
}
