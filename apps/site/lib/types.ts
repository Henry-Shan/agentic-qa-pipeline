// DB row shapes — hand-derived from db/0001_qa_schema.sql. No codegen.

export type ReportKind = 'bug' | 'feature';

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

/** 'interrupted' = paused mid-flight (sleep/restart); resumes automatically (db/0015). */
export type RunStatus = 'running' | 'done' | 'stopped' | 'failed' | 'limited' | 'interrupted';

export type PreviewStatus = 'none' | 'starting' | 'live' | 'down';

export type MessageKind = 'steer' | 'stop' | 'verdict_fixed' | 'verdict_broken' | 'answer' | 'destroy';

export type MessageStatus = 'pending' | 'delivered' | 'done';

// qa_runs.phase and qa_events.type are unconstrained text in the DB;
// these are the values the worker writes per CONTRACTS.md.
export type RunPhase =
  | 'starting'
  | 'grounding'
  | 'testing'
  | 'implementing'
  | 'verifying'
  | 'feature_test'
  | 'pr'
  | 'preview'
  | 'done';

export type EventType = 'log' | 'phase' | 'error' | 'question' | 'system';

// qa_examinations — the examination loop (db/0010, contracts §Examination).
export interface QaExamination {
  id: number;
  report_id: number;
  run_id: number | null;
  attempt: number;
  verdict: 'pass' | 'fail' | 'inconclusive';
  summary: string;
  findings: Array<{ claim: string; met: boolean; evidence: string }>;
  shots: string[];
  steps_shown: number;
  steps_skipped: number;
  created_at: string;
}

// qa_settings — site-editable worker limits (keys: max_runs, max_previews).
export interface QaSetting {
  key: string;
  value: number;
  updated_at: string;
  updated_by: string | null;
}

export interface ClickTrailEntry {
  ts: number;
  route: string;
  /** Defaults to 'click'. 'input' entries record typing (see CONTRACTS.md §Widget→Site). */
  kind?: 'click' | 'input';
  text?: string;
  testid?: string;
  component?: string;
  /** Source file of the component, when the build annotated it. */
  sourceFile?: string;
  /** Stable selector for replay targeting. */
  selector?: string;
  /** Final field value for 'input' steps (≤120 chars, scrubbed; never passwords). */
  value?: string;
}

export interface ConsoleEntry {
  ts: number;
  level: 'error' | 'warn';
  text: string;
}

export interface NetworkEntry {
  ts: number;
  method: string;
  url: string;
  status: number;
  ms: number;
  bodySnippet?: string;
}

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

export interface GroundingChip {
  label: string;
  file?: string;
}

export interface FileChange {
  file: string;
  add: number;
  del: number;
}

export interface QaReport {
  id: number;
  title: string;
  description: string | null;
  kind: ReportKind;
  status: ReportStatus;
  /** Base context to fork from / model to run on (db/0011, contracts §Base context). */
  base_session?: string | null;
  model?: string | null;
  /** Router decision (db/0013). */
  lane?: 'fast' | 'complex' | 'infra' | null;
  lane_reason?: string | null;
  /** Questionnaire answers (db/0012). */
  done_when?: string;
  constraints?: string;
  reproduce_as?: string | null;
  files?: string[];
  reporter_email: string | null;
  route: string | null;
  page_title: string | null;
  component: string | null;
  source_file: string | null;
  selector: string | null;
  testid: string | null;
  element_text: string | null;
  click_trail: ClickTrailEntry[];
  console_log: ConsoleEntry[];
  network_log: NetworkEntry[];
  screenshots: string[];
  /** Storage path of the rrweb recording JSON, e.g. report-7/replay.json (db/0006_replay_path.sql). */
  replay_path: string | null;
  viewport: Viewport | null;
  app_context: Record<string, string> | null;
  envelope: unknown;
  dedup_note: string | null;
  /** Tester display name this report is assigned to (db/0005_assignee.sql). */
  assignee: string | null;
  created_at: string;
  updated_at: string;
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
  /** Why it is in that state, in words (db/0019). */
  preview_detail?: string | null;
  /** When that phase began (db/0020) — the site shows elapsed time from it. */
  preview_detail_at?: string | null;
  /**
   * Storage path of the "after the fix" rrweb recording — the replay executed
   * against this run's preview build, e.g. report-7/after-replay-12.json
   * (db/0007_after_replay_path.sql).
   */
  after_replay_path: string | null;
  grounding: GroundingChip[] | null;
  files_changed: FileChange[] | null;
  log_tail: string | null;
  test_plan: string | null;
  featuretest: { verdict?: string; [key: string]: unknown } | null;
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
