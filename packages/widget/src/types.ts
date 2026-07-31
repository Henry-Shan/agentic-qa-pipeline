// Shapes mirrored from contracts/CONTRACTS.md §Widget → Site. Do not drift.

export interface ClickTrailEntry {
  ts: number;
  route: string;
  /** Defaults to 'click' when absent (back-compat). Route markers carry neither kind nor metadata. */
  kind?: 'click' | 'input';
  /**
   * Click: element text ('pressed Enter' for Enter-key submits — kind 'click',
   * selector of the field). Input: field label/placeholder (≤40 chars).
   */
  text?: string;
  testid?: string;
  component?: string;
  /** Stable CSS selector for replay targeting. */
  selector?: string;
  /**
   * Input steps only — scrubbed, ≤120 chars. Text fields/textareas/
   * contenteditable: final value. Selects: the chosen option's LABEL.
   * Checkbox/radio: 'checked' | 'unchecked'. NEVER recorded for type=password
   * or autocomplete matching password|cc-*|card|otp.
   */
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

export interface IngestBody {
  kind: 'bug' | 'feature';
  description: string;
  reporterEmail?: string;
  route: string;
  pageTitle: string;
  component?: string;
  sourceFile?: string;
  selector?: string;
  testid?: string;
  elementText?: string;
  clickTrail: ClickTrailEntry[];
  consoleLog: ConsoleEntry[];
  networkLog: NetworkEntry[];
  viewport: { w: number; h: number; dpr: number };
  appContext?: Record<string, string>;
  screenshotDataUrl?: string;
  /** Additional captures (≤3), same limits each — server stores marked-2.png … */
  screenshotsDataUrls?: string[];
  /**
   * JSON.stringify of the buffered rrweb events (contract §Session replay) —
   * client-capped at 8_000_000 chars measured AFTER stringify; the field is
   * omitted entirely when over (never truncated). Server stores it VERBATIM as
   * report-<id>/replay.json.
   */
  replayEvents?: string;
}

export interface WidgetConfig {
  endpoint: string;
  /** Static ingest token (`x-qa-token`) — fallback when the host provides no getToken bridge. */
  token?: string;
  email?: string;
  appContext?: Record<string, string>;
}

/** Host-page global, set BEFORE the widget script loads. */
export interface QAPipelineGlobal {
  endpoint?: string;
  token?: string;
  email?: string;
  appContext?: Record<string, string>;
  /**
   * Session-token bridge: returns the current signed-in user's access token.
   * When present, submit sends `Authorization: Bearer <token>` (awaited with a
   * 3s timeout) instead of the static `x-qa-token`.
   */
  getToken?: () => Promise<string | null | undefined> | string | null | undefined;
}

declare global {
  interface Window {
    __qaPipeline?: { open(): void; version: string };
    QAPipeline?: QAPipelineGlobal;
  }
}
