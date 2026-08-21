import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/** Per-file cap — fixtures are spreadsheets and PDFs, not media. */
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 5;

/**
 * POST /api/docs/section-files — attach fixture files to a doc section
 * (contracts §Task input "Files"): the PDF/CSV that triggers the bug, which a
 * recording cannot carry. Stored at `doc-section-<id>/files/<name>`; dispatch
 * copies them into the report so the run can reproduce with them.
 * Middleware guarantees the caller is a signed-in tester.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'expected multipart form data' }, { status: 400 });
  }
  const id = Number(form.get('sectionId'));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'invalid section' }, { status: 400 });

  const admin = createServiceClient();
  const { data: section } = await admin.from('qa_doc_sections').select('files').eq('id', id).maybeSingle();
  if (!section) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const existing = ((section.files as string[] | null) ?? []).slice();
  const incoming = form.getAll('files').filter((f): f is File => f instanceof File);
  if (incoming.length === 0) return NextResponse.json({ error: 'no files' }, { status: 400 });

  for (const file of incoming.slice(0, MAX_FILES)) {
    if (file.size > MAX_BYTES) continue;
    // Keep the tester's filename (it is meaningful to Claude); strip path parts.
    const safe = file.name.replace(/[/\\]/g, '_').slice(-80) || 'file';
    const path = `doc-section-${id}/files/${safe}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error } = await admin.storage
      .from('qa-screenshots')
      .upload(path, bytes, { contentType: file.type || 'application/octet-stream', upsert: true });
    if (!error && !existing.includes(path)) existing.push(path);
  }

  await admin.from('qa_doc_sections').update({ files: existing }).eq('id', id);
  return NextResponse.json({ files: existing });
}
