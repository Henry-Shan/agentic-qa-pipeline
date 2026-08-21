import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * GET /api/exam-shot/[examId]?i=N — signed-URL redirect for one frame the
 * examiner read (contracts §Examination), same auth pattern as /api/shot.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const examId = Number(id);
  const index = Number(request.nextUrl.searchParams.get('i') ?? '0');
  if (!Number.isInteger(examId) || examId <= 0 || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: isTester } = await supabase.rpc('qa_is_tester');
  if (!isTester) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const admin = createServiceClient();
  const { data: exam } = await admin.from('qa_examinations').select('shots').eq('id', examId).maybeSingle();
  const shots = (exam?.shots as string[] | null) ?? [];
  const path = shots[index];
  if (!path) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const { data: signed } = await admin.storage.from('qa-screenshots').createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (!signed?.signedUrl) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.redirect(signed.signedUrl, 302);
}
