// "After the fix" recording upload (contracts § After-the-fix recording).
// The task page's embedded preview replays the reported steps against the run's
// preview build; the widget records that execution with rrweb and returns it on
// `qa-pipeline:replay-done`. This route stores it.
//
// Auth: EXACTLY like /api/shot — a QA session whose account passes qa_is_tester.
// Body: { runId: number, events: string }  (events = rrweb JSON, ≤8 MB of chars,
// stored VERBATIM — opaque display data, never parsed server-side).
// Effect: report-<id>/after-replay-<runId>.json in `qa-screenshots` (upsert, so
// re-running the replay overwrites) + qa_runs.after_replay_path (db/0007).

import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// Same cap the widget applies before sending (contracts § Replay message 9).
const MAX_EVENTS_CHARS = 8_000_000;

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'bad body' }, { status: 400 });
  }

  const { runId, events } = body as { runId?: unknown; events?: unknown };
  const run = Number(runId);
  if (!Number.isInteger(run) || run <= 0) {
    return NextResponse.json({ error: 'bad runId' }, { status: 400 });
  }
  if (typeof events !== 'string' || events.length === 0) {
    return NextResponse.json({ error: 'bad events' }, { status: 400 });
  }
  if (events.length > MAX_EVENTS_CHARS) {
    return NextResponse.json({ error: 'recording too large' }, { status: 413 });
  }

  const admin = createServiceClient();
  // The run must actually belong to this report — the path is derived from both.
  const { data: runRow } = await admin
    .from('qa_runs')
    .select('id')
    .eq('id', run)
    .eq('report_id', reportId)
    .maybeSingle();
  if (!runRow) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // An "After" is the tester's own steps re-executed on the fixed build. Without
  // a Before there are no steps to re-execute, so whatever the embed captured is
  // just a browsing session — it would sit in the hero labelled as a comparison
  // while having nothing to compare against. Refuse it.
  const { data: reportRow } = await admin
    .from('qa_reports')
    .select('replay_path')
    .eq('id', reportId)
    .maybeSingle();
  if (!reportRow?.replay_path) {
    return NextResponse.json({ error: 'no before recording — nothing to compare against' }, { status: 409 });
  }

  const path = `report-${reportId}/after-replay-${run}.json`;
  const { error: uploadError } = await admin.storage
    .from('qa-screenshots')
    .upload(path, events, { contentType: 'application/json', upsert: true });
  if (uploadError) {
    return NextResponse.json({ error: 'upload failed' }, { status: 500 });
  }

  // Supabase returns errors as values, not throws — an unchecked update would
  // leave the object stored but invisible to the hero.
  const { error: updateError } = await admin
    .from('qa_runs')
    .update({ after_replay_path: path })
    .eq('id', run);
  if (updateError) {
    return NextResponse.json({ error: 'save failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, path });
}
