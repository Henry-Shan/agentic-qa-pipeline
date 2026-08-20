import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * GET /api/doc-replay/[id] — signed-URL redirect for a doc SECTION's rrweb
 * recording (contracts §QA Docs), mirroring /api/replay/[id] for reports.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const sectionId = Number(id);
  if (!Number.isInteger(sectionId) || sectionId <= 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: isTester } = await supabase.rpc('qa_is_tester');
  if (!isTester) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const admin = createServiceClient();
  const { data: section } = await admin
    .from('qa_doc_sections')
    .select('replay_path')
    .eq('id', sectionId)
    .maybeSingle();
  const path = (section?.replay_path as string | null) ?? null;
  if (!path) return NextResponse.json({ error: 'no replay' }, { status: 404 });

  const { data: signed } = await admin.storage.from('qa-screenshots').createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (!signed?.signedUrl) return NextResponse.json({ error: 'no replay' }, { status: 404 });

  return NextResponse.redirect(signed.signedUrl, 302);
}
