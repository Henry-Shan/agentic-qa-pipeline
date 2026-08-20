import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { DocCaptureFrame } from '@/components/docs/doc-capture-frame';
import type { QaDoc, QaDocSection } from '@/lib/types';

/** Full-screen capture for ONE doc section: navigate, pick, ⏺ record, attach. */
export default async function DocCapturePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sectionId = Number(id);
  if (!Number.isInteger(sectionId) || sectionId <= 0) notFound();

  const supabase = await createClient();
  const { data: sectionRow } = await supabase
    .from('qa_doc_sections')
    .select('*')
    .eq('id', sectionId)
    .maybeSingle();
  const section = sectionRow as QaDocSection | null;
  if (!section) notFound();
  const { data: docRow } = await supabase.from('qa_docs').select('*').eq('id', section.doc_id).maybeSingle();
  const doc = docRow as QaDoc | null;
  if (!doc) notFound();

  return (
    <div className="relative h-dvh bg-paper">
      <header className="flex h-12 items-center gap-4 border-b border-line bg-stage/90 px-4 backdrop-blur">
        <Link href={`/docs/${doc.slug}`} className="flex-none text-[13px] font-semibold text-qa hover:underline">
          ← {doc.title}
        </Link>
        <h1 className="flex-none truncate text-[14px] font-bold">
          Attach context · {section.title || 'untitled section'}
        </h1>
        <p className="hidden min-w-0 truncate text-[12.5px] text-ink-3 md:block">
          Navigate to the right place, click 🐛, ⏺ record the steps — Attach returns here.
        </p>
      </header>
      <DocCaptureFrame sectionId={section.id} docSlug={doc.slug} currentBody={section.body} />
    </div>
  );
}
