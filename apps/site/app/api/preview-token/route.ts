import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

/**
 * POST /api/preview-token — mint a one-time sign-in token for the signed-in
 * tester (middleware guarantees callers are allowlisted testers). The preview
 * embed passes the returned magic-link token_hash to the host app's
 * /qa-session page, which verifies it into a fresh, independent Supabase
 * session — no credentials typed, and the QA site's own session is untouched.
 */
export async function POST(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email;
  if (!email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const service = createServiceClient();
  const { data: link, error } = await service.auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = link?.properties?.hashed_token;
  if (error || !tokenHash) {
    return NextResponse.json({ error: error?.message ?? 'could not mint token' }, { status: 500 });
  }
  return NextResponse.json({ token_hash: tokenHash });
}
