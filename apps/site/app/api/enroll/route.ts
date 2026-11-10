import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const NAME_MAX = 24;

function codeMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Self-enroll into the tester list + save the tester's display name.
 * Body: `{ code?, name? }`.
 * - Enrollment: any authenticated host-app account plus the team access code
 *   (QA_ACCESS_CODE) becomes a tester; already-enrolled users pass regardless
 *   of the code.
 * - Name (when present, trimmed, 1-24 chars, kept as given): upsert into
 *   qa_tester_names and set qa_allowed_emails.display_name for the AUTHED
 *   email — never a client-claimed one.
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

  let body: { code?: unknown; name?: unknown } = {};
  try {
    body = (await request.json()) as { code?: unknown; name?: unknown };
  } catch {
    // fall through with empty body
  }
  const code = typeof body.code === 'string' ? body.code : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (body.name !== undefined && (name.length < 1 || name.length > NAME_MAX)) {
    return NextResponse.json({ error: `name must be 1-${NAME_MAX} characters` }, { status: 400 });
  }

  const admin = createServiceClient();
  const { data: existing } = await admin
    .from('qa_allowed_emails')
    .select('email, display_name')
    .eq('email', email)
    .maybeSingle();

  let enrolled = false;
  if (!existing) {
    const expected = process.env.QA_ACCESS_CODE;
    if (!expected || !code || !codeMatches(code, expected)) {
      return NextResponse.json({ error: 'wrong access code' }, { status: 403 });
    }
    const { error } = await admin
      .from('qa_allowed_emails')
      .insert({ email, added_by: 'self-enroll' });
    if (error) {
      return NextResponse.json({ error: 'enroll failed' }, { status: 500 });
    }
    enrolled = true;
  }

  let displayName = existing?.display_name ?? null;
  if (name) {
    const { error: nameError } = await admin
      .from('qa_tester_names')
      .upsert({ name }, { onConflict: 'name', ignoreDuplicates: true });
    const { error: updateError } = await admin
      .from('qa_allowed_emails')
      .update({ display_name: name })
      .eq('email', email);
    if (nameError || updateError) {
      return NextResponse.json({ error: 'could not save name' }, { status: 500 });
    }
    displayName = name;
  }

  return NextResponse.json({ ok: true, enrolled, display_name: displayName });
}
