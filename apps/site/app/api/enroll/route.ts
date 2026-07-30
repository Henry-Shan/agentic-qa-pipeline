import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

function codeMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Self-enroll into the tester list. Any authenticated the host app account plus the
 * team access code (QA_ACCESS_CODE) becomes a tester; already-enrolled users
 * pass regardless of the code.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email;
  if (!email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createServiceClient();
  const { data: existing } = await admin
    .from('qa_allowed_emails')
    .select('email')
    .eq('email', email)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ ok: true, enrolled: false });
  }

  const expected = process.env.QA_ACCESS_CODE;
  let code = '';
  try {
    code = String(((await request.json()) as { code?: unknown }).code ?? '');
  } catch {
    // fall through with empty code
  }
  if (!expected || !code || !codeMatches(code, expected)) {
    return NextResponse.json({ error: 'wrong access code' }, { status: 403 });
  }

  const { error } = await admin
    .from('qa_allowed_emails')
    .insert({ email, added_by: 'self-enroll' });
  if (error) {
    return NextResponse.json({ error: 'enroll failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, enrolled: true });
}
