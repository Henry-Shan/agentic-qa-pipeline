// Shapes mirrored from contracts/CONTRACTS.md §Widget → Site. Do not drift.

export interface ClickTrailEntry {
  ts: number;
  route: string;
  text?: string;
  testid?: string;
  component?: string;
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
