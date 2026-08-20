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

function sane(v: number | undefined): number | null {
  return v !== undefined && Number.isInteger(v) && v >= 0 && v <= 50 ? v : null;
}

export async function refreshSettings(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.getSettings();
  const next = { maxRuns: sane(rows['max_runs']), maxPreviews: sane(rows['max_previews']) };
  const prev = ctx.state.settings;
  if (next.maxRuns !== prev.maxRuns || next.maxPreviews !== prev.maxPreviews) {
    ctx.state.settings = next;
    log('settings', `qa_settings → max ${maxRuns(ctx)} runs / ${maxPreviews(ctx)} previews`);
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
