import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { NewDocButton } from '@/components/docs/new-doc-button';
import type { QaDoc, QaDocSection, QaReport } from '@/lib/types';

/** /docs — the planning view (contracts §QA Docs): docs with computed progress. */
export default async function DocsPage() {
  const supabase = await createClient();
  const [{ data: docRows }, { data: sectionRows }] = await Promise.all([
    supabase.from('qa_docs').select('*').order('updated_at', { ascending: false }),
    supabase.from('qa_doc_sections').select('id, doc_id, report_id'),
  ]);
  const docs = (docRows ?? []) as QaDoc[];
  const sections = (sectionRows ?? []) as Array<Pick<QaDocSection, 'id' | 'doc_id' | 'report_id'>>;

  // Shipped = the linked report reached verified/shipped.
  const reportIds = sections.map((s) => s.report_id).filter((id): id is number => id !== null);
  let shippedReports = new Set<number>();
  if (reportIds.length > 0) {
    const { data: reports } = await supabase
      .from('qa_reports')
      .select('id, status')
      .in('id', reportIds);
    shippedReports = new Set(
      ((reports ?? []) as Array<Pick<QaReport, 'id' | 'status'>>)
        .filter((r) => r.status === 'verified' || r.status === 'shipped')
        .map((r) => r.id),
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-bold">Docs</h1>
          <p className="text-[12px] text-ink-3">
            Plan the work in sections; each one dispatches to Claude and tracks its task.
          </p>
        </div>
        <NewDocButton />
      </div>

      <div className="rounded-[10px] border border-line bg-stage">
        {docs.length === 0 ? (
          <p className="px-5 py-8 text-center text-[12.5px] text-ink-3">
            No docs yet — create one and start splitting the work into sections.
          </p>
        ) : (
          docs.map((doc) => {
            const mine = sections.filter((s) => s.doc_id === doc.id);
            const shipped = mine.filter((s) => s.report_id !== null && shippedReports.has(s.report_id)).length;
            const pct = mine.length > 0 ? Math.round((shipped / mine.length) * 100) : 0;
            return (
              <Link
                key={doc.id}
                href={`/docs/${doc.slug}`}
                className="flex items-center gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-surface"
              >
                <span className="grid size-8 flex-none place-items-center rounded-lg bg-surface text-[15px]">
                  {doc.emoji || '📄'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{doc.title}</span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {doc.created_by ?? 'unknown'} · {mine.length} section{mine.length === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="flex flex-none items-center gap-2">
                  <span className="h-[5px] w-[92px] overflow-hidden rounded-full bg-surface">
                    <span className="block h-full rounded-full bg-qa" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="text-[10.5px] tabular-nums text-ink-3">
                    {shipped} / {mine.length} shipped
                  </span>
                </span>
              </Link>
            );
          })
        )}
      </div>
    </main>
  );
}
