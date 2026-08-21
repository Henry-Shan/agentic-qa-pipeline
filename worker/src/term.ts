// Attached terminal (contracts §Terminal). A REAL pty running exactly what the
// operator would type themselves:
//
//   cd <worktree|runner repo> && claude --resume <session id>
//
// so Claude Code's own TUI renders — colours, alt-screen, keybindings, ctrl-C,
// resize. Nothing is emulated or proxied through the run state machine.
//
// ── Why this is safe to run at all ──────────────────────────────────────────
// A terminal reachable from a web page is remote code execution as this user,
// so every layer below is load-bearing and none of them is optional:
//
//  1. BOUND TO 127.0.0.1. Never a public interface, never the tunnel. If the
//     Mac is not the machine you are sitting at, there is nothing to connect to.
//  2. ORIGIN ALLOWLIST. Browsers always send `Origin` on a WebSocket handshake.
//     Without this check ANY site you happen to visit could open a socket to
//     localhost and get a shell — that is the actual attack this feature would
//     otherwise create, and it is checked before a single byte is read.
//  3. THE VIEWER'S OWN SUPABASE SESSION. The page sends its access token; this
//     host verifies it with Supabase and requires the email to be on
//     `qa_allowed_emails`. No shared secret is involved, which is what lets the
//     SAME code ship as a standalone agent every tester runs on their own
//     machine (see agent/term-agent.mjs) without handing anyone a privileged key.
//  4. NO SESSION HIJACK. While the worker has a live run on that session, the
//     terminal FORKS it (`--fork-session`) instead of attaching — two clients on
//     one session corrupt it, and the run must win.
//  5. Bounded: one terminal per report, a global cap, and an idle timeout that
//     kills the pty. Closing the tab kills it too.

import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { Ctx } from './state';
import { log } from './util';

const IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_TERMINALS = 4;

interface Live {
  proc: pty.IPty;
  socket: WebSocket;
  idleTimer: NodeJS.Timeout;
}

/** report id → its one live terminal. */
const live = new Map<number, Live>();

/**
 * Verify the browser's Supabase session and require QA tester membership.
 * Uses the PUBLIC url + anon key only — the same check the standalone agent
 * makes, so neither needs a privileged secret.
 */
async function verifyTester(ctx: Ctx, accessToken: string): Promise<string | null> {
  if (!accessToken || accessToken.length > 4096) return null;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  if (!anon) return null;
  try {
    const who = await fetch(`${ctx.cfg.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anon, authorization: `Bearer ${accessToken}` },
    });
    if (!who.ok) return null;
    const email = ((await who.json()) as { email?: string })?.email;
    if (!email) return null;
    const allow = await fetch(
      `${ctx.cfg.supabaseUrl}/rest/v1/qa_allowed_emails?select=email&email=eq.${encodeURIComponent(email)}`,
      { headers: { apikey: anon, authorization: `Bearer ${accessToken}` } },
    );
    if (!allow.ok) return null;
    const rows = (await allow.json()) as unknown[];
    return Array.isArray(rows) && rows.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/**
 * Only the QA site may open a terminal socket. The page can be served from
 * production or from a local dev server, so both are allowed — but nothing
 * else is, which is what stops any other site you visit from reaching
 * localhost and getting a shell.
 */
function originAllowed(ctx: Ctx, origin: string | undefined): boolean {
  if (!origin) return false; // a browser always sends one; anything else is not a browser
  const allowed = new Set(
    [ctx.cfg.siteUrl, 'https://qa.example.com', 'http://localhost:3200', 'http://127.0.0.1:3200'].map((o) =>
      o.replace(/\/$/, ''),
    ),
  );
  return allowed.has(origin.replace(/\/$/, ''));
}

function closeTerminal(reportId: number, why: string): void {
  const entry = live.get(reportId);
  if (!entry) return;
  live.delete(reportId);
  clearTimeout(entry.idleTimer);
  try {
    entry.proc.kill();
  } catch {
    /* already gone */
  }
  try {
    entry.socket.close(1000, why);
  } catch {
    /* already closed */
  }
  log('term', `report ${reportId}: terminal closed (${why})`);
}

/**
 * The terminal host. Returns a close function; never throws — a machine that
 * cannot bind the port simply has no terminal, and the rest of the worker runs.
 */
export function startTerminalHost(ctx: Ctx): () => void {
  if (!ctx.cfg.termEnabled) return () => undefined;

  const wss = new WebSocketServer({ host: '127.0.0.1', port: ctx.cfg.termPort });

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    void (async () => {
      // --- gate 1: origin -----------------------------------------------
      if (!originAllowed(ctx, req.headers.origin)) {
        log('term', `rejected a socket from origin ${req.headers.origin ?? '(none)'}`);
        socket.close(4403, 'origin not allowed');
        return;
      }
      // --- gate 2: the viewer is a signed-in QA tester --------------------
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reportId = Number(url.searchParams.get('report'));
      if (!Number.isInteger(reportId) || reportId <= 0) {
        socket.close(4400, 'bad report');
        return;
      }
      const email = await verifyTester(ctx, url.searchParams.get('t') ?? '');
      if (!email) {
        socket.close(4401, 'unauthorized');
        return;
      }
      // --- gate 3: bounds -------------------------------------------------
      if (live.has(reportId)) closeTerminal(reportId, 'replaced by a newer terminal');
      if (live.size >= MAX_TERMINALS) {
        socket.close(4429, 'too many terminals open');
        return;
      }

      const run = await ctx.db.latestRunForReport(reportId).catch(() => null);
      if (!run) {
        socket.send('\r\n\x1b[31mNo run for this report yet — nothing to resume.\x1b[0m\r\n');
        socket.close(4404, 'no run');
        return;
      }

      // The worker owns a live run's session: fork instead of hijacking it.
      const busy = run.status === 'running';
      const cwd = run.worktree && fs.existsSync(run.worktree) ? run.worktree : ctx.cfg.runnerRepo;
      const args = busy
        ? ['--resume', run.session_id, '--fork-session']
        : ['--resume', run.session_id];

      const proc = pty.spawn(ctx.cfg.claudeBin, args, {
        name: 'xterm-256color',
        cwd,
        cols: Number(url.searchParams.get('cols')) || 100,
        rows: Number(url.searchParams.get('rows')) || 30,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });

      const touch = (): NodeJS.Timeout =>
        setTimeout(() => closeTerminal(reportId, 'idle'), IDLE_TIMEOUT_MS);
      const entry: Live = { proc, socket, idleTimer: touch() };
      live.set(reportId, entry);
      log('term', `report ${reportId}: ${email} ${busy ? 'forked' : 'resumed'} ${run.session_id.slice(0, 8)} in ${cwd}`);

      socket.send(
        `\r\n\x1b[2m${busy ? 'a run is live — forking the session so it is not disturbed' : 'resuming'} · ${cwd}\x1b[0m\r\n`,
      );

      proc.onData((data) => {
        if (socket.readyState === socket.OPEN) socket.send(data);
      });
      proc.onExit(({ exitCode }) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(`\r\n\x1b[2mclaude exited (${exitCode}) — close this panel\x1b[0m\r\n`);
        }
        closeTerminal(reportId, 'process exited');
      });

      socket.on('message', (raw) => {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = touch();
        const text = raw.toString();
        // Control frames are JSON; anything else is literal keystrokes.
        if (text.startsWith('{')) {
          try {
            const msg = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
            if (msg.type === 'resize' && msg.cols && msg.rows) {
              proc.resize(Math.max(20, Math.min(400, msg.cols)), Math.max(5, Math.min(200, msg.rows)));
              return;
            }
          } catch {
            // not a control frame — fall through and type it
          }
        }
        proc.write(text);
      });

      socket.on('close', () => closeTerminal(reportId, 'socket closed'));
      socket.on('error', () => closeTerminal(reportId, 'socket error'));
    })();
  });

  wss.on('error', (e: Error) => log('term', `terminal host error: ${e.message}`));
  log('term', `terminal host on 127.0.0.1:${ctx.cfg.termPort} (localhost only)`);

  return () => {
    for (const reportId of [...live.keys()]) closeTerminal(reportId, 'worker shutting down');
    wss.close();
  };
}
