import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clampIngest, decodeScreenshot, ingestSchema } from '@/lib/ingest/schema';
import { scrubSecrets } from '@/lib/ingest/scrub';

export const runtime = 'nodejs';

// Origins allowed to file reports: QA_HOST_ORIGINS (comma-separated), falling
// back to the origin of NEXT_PUBLIC_CAPTURE_URL. Localhost is always allowed.
const STATIC_ORIGINS = new Set(
  (process.env.QA_HOST_ORIGINS ?? process.env.NEXT_PUBLIC_CAPTURE_URL ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
);
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;

// Hard request cap: primary screenshot + up to 3 additional (each ≤4 MB PNG,
// ~5.6 MB as base64) + the rrweb recording (≤8M chars) + clamped logs. Checked
// against content-length BEFORE the body is buffered so an oversized payload
// never allocates (`next start` has no platform body cap).
const MAX_BODY_BYTES = 32 * 1024 * 1024;

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
  let verifiedDisplayName: string | null = null;
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
      .select('email, display_name')
      .eq('email', email)
      .maybeSingle();
    if (!allowed) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
    }
    verifiedEmail = email;
    verifiedDisplayName = (allowed as { display_name?: string | null }).display_name ?? null;
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

  // The rrweb recording is pulled off FIRST: it is opaque display data (contracts
  // § Session replay) — never clamped, and excluded from the scrubSecrets walk
  // (an 8M-char string would dominate the regex pass for no benefit).
  const { replayEvents, uploads, model, ...clampable } = parsed.data;
  const { screenshotDataUrl, screenshotsDataUrls, ...rest } = clampIngest(clampable);
  // Scrub everything except the screenshots (their base64 can coincidentally match the JWT pattern).
  const body = scrubSecrets(rest);
  // JWT path: the reporter is whoever the token verified as — never the body's claim.
  if (verifiedEmail) body.reporterEmail = verifiedEmail;

  // Role snapshot for dispatch context: the reporter's host-app memberships
  // (via an optional `profiles` table and `qa_reporter_roles(uid)` RPC in the host project). Failure-tolerant — a report
  // must still file if the lookup breaks.
  let appContext: Record<string, unknown> = { ...(body.appContext ?? {}) };
  if (body.reporterEmail) {
    try {
      const { data: profile } = await admin
        .from('profiles')
        .select('id, first_name, last_name')
        .eq('email', body.reporterEmail)
        .maybeSingle();
      if (profile) {
        const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
        if (name) appContext.reporterName = name;
        const { data: roles } = await admin.rpc('qa_reporter_roles', { uid: profile.id });
        if (Array.isArray(roles) && roles.length) appContext.reporterRoles = roles;
      }
    } catch {
      // best-effort enrichment only
    }
  }
  // The tester's chosen QA display name wins over the host-app profile name
  // (which stays as the fallback set above).
  if (verifiedDisplayName) appContext.reporterName = verifiedDisplayName;

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
      app_context: Object.keys(appContext).length ? appContext : null,
      // Which model runs the fix (contracts §Base context); null = worker default.
      model: model ?? null,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    return NextResponse.json({ error: 'insert failed' }, { status: 500, headers });
  }
  const id = inserted.id as number;

  // Primary → marked.png, additional → marked-2.png … in order;
  // qa_reports.screenshots lists every stored path (contracts §Widget→Site).
  const shots = [screenshotDataUrl, ...(screenshotsDataUrls ?? [])];
  const storedPaths: string[] = [];
  for (let i = 0; i < shots.length; i++) {
    const dataUrl = shots[i];
    if (!dataUrl) continue;
    const buf = decodeScreenshot(dataUrl);
    if (!buf) continue;
    const path = i === 0 ? `report-${id}/marked.png` : `report-${id}/marked-${i + 1}.png`;
    const { error: uploadError } = await admin.storage
      .from('qa-screenshots')
      .upload(path, buf, { contentType: 'image/png', upsert: true });
    if (!uploadError) storedPaths.push(path);
  }
  if (storedPaths.length > 0) {
    await admin.from('qa_reports').update({ screenshots: storedPaths }).eq('id', id);
  }

  // rrweb recording → report-<id>/replay.json + qa_reports.replay_path (db/0006).
  // Uploaded VERBATIM (opaque display data — never parsed server-side). Non-fatal:
  // the report already filed; a failure just means no replay player on the task.
  if (replayEvents) {
    try {
      const replayPath = `report-${id}/replay.json`;
      const { error: replayError } = await admin.storage
        .from('qa-screenshots')
        .upload(replayPath, replayEvents, { contentType: 'application/json', upsert: true });
      if (!replayError) {
        await admin.from('qa_reports').update({ replay_path: replayPath }).eq('id', id);
      }
    } catch {
      // best-effort — the report still files without a replay
    }
  }

  await admin.from('qa_events').insert({
    report_id: id,
    type: 'system',
    message: `filed by ${body.reporterEmail ?? 'unknown'}`,
  });

  // Direct-upload mode: mint signed storage-upload URLs for the declared blobs
  // and pre-record their paths — the widget PUTs binary straight to Supabase,
  // keeping this POST far under Vercel's ~4.5 MB serverless body cap. Paths
  // mirror the inline flow exactly (marked.png, marked-2.png…, replay.json).
  let uploadTargets: { shots: Array<{ path: string; signedUrl: string; token: string }>; replay: { path: string; signedUrl: string; token: string } | null } | undefined;
  if (uploads && (uploads.shots > 0 || uploads.replay)) {
    const sign = async (path: string) => {
      // Re-filed drafts may retry after a partial attempt: clear any stale
      // object first — createSignedUploadUrl rejects existing paths.
      await admin.storage.from('qa-screenshots').remove([path]).catch(() => {});
      const { data, error } = await admin.storage.from('qa-screenshots').createSignedUploadUrl(path);
      if (error || !data) return null;
      return { path, signedUrl: data.signedUrl, token: data.token };
    };
    const shotTargets: Array<{ path: string; signedUrl: string; token: string }> = [];
    const shotPaths: string[] = [];
    for (let i = 0; i < uploads.shots; i++) {
      const path = i === 0 ? `report-${id}/marked.png` : `report-${id}/marked-${i + 1}.png`;
      const target = await sign(path);
      if (target) {
        shotTargets.push(target);
        shotPaths.push(path);
      }
    }
    let replayTarget: { path: string; signedUrl: string; token: string } | null = null;
    if (uploads.replay) {
      replayTarget = await sign(`report-${id}/replay.json`);
    }
    const patch: Record<string, unknown> = {};
    if (shotPaths.length > 0) patch.screenshots = shotPaths;
    if (replayTarget) patch.replay_path = replayTarget.path;
    if (Object.keys(patch).length > 0) {
      await admin.from('qa_reports').update(patch).eq('id', id);
    }
    uploadTargets = { shots: shotTargets, replay: replayTarget };
  }

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  return NextResponse.json(
    { id, url: `${site}/task/${id}`, ...(uploadTargets ? { uploads: uploadTargets } : {}) },
    { headers },
  );
}
