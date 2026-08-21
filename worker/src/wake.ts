import http from 'node:http';
import { previewHostname, startPreview } from './preview';
import type { Ctx } from './state';
import { log } from './util';

/**
 * Wake service — what makes a task's preview URL permanent (contracts §Preview).
 *
 * Every task has a fixed address, `qa-preview-<report>.example.com`, and a DNS
 * record that is never deleted. The dev server behind it is not permanent: the
 * worker restarts, and the MAX_PREVIEWS cap evicts idle ones. Without this, those
 * URLs would answer with Cloudflare's 530 and look broken.
 *
 * So cloudflared's catch-all ingress points here. We read the Host header, work
 * out which task it belongs to, start that task's preview, and hold the browser
 * on a small page that reloads itself until the dev server answers.
 *
 * Bound to 127.0.0.1: only the local cloudflared process can reach it.
 */
export function startWakeServer(ctx: Ctx): http.Server | null {
  if (ctx.cfg.previewMode !== 'tunnel') return null;

  // One wake per task at a time — a reloading page must not spawn dev servers in
  // a loop while the first one is still compiling.
  const waking = new Set<number>();

  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    const reportId = reportIdFromHost(ctx, host);

    if (reportId === null) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Not a QA preview', 'This address does not belong to a QA task.', false));
      return;
    }

    // Never let a wake request be mistaken for a real page. A crawler or a
    // preloading browser hitting an asset URL should not boot a dev server.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('preview asleep');
      return;
    }

    if (!waking.has(reportId)) {
      waking.add(reportId);
      void wake(ctx, reportId).finally(() => waking.delete(reportId));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page('Starting this preview…', `Task #${reportId}'s dev server is booting. This can take a minute.`, true));
  });

  server.listen(ctx.cfg.wakePort, '127.0.0.1', () => {
    log('wake', `wake service on 127.0.0.1:${ctx.cfg.wakePort} — asleep previews start on demand`);
  });
  return server;
}

/** `qa-preview-47.example.com` → 47, and null for anything else. */
function reportIdFromHost(ctx: Ctx, host: string): number | null {
  const prefix = ctx.cfg.previewHostPrefix;
  const suffix = `.${ctx.cfg.previewZone}`;
  if (!host.startsWith(prefix) || !host.endsWith(suffix)) return null;
  const label = host.slice(prefix.length, host.length - suffix.length);
  if (!/^\d+$/.test(label)) return null;
  const id = Number(label);
  // Round-trip through the canonical builder: if it doesn't reproduce the host
  // we were called with, we parsed something we don't actually own.
  return previewHostname(ctx, id) === host ? id : null;
}

async function wake(ctx: Ctx, reportId: number): Promise<void> {
  const run = await ctx.db.latestRunForReport(reportId);
  if (!run?.worktree) {
    log('wake', `task ${reportId}: nothing to wake (no run with a worktree)`);
    return;
  }
  if (ctx.state.previews.has(run.id)) return; // already up; the reload will find it
  log('wake', `task ${reportId}: waking run ${run.id}'s preview on demand`);
  // skipExam: this is a visitor opening a link, not a fresh fix to be judged.
  await startPreview(ctx, run, true);
}

function page(title: string, detail: string, reload: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
${reload ? '<meta http-equiv="refresh" content="5">' : ''}
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#fbfbfa;
       font:14px/1.6 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;color:#37352f}
  .c{text-align:center;max-width:26rem;padding:2rem}
  h1{font-size:15px;font-weight:600;margin:0 0 .4rem}
  p{margin:0;color:#787774;font-size:13px}
  .s{width:14px;height:14px;margin:0 auto 1.1rem;border:2px solid #e3e2e0;
     border-top-color:#37352f;border-radius:50%;animation:r .7s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
</style>
<div class="c">${reload ? '<div class="s"></div>' : ''}<h1>${title}</h1><p>${detail}</p></div>`;
}
