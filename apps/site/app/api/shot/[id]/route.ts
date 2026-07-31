import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const SIGNED_URL_TTL_SECONDS = 10 * 60;

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const reportId = Number(id);
  if (!Number.isInteger(reportId) || reportId <= 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // ?i=N → the Nth stored screenshot path (default 0 = the primary capture).
  const rawIndex = request.nextUrl.searchParams.get('i');
  const index = rawIndex === null ? 0 : Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: isTester } = await supabase.rpc('qa_is_tester');
  if (!isTester) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const admin = createServiceClient();
  const { data: report } = await admin.from('qa_reports').select('screenshots').eq('id', reportId).maybeSingle();
  const path = (report?.screenshots as string[] | null)?.[index];
  if (!path) return NextResponse.json({ error: 'no screenshot' }, { status: 404 });

  const { data: signed } = await admin.storage.from('qa-screenshots').createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (!signed?.signedUrl) return NextResponse.json({ error: 'no screenshot' }, { status: 404 });

  return NextResponse.redirect(signed.signedUrl, 302);
}
