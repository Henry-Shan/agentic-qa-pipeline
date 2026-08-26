import { buildMatches, expectedPreviewUrl, listeningPid, stopPreview } from './preview';
import type { Ctx } from './state';
import { log } from './util';

const SYNC_MS = 60_000;

/** What a build for this preview should have inlined as its API base. */
function apiBaseFor(ctx: Ctx, reportId: number, port: number): string {
  const url = expectedPreviewUrl(ctx, reportId, port);
  return url.startsWith('https://') ? `${url}/__api` : ctx.cfg.previewApiOrigin;
}

/**
 * Keep `qa_runs.preview_status` honest while the worker runs.
 *
 * The row is what the site reads — the pill, the link, the Live preview tab all
 * come from it, and none of them ever ask the preview itself. Until now the row
 * was only checked against reality at BOOT, so a worker running for days could
 * carry a wrong value indefinitely: task 60 showed "Preview waiting" for two days
 * over a preview that answered every request, because two writes raced across a
 * restart and the losing one stuck.
 *
 * Caching what we believe the row says does not fix that — the cache goes stale
 * the same way the row does. So this re-derives the truth every minute from the
 * one thing that cannot lie: whether the port is listening.
 *
 * Both directions matter. A preview serving while the row says down strands a
 * working link behind a "waiting" pill; a dead preview the row calls live sends
 * people to a URL that has to cold-start before it answers.
 */
export function startPreviewSyncLoop(ctx: Ctx): NodeJS.Timeout {
  return setInterval(() => {
    void syncPreviewRows(ctx).catch((e: Error) => log('preview', `row sync failed: ${e.message}`));
  }, SYNC_MS);
}

export async function syncPreviewRows(ctx: Ctx): Promise<void> {
  for (const handle of [...ctx.state.previews.values()]) {
    // A preview mid-start has no settled row yet; leave it to startPreview.
    if (ctx.state.startingPreviews.has(handle.runId)) continue;

    const alive = (await listeningPid(handle.port)) !== null;
    const run = await ctx.db.getRun(handle.runId);
    if (!run) continue;

    // A preview re-attached after a config change keeps SERVING, but its bundle
    // was compiled for the old addresses — switching off the tunnel left builds
    // calling a `/__api` host that no longer resolves, so the page loads and
    // every request inside it fails. Retire it; opening the link rebuilds.
    const url = expectedPreviewUrl(ctx, handle.reportId, handle.port);
    if (alive && !buildMatches(ctx, handle.worktree, apiBaseFor(ctx, handle.reportId, handle.port))) {
      await stopPreview(ctx, handle, 'built for a different address');
      continue;
    }
    if (alive && (run.preview_status !== 'live' || run.preview_url !== url)) {
      await ctx.db.updateRun(handle.runId, { preview_status: 'live', preview_url: url });
      if (run.preview_status !== 'live') {
        log('preview', `run ${handle.runId}: row said ${run.preview_status} but port ${handle.port} is serving — corrected to live`);
      }
      if (run.preview_url !== url) {
        log('preview', `run ${handle.runId}: preview_url was ${run.preview_url ?? 'null'} — corrected to ${url}`);
      }
    } else if (!alive) {
      // Gone without telling us: drop the handle so the next request wakes it
      // rather than proxying into a dead port.
      await stopPreview(ctx, handle, 'process is gone (found by row sync)');
    }
  }
}
