import fs from 'node:fs';
import path from 'node:path';
import type { QaReport } from './db';
import type { Ctx } from './state';
import { log } from './util';

// Copied from docs/specs/2026-07-30-qa-pipeline-design.md §Grounding — the
// dispatch prompt's hard requirements before any edit.
const GROUNDING_INSTRUCTIONS = `GROUNDING INSTRUCTIONS (do these BEFORE any code edit)

1. The report's component/source_file is the ENTRY POINT, never the assumed bug
   location. Do not conclude the bug lives there until the trace proves it.
2. Read every file listed under "screenshots" below AS AN IMAGE (Read tool) and
   confirm it matches the description before anything else.
3. Traverse the vertical slice (component -> hook/store -> shared-core API
   client -> Go handler -> DB) using graphify-out/graph.json, the
   project memory MCP (search_memory), and the "area_notes" below distilled
   from previous QA runs in this area.
4. Reproduce at the API, not the UI: the report's network_log usually contains
   the exact failing request — replay it (curl) to reproduce before the fix and
   to verify after.
5. ship-task's risk floor is unchanged: traces crossing auth/migrations/tenancy
   force Tier 2.`;

export interface Envelope {
  instructions: string;
  report: QaReport;
  /** Absolute local paths of screenshots downloaded from the bucket. */
  screenshots: string[];
  area: string;
  area_notes: Array<{ note: string; created_at: string }>;
}

/** area = dirname(source_file), else first route segment, else 'general'. */
export function deriveArea(report: Pick<QaReport, 'source_file' | 'route'>): string {
  const sf = report.source_file?.trim();
  if (sf) {
    const dir = path.dirname(sf);
    if (dir && dir !== '.' && dir !== '/') return dir;
  }
  const seg = (report.route ?? '').split('/').filter(Boolean).at(0);
  return seg ?? 'general';
}

/** Build ~/.qa-pipeline/runs/<reportId>/envelope.json; returns its abs path. */
export async function buildEnvelope(ctx: Ctx, report: QaReport): Promise<string> {
  const dir = path.join(ctx.cfg.qaHome, 'runs', String(report.id));
  fs.mkdirSync(dir, { recursive: true });

  const screenshots: string[] = [];
  const entries = Array.isArray(report.screenshots) ? report.screenshots : [];
  let i = 0;
  for (const entry of entries) {
    const storagePath =
      typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object' && 'path' in entry
          ? String((entry as { path: unknown }).path)
          : null;
    if (!storagePath) continue;
    const bytes = await ctx.db.downloadScreenshot(storagePath).catch(() => null);
    if (!bytes) {
      log('envelope', `screenshot download failed: ${storagePath} (report ${report.id})`);
      continue;
    }
    const file = path.join(dir, `screenshot-${i++}${path.extname(storagePath) || '.png'}`);
    fs.writeFileSync(file, bytes);
    screenshots.push(file);
  }

  const area = deriveArea(report);
  const notes = await ctx.db.areaNotes(area, 10);
  const envelope: Envelope = {
    instructions: GROUNDING_INSTRUCTIONS,
    report,
    screenshots,
    area,
    area_notes: notes.map((n) => ({ note: n.note, created_at: n.created_at })),
  };
  const envelopePath = path.join(dir, 'envelope.json');
  fs.writeFileSync(envelopePath, JSON.stringify(envelope, null, 2));

  // Summary only — embedding the full report row here would nest recursively
  // on the next rebuild (report.envelope contains itself).
  await ctx.db.updateReport(report.id, {
    envelope: {
      area,
      screenshots,
      area_note_count: notes.length,
      built_at: new Date().toISOString(),
    },
  });
  return envelopePath;
}
