import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { DocView } from '@/components/docs/doc-view';
import type { QaDoc, QaDocSection, QaReport } from '@/lib/types';

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();

  const { data: docRow } = await supabase.from('qa_docs').select('*').eq('slug', slug).maybeSingle();
  const doc = docRow as QaDoc | null;
  if (!doc) notFound();

  const { data: sectionRows } = await supabase
    .from('qa_doc_sections')
    .select('*')
    .eq('doc_id', doc.id)
    .order('position', { ascending: true });
  const sections = (sectionRows ?? []) as QaDocSection[];

  const reportIds = sections.map((s) => s.report_id).filter((id): id is number => id !== null);
  let reports: QaReport[] = [];
  if (reportIds.length > 0) {
    const { data: reportRows } = await supabase.from('qa_reports').select('*').in('id', reportIds);
    reports = (reportRows ?? []) as QaReport[];
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-6">
      <DocView initialDoc={doc} initialSections={sections} initialReports={reports} />
    </main>
  );
}
