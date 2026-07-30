import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clampIngest, decodeScreenshot, ingestSchema } from '@/lib/ingest/schema';
import { scrubSecrets } from '@/lib/ingest/scrub';

export const runtime = 'nodejs';

const STATIC_ORIGINS = new Set(['https://example.com', 'https://www.example.com']);
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;

// Hard request cap: 4 MB screenshot as base64 (~5.6 MB) + clamped logs, with
// headroom. Checked against content-length BEFORE the body is buffered so an
// oversized payload never allocates (`next start` has no platform body cap).
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function originAllowed(origin: string): boolean {
  return STATIC_ORIGINS.has(origin) || LOCALHOST_RE.test(origin);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-qa-token, authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function tokenMatches(provided: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin') ?? '';
  if (!originAllowed(origin)) {
    return NextResponse.json({ error: 'origin not allowed' }, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = origin && originAllowed(origin) ? corsHeaders(origin) : undefined;
  if (origin && !originAllowed(origin)) {
    return NextResponse.json({ error: 'origin not allowed' }, { status: 403 });
  }

  const admin = createServiceClient();

  // Auth, two alternatives:
  //  (a) `Authorization: Bearer <supabase jwt>` — verified with the service-role
  //      client; the verified email must be on qa_allowed_emails and OVERRIDES
  //      the body's reporterEmail.
  //  (b) `x-qa-token` static token (no Authorization header) — timing-safe
  //      compare; body reporterEmail is trusted as before.
  let verifiedEmail: string | null = null;
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const jwt = /^bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim();
    if (!jwt) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
    }
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    const email = userData?.user?.email;
    if (userError || !email) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
    }
    const { data: allowed } = await admin
      .from('qa_allowed_emails')
      .select('email')
      .eq('email', email)
      .maybeSingle();
    if (!allowed) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
    }
    verifiedEmail = email;
  } else {
    const expected = process.env.QA_INGEST_TOKEN;
    const provided = request.headers.get('x-qa-token') ?? '';
    if (!expected || !tokenMatches(provided, expected)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
    }
  }

  // Number(null) is NaN, so a missing/unparseable content-length also rejects —
  // the widget (and any JSON POST with a string body) always sends it.
  const contentLength = Number(request.headers.get('content-length'));
  if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'body too large' }, { status: 413, headers });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400, headers });
  }

  const parsed = ingestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`);
    return NextResponse.json({ error: 'invalid body', issues }, { status: 400, headers });
  }

  const { screenshotDataUrl, ...rest } = clampIngest(parsed.data);
  // Scrub everything except the screenshot (its base64 can coincidentally match the JWT pattern).
  const body = scrubSecrets(rest);
  // JWT path: the reporter is whoever the token verified as — never the body's claim.
  if (verifiedEmail) body.reporterEmail = verifiedEmail;

  const title = body.description.slice(0, 80).trim() || `Bug on ${body.route}`;

  const { data: inserted, error: insertError } = await admin
    .from('qa_reports')
    .insert({
      title,
      description: body.description,
      kind: body.kind,
      status: 'queued',
      reporter_email: body.reporterEmail ?? null,
      route: body.route,
      page_title: body.pageTitle,
      component: body.component ?? null,
      source_file: body.sourceFile ?? null,
      selector: body.selector ?? null,
      testid: body.testid ?? null,
      element_text: body.elementText ?? null,
      click_trail: body.clickTrail,
      console_log: body.consoleLog,
      network_log: body.networkLog,
      screenshots: [],
      viewport: body.viewport,
      app_context: body.appContext ?? null,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    return NextResponse.json({ error: 'insert failed' }, { status: 500, headers });
  }
  const id = inserted.id as number;

  if (screenshotDataUrl) {
    const buf = decodeScreenshot(screenshotDataUrl);
    if (buf) {
      const path = `report-${id}/marked.png`;
      const { error: uploadError } = await admin.storage
        .from('qa-screenshots')
        .upload(path, buf, { contentType: 'image/png', upsert: true });
      if (!uploadError) {
        await admin.from('qa_reports').update({ screenshots: [path] }).eq('id', id);
      }
    }
  }

  await admin.from('qa_events').insert({
    report_id: id,
    type: 'system',
    message: `filed by ${body.reporterEmail ?? 'unknown'}`,
  });

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  return NextResponse.json({ id, url: `${site}/task/${id}` }, { headers });
}
