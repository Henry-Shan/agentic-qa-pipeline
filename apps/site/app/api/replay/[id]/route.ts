// Signed-URL redirect for an rrweb session recording (contracts § Session
// replay) — same auth pattern as /api/shot: QA session + qa_is_tester, then a
// 302 to a 10-minute signed URL. Two sources:
//   (default)   qa_reports.replay_path            — "Before (the report)"
//   ?src=after  qa_runs.after_replay_path of the  — "After the fix"
//               report's LATEST run
// Missing recording → 404.

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

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: isTester } = await supabase.rpc('qa_is_tester');
  if (!isTester) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const admin = createServiceClient();
  let path: string | null = null;

  if (request.nextUrl.searchParams.get('src') === 'after') {
    // Latest run only — the after-the-fix recording belongs to the run whose
    // preview the tester just replayed against.
    const { data: run } = await admin
      .from('qa_runs')
      .select('after_replay_path')
      .eq('report_id', reportId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    path = (run?.after_replay_path as string | null) ?? null;
  } else {
    const { data: report } = await admin
      .from('qa_reports')
      .select('replay_path')
      .eq('id', reportId)
      .maybeSingle();
    path = (report?.replay_path as string | null) ?? null;
  }

  if (!path) return NextResponse.json({ error: 'no replay' }, { status: 404 });

  const { data: signed } = await admin.storage.from('qa-screenshots').createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (!signed?.signedUrl) return NextResponse.json({ error: 'no replay' }, { status: 404 });

  return NextResponse.redirect(signed.signedUrl, 302);
}
