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

  // Doc backlink (contracts §QA Docs): reports dispatched from a doc section.
  let docRef: { slug: string; title: string; section: string } | null = null;
  if (report.doc_section_id) {
    const { data: section } = await supabase
      .from('qa_doc_sections')
      .select('title, doc_id')
      .eq('id', report.doc_section_id)
      .maybeSingle();
    if (section) {
      const { data: doc } = await supabase
        .from('qa_docs')
        .select('slug, title')
        .eq('id', (section as { doc_id: number }).doc_id)
        .maybeSingle();
      if (doc) {
        docRef = {
          slug: (doc as { slug: string }).slug,
          title: (doc as { title: string }).title,
          section: (section as { title: string }).title,
        };
      }
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-6">
      {docRef ? (
        <p className="mb-2 text-[11.5px] text-ink-3">
          part of{' '}
          <a href={`/docs/${docRef.slug}`} className="font-semibold text-qa hover:underline">
            {docRef.title}
          </a>{' '}
          § {docRef.section || 'untitled section'}
        </p>
      ) : null}
      <TaskView
        initialReport={report}
        initialRun={run}
        initialEvents={events}
        userEmail={userData.user?.email ?? ''}
      />
    </main>
  );
}
