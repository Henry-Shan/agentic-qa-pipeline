import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { ensureAgentPreview } from './agent-preview';
import { API_PREFIX, listeningPid, previewHostname, startPreview } from './preview';
import type { Ctx, PreviewHandle } from './state';
import { log } from './util';

/**
 * Front door for preview traffic (contracts §Preview), on every machine.
 *
 * It answers two kinds of request:
 *
 *  1. **The launcher, `/p/<reportId>`** — the machine-independent preview URL
 *     the site links to. `localhost:<wakePort>` resolves on whichever machine
 *     the click happens, so the same link works for every tester: if this
 *     machine has the preview serving (the runner's own, or one the preview
 *     agent built from the run's branch), the visitor is redirected to its
 *     local port; otherwise they get the self-reloading waiting page while it
 *     is built here. Redirect rather than proxy: the app then runs on its own
 *     genuine localhost origin, so none of the header rewriting below applies.
 *
 *  2. **Tunnel hostnames, `qa-preview-<task>.<zone>`** (PREVIEW_MODE=tunnel) —
 *     cloudflared sends ALL preview traffic here:
 *     - preview up   → proxy to its dev server, rewriting the request's origin
 *     - preview down → start it, and hold the browser on a self-reloading page
 *
 * **Why the rewrite (tunnel only).** Next 16 refuses cross-origin requests to
 * `/_next/*` unless the origin is in `allowedDevOrigins`
 * (block-cross-site-dev.ts). A preview served at qa-preview-46.example.com is
 * cross-origin by that rule, so HMR and the dev chunks 403 — the HTML renders
 * and then nothing hydrates, so the page looks alive but no click does
 * anything. The fix belongs here rather than in the app's next.config: the
 * worktree's diff becomes the PR, and a preview-only config change has no
 * business in it. So we present each request to the dev server as though it
 * came from localhost, which is what it in fact is.
 *
 * Bound to 127.0.0.1 — only this machine's browser and the local cloudflared
 * process can reach it.
 */
export function startFrontDoor(ctx: Ctx): http.Server {
  // One wake per task at a time: the reloading page must not spawn a dev server
  // on every poll while the first is still compiling.
  const waking = new Set<number>();

  const server = http.createServer((req, res) => {
    const launcher = parseLauncher(req.url ?? '');
    if (launcher) {
      void handleLauncher(ctx, req, res, launcher.reportId, launcher.rest, waking);
      return;
    }
    const publicHost = hostOf(req.headers.host);
    const reportId = reportIdFromHost(ctx, publicHost);
    if (reportId === null) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Not a QA preview', 'This address does not belong to a QA task.', false));
      return;
    }

    // `/__api/*` is the preview's same-origin door to the real API. It is served
    // whether or not the dev server is up — it does not depend on one.
    if (req.url?.startsWith(`${API_PREFIX}/`) || req.url === API_PREFIX) {
      proxyApi(ctx, req, res);
      return;
    }

    const handle = previewFor(ctx, reportId);
    if (handle) {
      proxy(ctx, req, res, handle, publicHost, reportId, waking);
      return;
    }

    // Asleep. Only a page view should boot a dev server — not a crawler, and not
    // a stray asset request from a tab left open on the waking page.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('preview asleep');
      return;
    }
    // Already building (a fresh fix is compiled before it can be served) vs
    // asleep (evicted, just needs starting). The wait is minutes in the first
    // case and seconds in the second, and saying so is the difference between
    // "working" and "broken" to whoever is staring at it.
    const building = ctx.state.startingReports.has(reportId);
    if (!building && !waking.has(reportId)) {
      waking.add(reportId);
      void ensureLocal(ctx, reportId).finally(() => waking.delete(reportId));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      building
        ? page('Building this preview…', `Task #${reportId} is being compiled. This usually takes a few minutes — this page refreshes itself.`, true)
        : page('Starting this preview…', `Task #${reportId} is waking up. This takes about a minute — this page refreshes itself.`, true),
    );
  });

  // Next's HMR socket (/_next/webpack-hmr). Without this the client retries
  // forever and the dev overlay never settles.
  server.on('upgrade', (req, socket, head) => {
    const publicHost = hostOf(req.headers.host);
    const reportId = reportIdFromHost(ctx, publicHost);
    const handle = reportId === null ? null : previewFor(ctx, reportId);
    if (!handle) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(handle.port, '127.0.0.1', () => {
      const headers = rewriteHeaders(req.headers, handle.port, publicHost);
      const head_ = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) head_.push(`${k}: ${one}`);
      }
      upstream.write(`${head_.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(ctx.cfg.wakePort, '127.0.0.1', () => {
    log('preview', `front door on 127.0.0.1:${ctx.cfg.wakePort} — serves /p/<task> launchers, proxies live previews, wakes asleep ones`);
  });
  return server;
}

/** `/p/47`, `/p/47/qa-session`, `/p/47?x=1` → the task and everything after it. */
function parseLauncher(url: string): { reportId: number; rest: string } | null {
  const m = /^\/p\/(\d+)((?:\/|\?).*)?$/.exec(url);
  if (!m?.[1]) return null;
  return { reportId: Number(m[1]), rest: m[2] ?? '' };
}

/**
 * The launcher: send the visitor to THIS machine's copy of the preview, building
 * it first if need be. The redirect target is a plain localhost origin, so the
 * URL fragment (the auto-login `#token_hash=…`) survives — browsers re-attach
 * the original fragment when a Location header carries none.
 */
async function handleLauncher(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reportId: number,
  rest: string,
  waking: Set<number>,
): Promise<void> {
  const port = await launcherPort(ctx, reportId);
  if (port !== null) {
    const suffix = rest === '' ? '/' : rest.startsWith('?') ? `/${rest}` : rest;
    res.writeHead(302, { location: `http://localhost:${port}${suffix}`, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('preview asleep');
    return;
  }
  const building = ctx.state.startingReports.has(reportId);
  if (!building && !waking.has(reportId)) {
    waking.add(reportId);
    void ensureLocal(ctx, reportId).finally(() => waking.delete(reportId));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    building
      ? page('Building this preview…', `Task #${reportId} is being compiled on this machine. This usually takes a few minutes — this page refreshes itself.`, true)
      : page('Starting this preview…', `Task #${reportId} is starting up on this machine. This page refreshes itself.`, true),
  );
}

/** A port on THIS machine that is genuinely serving this report, or null. */
async function launcherPort(ctx: Ctx, reportId: number): Promise<number | null> {
  const runner = previewFor(ctx, reportId);
  if (runner) {
    if ((await listeningPid(runner.port)) !== null) return runner.port;
    // Dead behind our back (sleep, crash) — same recovery as the proxy path.
    ctx.state.previews.delete(runner.runId);
    void ctx.db.updateRun(runner.runId, { preview_status: 'down' }).catch(() => undefined);
  }
  const agent = ctx.state.agentPreviews.get(reportId);
  if (agent && (await listeningPid(agent.port)) !== null) return agent.port;
  return null;
}

function hostOf(header: string | undefined): string {
  return (header ?? '').split(':')[0]?.toLowerCase() ?? '';
}

function previewFor(ctx: Ctx, reportId: number): PreviewHandle | null {
  for (const p of ctx.state.previews.values()) if (p.reportId === reportId) return p;
  return null;
}

/**
 * Make the request look local. Next allows `localhost` and, separately, requests
 * with no Origin at all; presenting the dev server's own address satisfies both
 * the websocket check and the no-cors/Referer fallback.
 */
function rewriteHeaders(
  headers: http.IncomingHttpHeaders,
  port: number,
  publicHost: string,
): http.IncomingHttpHeaders {
  const local = `http://localhost:${port}`;
  const out: http.IncomingHttpHeaders = { ...headers };
  out.host = `localhost:${port}`;
  if (out.origin) out.origin = local;
  if (typeof out.referer === 'string') {
    out.referer = out.referer.replace(new RegExp(`^https?://${publicHost.replace(/\./g, '\\.')}`, 'i'), local);
  }
  // The browser is on https even though this hop is not; without these the app
  // would mint insecure cookies and build wrong absolute URLs.
  out['x-forwarded-proto'] = 'https';
  out['x-forwarded-host'] = publicHost;
  return out;
}

function proxy(
  ctx: Ctx,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handle: PreviewHandle,
  publicHost: string,
  reportId: number,
  waking: Set<number>,
): void {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: handle.port,
      method: req.method,
      path: req.url,
      headers: rewriteHeaders(req.headers, handle.port, publicHost),
    },
    (pres) => {
      const headers = { ...pres.headers };
      // A redirect to the dev server's own address would walk the visitor off the
      // public hostname onto a localhost URL that means nothing on their machine.
      const loc = headers.location;
      if (typeof loc === 'string') {
        headers.location = loc.replace(new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${handle.port}`, 'i'), `https://${publicHost}`);
      }
      res.writeHead(pres.statusCode ?? 502, headers);
      pres.pipe(res);
    },
  );
  upstream.on('error', (e: Error & { code?: string }) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // The dev server died without the worker noticing — it is a detached process,
    // so a crash, a kill, or a machine that slept all leave a handle pointing at
    // a port nobody is listening on. Serving a 502 here is what makes a
    // recoverable preview look broken. Drop the stale handle and put the visitor
    // on the same waiting page as any asleep preview; the wake restarts it.
    const dead = e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EHOSTUNREACH';
    if (dead) {
      ctx.state.previews.delete(handle.runId);
      void ctx.db.updateRun(handle.runId, { preview_status: 'down' }).catch(() => undefined);
      log('preview', `task ${reportId}: dev server on ${handle.port} is gone — restarting it`);
      if (!waking.has(reportId)) {
        waking.add(reportId);
        void ensureLocal(ctx, reportId).finally(() => waking.delete(reportId));
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page('Starting this preview…', `Task #${reportId} is waking up. This takes about a minute — this page refreshes itself.`, true));
      return;
    }
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Preview unavailable', `The dev server stopped responding (${e.message}).`, false));
  });
  req.pipe(upstream);
}

/**
 * Forward `/__api/*` to the real API, so the browser only ever talks to the
 * preview's own origin.
 *
 * The API's CORS allowlist is example.com plus localhost — a preview hostname is
 * neither, so calling it directly fails preflight with no
 * Access-Control-Allow-Origin and every request dies as ERR_FAILED. The
 * alternative was adding preview hosts to that allowlist, which means editing and
 * redeploying the PRODUCTION API to serve QA. This keeps production untouched.
 *
 * The browser's Authorization header rides along, so the API still authenticates
 * the real tester and multi-tenancy is unchanged; this hop adds no privilege.
 */
function proxyApi(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): void {
  let target: URL;
  try {
    target = new URL(ctx.cfg.previewApiOrigin);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('PREVIEW_API_ORIGIN is not a URL');
    return;
  }
  if (target.protocol !== 'https:') {
    // The tester's bearer token is in these requests; never send them in the clear.
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('PREVIEW_API_ORIGIN must be https');
    return;
  }

  const path = (req.url ?? '').slice(API_PREFIX.length) || '/';
  const headers: http.IncomingHttpHeaders = { ...req.headers };
  headers.host = target.host;
  // Present it as the API's own origin: the request is now server-to-server, and a
  // preview hostname in these headers is exactly what the API rejects.
  delete headers.origin;
  delete headers.referer;
  delete headers['sec-fetch-mode'];
  delete headers['sec-fetch-site'];

  const upstream = https.request(
    { host: target.hostname, port: target.port || 443, method: req.method, path, headers },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(res);
    },
  );
  upstream.on('error', (e: Error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `preview could not reach the API: ${e.message}` }));
  });
  req.pipe(upstream);
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

/**
 * Bring this report's preview up on THIS machine, whichever way this machine
 * can: the run's own worktree when it lives here (the runner), else a fresh
 * build from the pushed branch (the preview agent — also the runner's own
 * fallback once a merged task's worktree has been torn down).
 */
async function ensureLocal(ctx: Ctx, reportId: number): Promise<void> {
  if (ctx.cfg.role === 'runner') {
    const run = await ctx.db.latestRunForReport(reportId);
    if (run?.worktree && fs.existsSync(run.worktree)) {
      if (ctx.state.previews.has(run.id)) return; // already up; the reload will find it
      log('preview', `wake: task ${reportId} — starting run ${run.id}'s preview on demand`);
      // skipExam: this is a visitor opening a link, not a fresh fix to be judged.
      await startPreview(ctx, run, true);
      return;
    }
  }
  await ensureAgentPreview(ctx, reportId);
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
