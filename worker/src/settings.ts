import { publishPreview } from './preview';
import type { Ctx } from './state';
import { log } from './util';

const POLL_MS = 10_000;

/** Effective limits: a valid qa_settings row wins over worker/.env. */
export function maxRuns(ctx: Ctx): number {
  return ctx.state.settings.maxRuns ?? ctx.cfg.maxRuns;
}

export function maxPreviews(ctx: Ctx): number {
  return ctx.state.settings.maxPreviews ?? ctx.cfg.maxPreviews;
}

/** The run currently published on the shared preview hostname (0 = none). */
export function publishedRun(ctx: Ctx): number {
  return ctx.state.settings.publishedRun ?? 0;
}

function sane(v: number | undefined): number | null {
  return v !== undefined && Number.isInteger(v) && v >= 0 && v <= 50 ? v : null;
}

export async function refreshSettings(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.getSettings();
  const rawPublished = rows['published_run'];
  const next = {
    maxRuns: sane(rows['max_runs']),
    maxPreviews: sane(rows['max_previews']),
    publishedRun: typeof rawPublished === 'number' && Number.isInteger(rawPublished) && rawPublished >= 0 ? rawPublished : 0,
  };
  const prev = ctx.state.settings;
  if (next.maxRuns !== prev.maxRuns || next.maxPreviews !== prev.maxPreviews) {
    log('settings', `qa_settings → max ${next.maxRuns ?? ctx.cfg.maxRuns} runs / ${next.maxPreviews ?? ctx.cfg.maxPreviews} previews`);
  }
  const publishChanged = next.publishedRun !== prev.publishedRun;
  ctx.state.settings = next;
  if (publishChanged) {
    // Someone pressed Share (or Unshare) on the site — repoint the shared
    // hostname. Fire-and-forget: a tunnel restart must never stall the loop.
    void publishPreview(ctx).catch((e: Error) => log('settings', `publish failed: ${e.message}`));
  }
}

export function startSettingsLoop(ctx: Ctx): NodeJS.Timeout {
  let warned = false;
  return setInterval(() => {
    void refreshSettings(ctx)
      .then(() => {
        warned = false;
      })
      .catch((e: Error) => {
        if (!warned) {
          warned = true;
          log('settings', `refresh failed — keeping current limits: ${e.message}`);
        }
      });
  }, POLL_MS);
}
