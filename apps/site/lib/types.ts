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

export type RunStatus = 'running' | 'done' | 'stopped' | 'failed' | 'limited';

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

export interface ClickTrailEntry {
  ts: number;
  route: string;
  /** Defaults to 'click'. 'input' entries record typing (see CONTRACTS.md §Widget→Site). */
  kind?: 'click' | 'input';
  text?: string;
  testid?: string;
  component?: string;
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
