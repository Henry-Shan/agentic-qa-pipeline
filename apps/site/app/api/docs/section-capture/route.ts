import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * POST /api/docs/section-capture — the doc-capture page received a widget draft
 * and needs somewhere to put the heavy blobs. Mints signed storage-upload URLs
 * under `doc-section-<id>/…` and pre-records the paths on the section (same
 * direct-upload pattern as /api/ingest — blobs must never ride a Vercel
 * request). Middleware guarantees the caller is a signed-in tester.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const { sectionId, shots, replay } = (raw ?? {}) as { sectionId?: unknown; shots?: unknown; replay?: unknown };
  const id = Number(sectionId);
  const shotCount = Number(shots);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(shotCount) || shotCount < 0 || shotCount > 4) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: section } = await admin.from('qa_doc_sections').select('id').eq('id', id).maybeSingle();
  if (!section) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const sign = async (path: string) => {
    await admin.storage.from('qa-screenshots').remove([path]).catch(() => {});
    const { data, error } = await admin.storage.from('qa-screenshots').createSignedUploadUrl(path);
    if (error || !data) return null;
    return { path, signedUrl: data.signedUrl, token: data.token };
  };

  const shotTargets: Array<{ path: string; signedUrl: string; token: string }> = [];
  const shotPaths: string[] = [];
  for (let i = 0; i < shotCount; i++) {
    const path = i === 0 ? `doc-section-${id}/marked.png` : `doc-section-${id}/marked-${i + 1}.png`;
    const target = await sign(path);
    if (target) {
      shotTargets.push(target);
      shotPaths.push(path);
    }
  }
  let replayTarget: { path: string; signedUrl: string; token: string } | null = null;
  if (replay === true) replayTarget = await sign(`doc-section-${id}/replay.json`);

  await admin
    .from('qa_doc_sections')
    .update({ screenshots: shotPaths, replay_path: replayTarget ? replayTarget.path : null })
    .eq('id', id);

  return NextResponse.json({ uploads: { shots: shotTargets, replay: replayTarget } });
}
