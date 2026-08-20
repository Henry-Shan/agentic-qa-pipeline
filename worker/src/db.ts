import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkerConfig } from './config';
import { log } from './util';

export type ReportStatus =
  | 'queued'
  | 'running'
  | 'pr_ready'
  | 'preview'
  | 'rework'
  | 'verified'
  | 'shipped'
  | 'failed'
  | 'blocked'
  | 'stopped'
  | 'cancelled';
export type RunStatus = 'running' | 'done' | 'stopped' | 'failed' | 'limited';
export type PreviewStatus = 'none' | 'starting' | 'live' | 'down';
export type MessageKind = 'steer' | 'stop' | 'verdict_fixed' | 'verdict_broken' | 'answer' | 'destroy';
export type MessageStatus = 'pending' | 'delivered' | 'done';

// Row shapes hand-derived from db/0001_qa_schema.sql.
export interface QaReport {
  id: number;
  title: string;
  description: string | null;
  kind: 'bug' | 'feature';
  status: ReportStatus;
  reporter_email: string | null;
  route: string | null;
  page_title: string | null;
  component: string | null;
  source_file: string | null;
  selector: string | null;
  testid: string | null;
  element_text: string | null;
  click_trail: unknown[];
  console_log: unknown[];
  network_log: unknown[];
  screenshots: unknown[];
  viewport: unknown;
  app_context: unknown;
  envelope: unknown;
  dedup_note: string | null;
  /** Tester display name this report is assigned to (db/0005_assignee.sql). */
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroundingChip {
  label: string;
  file?: string;
}

export interface FileChanged {
  file: string;
  add?: number;
  del?: number;
}

export interface QaRun {
  id: number;
  report_id: number;
  session_id: string;
  attempt: number;
  status: RunStatus;
  phase: string;
  tier: number | null;
  worktree: string | null;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  preview_url: string | null;
  preview_port: number | null;
  preview_status: PreviewStatus;
  grounding: GroundingChip[] | null;
  files_changed: FileChanged[] | null;
  log_tail: string | null;
  test_plan: string | null;
  featuretest: unknown;
  stopped_reason: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

export interface QaEvent {
  id: number;
  report_id: number;
  run_id: number | null;
  ts: string;
  type: string;
  message: string | null;
  payload: unknown;
}

export interface QaMessage {
  id: number;
  report_id: number;
  author_email: string | null;
  body: string;
  kind: MessageKind;
  status: MessageStatus;
  created_at: string;
}

export interface QaAreaNote {
  id: number;
  area: string;
  note: string;
  source_report_id: number | null;
  created_at: string;
}

const SCREENSHOT_BUCKET = 'qa-screenshots';

export class Db {
  private readonly c: SupabaseClient;

  constructor(cfg: WorkerConfig) {
    this.c = createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  // ---- qa_reports ----------------------------------------------------------

  async getReport(id: number): Promise<QaReport | null> {
    const r = await this.c.from('qa_reports').select('*').eq('id', id).maybeSingle();
    if (r.error) throw new Error(`getReport ${id}: ${r.error.message}`);
    return (r.data as QaReport | null) ?? null;
  }

  async insertReport(fields: Partial<QaReport> & { title: string }): Promise<QaReport> {
    const r = await this.c.from('qa_reports').insert(fields).select('*').single();
    if (r.error) throw new Error(`insertReport: ${r.error.message}`);
    return r.data as QaReport;
  }

  async updateReport(id: number, patch: Record<string, unknown>): Promise<void> {
    const r = await this.c.from('qa_reports').update(patch).eq('id', id);
    if (r.error) throw new Error(`updateReport ${id}: ${r.error.message}`);
  }

  /**
   * Conditional transition: applies the patch only while the report is still in
   * `fromStatus`, so a slow async path (e.g. preview boot) cannot clobber a
   * status the tester or another loop set meanwhile. True = a row was updated.
   */
  async updateReportIfStatus(id: number, fromStatus: ReportStatus, patch: Record<string, unknown>): Promise<boolean> {
    const r = await this.c
      .from('qa_reports')
      .update(patch)
      .eq('id', id)
      .eq('status', fromStatus)
      .select('id')
      .maybeSingle();
    if (r.error) throw new Error(`updateReportIfStatus ${id}: ${r.error.message}`);
    return r.data !== null;
  }

  /**
   * Claim an UNASSIGNED report for `name` (contracts § Auto-assign on block).
   * The `is('assignee', null)` guard is what makes auto-assign idempotent and
   * makes manual assignment win: a second call — or a race with the tester's
   * own picker — updates no row and returns false, so no duplicate event.
   */
  async assignIfUnassigned(id: number, name: string): Promise<boolean> {
    const r = await this.c
      .from('qa_reports')
      .update({ assignee: name })
      .eq('id', id)
      .is('assignee', null)
      .select('id')
      .maybeSingle();
    if (r.error) throw new Error(`assignIfUnassigned ${id}: ${r.error.message}`);
    return r.data !== null;
  }

  async deleteReport(id: number): Promise<void> {
    const r = await this.c.from('qa_reports').delete().eq('id', id);
    if (r.error) throw new Error(`deleteReport ${id}: ${r.error.message}`);
  }

  async reportsInStatuses(statuses: ReportStatus[], onlyReportId: number | null): Promise<QaReport[]> {
    let q = this.c.from('qa_reports').select('*').in('status', statuses).order('id', { ascending: true });
    if (onlyReportId !== null) q = q.eq('id', onlyReportId);
    const r = await q;
    if (r.error) throw new Error(`reportsInStatuses: ${r.error.message}`);
    return (r.data as QaReport[] | null) ?? [];
  }

  async oldestQueuedId(onlyReportId: number | null): Promise<number | null> {
    let q = this.c.from('qa_reports').select('id').eq('status', 'queued').order('id', { ascending: true }).limit(1);
    if (onlyReportId !== null) q = q.eq('id', onlyReportId);
    const r = await q.maybeSingle();
    if (r.error) throw new Error(`oldestQueuedId: ${r.error.message}`);
    return (r.data as { id: number } | null)?.id ?? null;
  }

  /**
   * Optimistic claim. supabase-js cannot execute the contract's raw
   * `for update skip locked` statement; with a SINGLE worker instance (enforced
   * by the lockfile) select-oldest-then-conditional-update is equivalent — the
   * eq(status,'queued') guard means a lost race simply claims nothing.
   */
  async claimReport(id: number): Promise<QaReport | null> {
    const r = await this.c
      .from('qa_reports')
      .update({ status: 'running' satisfies ReportStatus })
      .eq('id', id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle();
    if (r.error) throw new Error(`claimReport ${id}: ${r.error.message}`);
    return (r.data as QaReport | null) ?? null;
  }

  // ---- qa_settings ---------------------------------------------------------

  /** Site-editable worker settings; callers treat a throw as "keep current". */
  async getSettings(): Promise<Record<string, number>> {
    const r = await this.c.from('qa_settings').select('key, value');
    if (r.error) throw new Error(`getSettings: ${r.error.message}`);
    const out: Record<string, number> = {};
    for (const row of (r.data ?? []) as Array<{ key: string; value: number }>) out[row.key] = Number(row.value);
    return out;
  }

  // ---- qa_runs -------------------------------------------------------------

  async getRun(id: number): Promise<QaRun | null> {
    const r = await this.c.from('qa_runs').select('*').eq('id', id).maybeSingle();
    if (r.error) throw new Error(`getRun ${id}: ${r.error.message}`);
    return (r.data as QaRun | null) ?? null;
  }

  async insertRun(fields: Partial<QaRun> & { report_id: number; session_id: string }): Promise<QaRun> {
    const r = await this.c.from('qa_runs').insert(fields).select('*').single();
    if (r.error) throw new Error(`insertRun: ${r.error.message}`);
    return r.data as QaRun;
  }

  async updateRun(id: number, patch: Record<string, unknown>): Promise<QaRun | null> {
    const r = await this.c.from('qa_runs').update(patch).eq('id', id).select('*').maybeSingle();
    if (r.error) throw new Error(`updateRun ${id}: ${r.error.message}`);
    return (r.data as QaRun | null) ?? null;
  }

  async latestRunForReport(reportId: number): Promise<QaRun | null> {
    const r = await this.c
      .from('qa_runs')
      .select('*')
      .eq('report_id', reportId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new Error(`latestRunForReport ${reportId}: ${r.error.message}`);
    return (r.data as QaRun | null) ?? null;
  }

  async runsForReport(reportId: number): Promise<QaRun[]> {
    const r = await this.c.from('qa_runs').select('*').eq('report_id', reportId).order('id', { ascending: true });
    if (r.error) throw new Error(`runsForReport ${reportId}: ${r.error.message}`);
    return (r.data as QaRun[] | null) ?? [];
  }

  async latestRunWithPr(reportId: number): Promise<QaRun | null> {
    const r = await this.c
      .from('qa_runs')
      .select('*')
      .eq('report_id', reportId)
      .not('pr_number', 'is', null)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new Error(`latestRunWithPr ${reportId}: ${r.error.message}`);
    return (r.data as QaRun | null) ?? null;
  }

  async runBySession(sessionId: string): Promise<QaRun | null> {
    const r = await this.c
      .from('qa_runs')
      .select('*')
      .eq('session_id', sessionId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new Error(`runBySession ${sessionId}: ${r.error.message}`);
    return (r.data as QaRun | null) ?? null;
  }

  async runningRuns(): Promise<QaRun[]> {
    const r = await this.c.from('qa_runs').select('*').eq('status', 'running').order('id', { ascending: true });
    if (r.error) throw new Error(`runningRuns: ${r.error.message}`);
    return (r.data as QaRun[] | null) ?? [];
  }

  async previewRuns(): Promise<QaRun[]> {
    const r = await this.c
      .from('qa_runs')
      .select('*')
      .in('preview_status', ['starting', 'live'])
      .order('id', { ascending: true });
    if (r.error) throw new Error(`previewRuns: ${r.error.message}`);
    return (r.data as QaRun[] | null) ?? [];
  }

  async countRunningRuns(): Promise<number> {
    const r = await this.c.from('qa_runs').select('id', { count: 'exact', head: true }).eq('status', 'running');
    if (r.error) throw new Error(`countRunningRuns: ${r.error.message}`);
    return r.count ?? 0;
  }

  /** Runs started since local midnight (RUNS_PER_DAY budget). */
  async countRunsToday(): Promise<number> {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const r = await this.c
      .from('qa_runs')
      .select('id', { count: 'exact', head: true })
      .gte('started_at', midnight.toISOString());
    if (r.error) throw new Error(`countRunsToday: ${r.error.message}`);
    return r.count ?? 0;
  }

  // ---- qa_events -----------------------------------------------------------

  /** Best-effort: a failed event insert must never kill a run. */
  async insertEvent(fields: {
    report_id: number;
    run_id?: number | null;
    type: string;
    message?: string | null;
    payload?: Record<string, unknown> | null;
  }): Promise<void> {
    const r = await this.c.from('qa_events').insert({
      report_id: fields.report_id,
      run_id: fields.run_id ?? null,
      type: fields.type,
      message: fields.message?.slice(0, 4000) ?? null,
      payload: fields.payload ?? null,
    });
    if (r.error) log('db', `insertEvent failed (report ${fields.report_id}): ${r.error.message}`);
  }

  /** Events of one type for a report (auto-assign idempotency + selftest asserts). */
  async eventsForReport(reportId: number, type: string): Promise<QaEvent[]> {
    const r = await this.c
      .from('qa_events')
      .select('*')
      .eq('report_id', reportId)
      .eq('type', type)
      .order('id', { ascending: true });
    if (r.error) throw new Error(`eventsForReport ${reportId}: ${r.error.message}`);
    return (r.data as QaEvent[] | null) ?? [];
  }

  /** Events of one type for a run (needs_human idempotency + selftest asserts). */
  async eventsForRun(runId: number, type: string): Promise<QaEvent[]> {
    const r = await this.c
      .from('qa_events')
      .select('*')
      .eq('run_id', runId)
      .eq('type', type)
      .order('id', { ascending: true });
    if (r.error) throw new Error(`eventsForRun ${runId}: ${r.error.message}`);
    return (r.data as QaEvent[] | null) ?? [];
  }

  // ---- qa_allowed_emails ---------------------------------------------------

  /**
   * Chosen display name for a tester email (contracts § Display names), or
   * null when the email is unknown / has none. A lookup failure is logged and
   * degrades to null (the caller falls back to QA_DEFAULT_ASSIGNEE) rather
   * than aborting whatever transition asked for it.
   */
  async displayNameForEmail(email: string): Promise<string | null> {
    const r = await this.c
      .from('qa_allowed_emails')
      .select('display_name')
      .eq('email', email)
      .maybeSingle();
    if (r.error) {
      log('db', `displayNameForEmail ${email} failed: ${r.error.message}`);
      return null;
    }
    const name = (r.data as { display_name: string | null } | null)?.display_name ?? null;
    return name && name.trim() ? name.trim() : null;
  }

  /** Selftest fixture: seed a tester row so display-name precedence is provable. */
  async upsertAllowedEmail(email: string, displayName: string | null): Promise<void> {
    const r = await this.c
      .from('qa_allowed_emails')
      .upsert({ email, display_name: displayName }, { onConflict: 'email' });
    if (r.error) throw new Error(`upsertAllowedEmail ${email}: ${r.error.message}`);
  }

  /** Selftest fixture cleanup. */
  async deleteAllowedEmail(email: string): Promise<void> {
    const r = await this.c.from('qa_allowed_emails').delete().eq('email', email);
    if (r.error) throw new Error(`deleteAllowedEmail ${email}: ${r.error.message}`);
  }

  // ---- qa_messages ---------------------------------------------------------

  async pendingMessages(onlyReportId: number | null): Promise<QaMessage[]> {
    let q = this.c.from('qa_messages').select('*').eq('status', 'pending').order('id', { ascending: true });
    if (onlyReportId !== null) q = q.eq('report_id', onlyReportId);
    const r = await q;
    if (r.error) throw new Error(`pendingMessages: ${r.error.message}`);
    return (r.data as QaMessage[] | null) ?? [];
  }

  async oldestPendingAnswer(reportId: number): Promise<QaMessage | null> {
    const r = await this.c
      .from('qa_messages')
      .select('*')
      .eq('report_id', reportId)
      .eq('status', 'pending')
      .in('kind', ['steer', 'answer'])
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (r.error) throw new Error(`oldestPendingAnswer ${reportId}: ${r.error.message}`);
    return (r.data as QaMessage | null) ?? null;
  }

  async messagesForReport(reportId: number): Promise<QaMessage[]> {
    const r = await this.c.from('qa_messages').select('*').eq('report_id', reportId).order('id', { ascending: true });
    if (r.error) throw new Error(`messagesForReport ${reportId}: ${r.error.message}`);
    return (r.data as QaMessage[] | null) ?? [];
  }

  async updateMessage(id: number, status: MessageStatus): Promise<void> {
    const r = await this.c.from('qa_messages').update({ status }).eq('id', id);
    if (r.error) throw new Error(`updateMessage ${id}: ${r.error.message}`);
  }

  async insertMessage(fields: Partial<QaMessage> & { report_id: number; kind: MessageKind }): Promise<QaMessage> {
    const r = await this.c.from('qa_messages').insert(fields).select('*').single();
    if (r.error) throw new Error(`insertMessage: ${r.error.message}`);
    return r.data as QaMessage;
  }

  // ---- qa_area_notes -------------------------------------------------------

  async areaNotes(area: string, limit: number): Promise<QaAreaNote[]> {
    const r = await this.c
      .from('qa_area_notes')
      .select('*')
      .eq('area', area)
      .order('id', { ascending: false })
      .limit(limit);
    if (r.error) throw new Error(`areaNotes ${area}: ${r.error.message}`);
    return (r.data as QaAreaNote[] | null) ?? [];
  }

  async insertAreaNote(area: string, note: string, sourceReportId: number | null): Promise<void> {
    const r = await this.c.from('qa_area_notes').insert({ area, note, source_report_id: sourceReportId });
    if (r.error) throw new Error(`insertAreaNote ${area}: ${r.error.message}`);
  }

  // ---- storage -------------------------------------------------------------

  async downloadScreenshot(storagePath: string): Promise<Uint8Array | null> {
    const r = await this.c.storage.from(SCREENSHOT_BUCKET).download(storagePath);
    if (r.error || !r.data) return null;
    return new Uint8Array(await r.data.arrayBuffer());
  }

  /**
   * Remove every object under `report-<id>/` in the qa-screenshots bucket
   * (recursive: storage list() only returns one level, folders have a null id).
   * Returns the number of objects removed; an empty/absent folder is 0.
   */
  async deleteReportScreenshots(reportId: number): Promise<number> {
    const paths: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      const r = await this.c.storage.from(SCREENSHOT_BUCKET).list(folder, { limit: 1000 });
      if (r.error) throw new Error(`screenshot list ${folder}: ${r.error.message}`);
      for (const entry of r.data ?? []) {
        if (!entry.name) continue;
        const p = `${folder}/${entry.name}`;
        if ((entry as { id: string | null }).id === null) await walk(p);
        else paths.push(p);
      }
    };
    await walk(`report-${reportId}`);
    if (paths.length > 0) {
      const r = await this.c.storage.from(SCREENSHOT_BUCKET).remove(paths);
      if (r.error) throw new Error(`screenshot remove report-${reportId}/: ${r.error.message}`);
    }
    return paths.length;
  }
}
