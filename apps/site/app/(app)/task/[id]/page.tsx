import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { TaskView } from '@/components/task/task-view';
import type { QaEvent, QaReport, QaRun } from '@/lib/types';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reportId = Number(id);
  if (!Number.isInteger(reportId) || reportId <= 0) notFound();

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();

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

  const report = reportRes.data as QaReport | null;
  if (!report) notFound();
  const run = ((runRes.data ?? [])[0] ?? null) as QaRun | null;
  const events = ((eventsRes.data ?? []) as QaEvent[]).slice().reverse();

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-6">
      <TaskView
        initialReport={report}
        initialRun={run}
        initialEvents={events}
        userEmail={userData.user?.email ?? ''}
      />
    </main>
  );
}
