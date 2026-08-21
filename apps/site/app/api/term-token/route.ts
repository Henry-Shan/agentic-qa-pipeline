import { createHash, createHmac, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/** A token is handed straight to a socket — it never needs a long life. */
const TTL_MS = 60_000;

/**
 * POST /api/term-token — mint a single-use ticket for the attached terminal
 * (contracts §Terminal). Middleware already gates this route to signed-in
 * testers; this adds the two properties the worker needs to trust the socket:
 * the ticket names ONE report, and it expires in a minute.
 *
 * The signature uses the same construction as the tester cookie —
 * HMAC-SHA256 with SHA-256("qa-term-v1" + service-role key) — so the worker
 * verifies it without another shared secret. The key never leaves the server.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { data: isTester } = await supabase.rpc('qa_is_tester');
  if (!isTester) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const reportId = Number((raw as { reportId?: unknown } | null)?.reportId);
  if (!Number.isInteger(reportId) || reportId <= 0) {
    return NextResponse.json({ error: 'invalid report' }, { status: 400 });
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 500 });

  const exp = Date.now() + TTL_MS;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${reportId}.${exp}.${nonce}`;
  const key = createHash('sha256').update(`qa-term-v1${secret}`).digest();
  const sig = createHmac('sha256', key).update(payload).digest('base64url');

  return NextResponse.json({
    token: `${payload}.${sig}`,
    // The terminal host is bound to loopback; the browser reaches it directly.
    port: Number(process.env.QA_TERM_PORT ?? 4520),
  });
}
