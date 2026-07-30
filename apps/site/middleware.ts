import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

const TESTER_COOKIE = 'qa-tester';
// Cache the qa_is_tester() RPC result for 5 minutes to avoid a per-request round trip.
const TESTER_TTL_SECONDS = 5 * 60;

// The cache cookie is signed so it cannot be forged:
//   value  = <userId>.<expiresEpoch>.<sig>
//   sig    = base64url( HMAC-SHA256( `${userId}.${expiresEpoch}`, key ) )
//   key    = SHA-256( "qa-cookie-v1" + SUPABASE_SERVICE_ROLE_KEY )
// Web Crypto only (edge-safe). Invalid/expired → fall through to the RPC and re-set.

const encoder = new TextEncoder();
let hmacKeyPromise: Promise<CryptoKey> | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (!hmacKeyPromise) {
    hmacKeyPromise = crypto.subtle
      .digest('SHA-256', encoder.encode(`qa-cookie-v1${secret}`))
      .then((material) =>
        crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      );
  }
  return hmacKeyPromise;
}

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signTester(secret: string, userId: string, expiresEpoch: number): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${userId}.${expiresEpoch}`));
  return base64url(sig);
}

/** Constant-time string compare (byte-wise XOR accumulate; length mismatch also fails). */
function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  return diff === 0;
}

async function testerCookieValid(secret: string, value: string | undefined, userId: string): Promise<boolean> {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [cookieUserId, expiresRaw, sig] = parts;
  if (!cookieUserId || !expiresRaw || !sig) return false;
  if (cookieUserId !== userId) return false;
  const expiresEpoch = Number(expiresRaw);
  if (!Number.isInteger(expiresEpoch) || expiresEpoch * 1000 < Date.now()) return false;
  const expected = await signTester(secret, userId, expiresEpoch);
  return constantTimeEqual(sig, expected);
}

function withCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  return to;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { supabase, response, user } = await updateSession(request);
  const isLogin = pathname === '/login';
  const isApi = pathname.startsWith('/api/');

  if (!user) {
    if (isLogin) return response;
    if (isApi) return withCookies(response, NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
    return withCookies(response, NextResponse.redirect(new URL('/login', request.url)));
  }

  // /login handles the "not on the allowlist" screen itself for signed-in users.
  if (isLogin) return response;

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (secret && (await testerCookieValid(secret, request.cookies.get(TESTER_COOKIE)?.value, user.id))) {
    return response;
  }

  const { data: isTester } = await supabase.rpc('qa_is_tester');
  if (!isTester) {
    if (isApi) return withCookies(response, NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    return withCookies(response, NextResponse.redirect(new URL('/login', request.url)));
  }

  if (secret) {
    const expiresEpoch = Math.floor(Date.now() / 1000) + TESTER_TTL_SECONDS;
    const sig = await signTester(secret, user.id, expiresEpoch);
    response.cookies.set(TESTER_COOKIE, `${user.id}.${expiresEpoch}.${sig}`, {
      maxAge: TESTER_TTL_SECONDS,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
  }
  return response;
}

export const config = {
  // Everything except /api/ingest (widget endpoint, token/JWT-authed), Next
  // internals and static files. The static-file exclusion is guarded with
  // (?!api/) so a dotted /api/* path can never slip past auth.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/ingest|(?!api/).*\\.[\\w]+$).*)'],
};
