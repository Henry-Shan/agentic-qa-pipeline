import { NextResponse, type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { QaDoc, QaDocSection } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * POST /api/docs/dispatch — file a doc section as a report (contracts §QA
 * Docs). Copies the section's stored evidence into the report's own storage
 * prefix (so the report stays self-contained for destroy/teardown), inserts
 * the report with `doc_section_id`, links the section back, and the existing
 * worker pipeline takes it from there — nothing else changes.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const email = userData.user?.email;
  if (!email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const id = Number((raw as { sectionId?: unknown } | null)?.sectionId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const admin = createServiceClient();
  const { data: sectionRow } = await admin.from('qa_doc_sections').select('*').eq('id', id).maybeSingle();
  const section = sectionRow as QaDocSection | null;
  if (!section) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (section.report_id) {
    return NextResponse.json({ error: 'already dispatched', reportId: section.report_id }, { status: 409 });
  }
  const { data: docRow } = await admin.from('qa_docs').select('*').eq('id', section.doc_id).maybeSingle();
  const doc = docRow as QaDoc | null;
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const title = (section.title || section.body.slice(0, 80)).trim();
  if (!title) return NextResponse.json({ error: 'section needs a title' }, { status: 400 });
  const description =
    `${section.body.trim() || section.title}\n\n[from doc "${doc.title}" § "${section.title}"]`;

  // Same role-snapshot enrichment as /api/ingest — dispatch context for Claude.
  const appContext: Record<string, unknown> = {
    doc: { slug: doc.slug, title: doc.title, section: section.title },
  };
  try {
    const { data: profile } = await admin
      .from('profiles')
      .select('id, first_name, last_name')
      .eq('email', email)
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
  const { data: allowed } = await admin
    .from('qa_allowed_emails')
    .select('display_name')
    .eq('email', email)
    .maybeSingle();
  if (allowed?.display_name) appContext.reporterName = allowed.display_name;

  const { data: inserted, error: insertError } = await admin
    .from('qa_reports')
    .insert({
      title: title.slice(0, 80),
      description,
      kind: section.kind,
      status: 'queued',
      reporter_email: email,
      route: section.route ?? '/',
      page_title: doc.title,
      component: section.component,
      source_file: section.source_file,
      selector: section.selector,
      element_text: section.element_text,
      click_trail: section.click_trail ?? [],
      console_log: section.console_log ?? [],
      network_log: section.network_log ?? [],
      screenshots: [],
      viewport: section.viewport ?? { w: 0, h: 0, dpr: 1 },
      app_context: appContext,
      doc_section_id: section.id,
      // Per-task base context + model (contracts §Base context) — null means
      // "use the worker default", '' means an explicitly cold start.
      base_session: section.base_session,
      model: section.model,
      // Questionnaire answers (contracts §Task input): done_when is the
      // examiner's oracle, constraints are hard boundaries, reproduce_as picks
      // the role Claude and the examination run under.
      done_when: section.done_when ?? '',
      constraints: section.constraints ?? '',
      reproduce_as: section.reproduce_as,
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    return NextResponse.json({ error: 'insert failed' }, { status: 500 });
  }
  const reportId = inserted.id as number;

  // Copy evidence into the report's own prefix — the section keeps its copy.
  const storedShots: string[] = [];
  for (let i = 0; i < section.screenshots.length; i++) {
    const from = section.screenshots[i];
    if (!from) continue;
    const to = i === 0 ? `report-${reportId}/marked.png` : `report-${reportId}/marked-${i + 1}.png`;
    const { error } = await admin.storage.from('qa-screenshots').copy(from, to);
    if (!error) storedShots.push(to);
  }
  // Fixture files ride along too — the run must be able to reproduce with them.
  const storedFiles: string[] = [];
  for (const from of section.files ?? []) {
    const name = from.split('/').pop() ?? 'file';
    const to = `report-${reportId}/files/${name}`;
    const { error } = await admin.storage.from('qa-screenshots').copy(from, to);
    if (!error) storedFiles.push(to);
  }

  const patch: Record<string, unknown> = {};
  if (storedFiles.length > 0) patch.files = storedFiles;
  if (storedShots.length > 0) patch.screenshots = storedShots;
  if (section.replay_path) {
    const to = `report-${reportId}/replay.json`;
    const { error } = await admin.storage.from('qa-screenshots').copy(section.replay_path, to);
    if (!error) patch.replay_path = to;
  }
  if (Object.keys(patch).length > 0) await admin.from('qa_reports').update(patch).eq('id', reportId);

  await admin.from('qa_doc_sections').update({ report_id: reportId }).eq('id', section.id);
  await admin.from('qa_events').insert({
    report_id: reportId,
    type: 'system',
    message: `filed by ${email} from doc "${doc.title}"`,
  });

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? '';
  return NextResponse.json({ id: reportId, url: `${site}/task/${reportId}` });
}
