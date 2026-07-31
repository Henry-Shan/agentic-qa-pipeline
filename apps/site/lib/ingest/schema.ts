import { Buffer } from 'node:buffer';
import { z } from 'zod';

// DoS bounds that must bind BEFORE clamping/decoding: zod walks arrays and the
// screenshot string in full, so cap them here. Far above anything the widget
// sends (clamp keeps ≤50 entries), so legit reports are never rejected.
const MAX_ARRAY_ENTRIES = 500;
// "data:image/png;base64," + 4 MB of PNG as base64 (~5.6 MB chars).
const MAX_SCREENSHOT_DATA_URL_CHARS = 5_600_000;

// Shape per CONTRACTS.md §Widget→Site. Types are validated strictly; sizes are
// clamped (truncated) afterwards rather than rejected.
export const ingestSchema = z.object({
  kind: z.enum(['bug', 'feature']),
  description: z.string().min(1),
  reporterEmail: z.string().optional(),
  route: z.string(),
  pageTitle: z.string(),
  component: z.string().optional(),
  sourceFile: z.string().optional(),
  selector: z.string().optional(),
  testid: z.string().optional(),
  elementText: z.string().optional(),
  clickTrail: z
    .array(
      z.object({
        ts: z.number(),
        route: z.string(),
        // Defaults to 'click'; 'input' entries record typing (value = final
        // field value, selector = stable selector for replay targeting).
        kind: z.enum(['click', 'input']).optional(),
        text: z.string().optional(),
        testid: z.string().optional(),
        component: z.string().optional(),
        selector: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .max(MAX_ARRAY_ENTRIES),
  consoleLog: z
    .array(
      z.object({
        ts: z.number(),
        level: z.enum(['error', 'warn']),
        text: z.string(),
      }),
    )
    .max(MAX_ARRAY_ENTRIES),
  networkLog: z
    .array(
      z.object({
        ts: z.number(),
        method: z.string(),
        url: z.string(),
        status: z.number(),
        ms: z.number(),
        bodySnippet: z.string().optional(),
      }),
    )
    .max(MAX_ARRAY_ENTRIES),
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
  appContext: z.record(z.string(), z.string()).optional(),
  screenshotDataUrl: z.string().max(MAX_SCREENSHOT_DATA_URL_CHARS).optional(),
  // Additional captures (≤3), EACH under the same pre-decode length cap as the
  // primary; stored as report-<id>/marked-2.png … in order after the primary.
  screenshotsDataUrls: z.array(z.string().max(MAX_SCREENSHOT_DATA_URL_CHARS)).max(3).optional(),
});

export type IngestBody = z.infer<typeof ingestSchema>;

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

// ≤40 entries, snippet ≤2000 chars, non-2xx always kept (contract clamp rules).
function clampNetworkLog(log: IngestBody['networkLog']): IngestBody['networkLog'] {
  const trimmed = log.map((entry) => ({ ...entry, bodySnippet: entry.bodySnippet?.slice(0, 2000) }));
  if (trimmed.length <= 40) return trimmed;
  const keep = new Set(trimmed.filter((entry) => !is2xx(entry.status)).slice(-40));
  for (let i = trimmed.length - 1; i >= 0 && keep.size < 40; i--) {
    const entry = trimmed[i];
    if (entry && is2xx(entry.status)) keep.add(entry);
  }
  return trimmed.filter((entry) => keep.has(entry));
}

function clampRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record).slice(0, 40)) {
    out[key.slice(0, 100)] = value.slice(0, 500);
  }
  return out;
}

export function clampIngest(input: IngestBody): IngestBody {
  return {
    ...input,
    description: input.description.slice(0, 10_000),
    reporterEmail: input.reporterEmail?.slice(0, 200),
    route: input.route.slice(0, 500),
    pageTitle: input.pageTitle.slice(0, 300),
    component: input.component?.slice(0, 200),
    sourceFile: input.sourceFile?.slice(0, 300),
    selector: input.selector?.slice(0, 500),
    testid: input.testid?.slice(0, 200),
    elementText: input.elementText?.slice(0, 120),
    clickTrail: input.clickTrail.slice(-50).map((entry) => ({
      ...entry,
      text: entry.text?.slice(0, 160),
      selector: entry.selector?.slice(0, 500),
      value: entry.value?.slice(0, 120),
    })),
    consoleLog: input.consoleLog.slice(-50).map((entry) => ({ ...entry, text: entry.text.slice(0, 500) })),
    networkLog: clampNetworkLog(input.networkLog),
    appContext: input.appContext ? clampRecord(input.appContext) : undefined,
  };
}

const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
// 4 MB encoded as base64 (4 chars per 3 bytes), plus padding slack — checked
// against the base64 STRING so an oversized payload is rejected before the
// decoded Buffer is ever allocated.
const MAX_SCREENSHOT_B64_CHARS = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4;

/** PNG data URL → Buffer; null when malformed or over the 4MB contract limit. */
export function decodeScreenshot(dataUrl: string): Buffer | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  const b64 = match?.[1];
  if (!b64 || b64.length > MAX_SCREENSHOT_B64_CHARS) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.byteLength > 0 && buf.byteLength <= MAX_SCREENSHOT_BYTES ? buf : null;
}
