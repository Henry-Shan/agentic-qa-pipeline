#!/usr/bin/env node
// QA Pipeline — terminal agent (contracts §Terminal).
//
// Run this on YOUR machine and the QA site's task pages can attach a real
// Claude Code terminal to YOUR checkout:
//
//   cd agent && npm install
//   node term-agent.mjs --repo ~/the host app
//
// The task page connects to 127.0.0.1 — i.e. to whatever machine the BROWSER
// is on. So every tester runs their own agent and gets their own terminal; no
// one ever reaches anyone else's machine, and nothing is exposed to the
// internet.
//
// ── Security ────────────────────────────────────────────────────────────────
// A terminal reachable from a web page is remote code execution as you, so:
//  1. BOUND TO 127.0.0.1. Never a public interface. Only pages open in a
//     browser on this machine can reach it.
//  2. ORIGIN ALLOWLIST. Browsers always send `Origin` on a WebSocket
//     handshake. Without this, ANY site you visit could open a socket to
//     localhost and get a shell. Checked before a byte is read.
//  3. YOUR OWN SUPABASE SESSION. The page sends its access token; the agent
//     verifies it with Supabase and requires the email to be on
//     `qa_allowed_emails`. The agent holds NO secret — only the public URL and
//     anon key — so nothing privileged ever sits on a tester's laptop.
//  4. Bounded: one terminal per report, a global cap, an idle timeout, and the
//     pty dies when the socket closes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO = path.resolve(flag('repo', process.cwd()).replace(/^~(?=\/|$)/, os.homedir()));
const PORT = Number(flag('port', '4520'));
const CLAUDE_BIN = flag('claude', '/opt/homebrew/bin/claude');
const SUPABASE_URL = flag('supabase-url', 'https://YOUR-PROJECT-REF.supabase.co');
const SUPABASE_ANON_KEY = flag(
  'supabase-anon-key',
  '<SUPABASE_ANON_KEY>',
);

const ALLOWED_ORIGINS = new Set([
  'https://qa.example.com',
  'http://localhost:3200',
  'http://127.0.0.1:3200',
]);

const IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_TERMINALS = 4;
const live = new Map(); // reportId → { proc, socket, idleTimer }

if (!fs.existsSync(REPO)) {
  console.error(`No such repo: ${REPO}\nRun with --repo /path/to/the host app`);
  process.exit(1);
}

/** Claude Code stores sessions per project dir: the abs path with / → -. */
function projectDir(repoPath) {
  return path.join(os.homedir(), '.claude', 'projects', repoPath.replace(/\//g, '-'));
}

/** Verify the browser's Supabase session and require QA tester membership. */
async function verifyTester(accessToken) {
  if (!accessToken || accessToken.length > 4096) return null;
  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${accessToken}` },
    });
    if (!who.ok) return null;
    const email = (await who.json())?.email;
    if (!email) return null;
    // RLS lets a tester read this table; a non-tester gets an empty array.
    const allow = await fetch(
      `${SUPABASE_URL}/rest/v1/qa_allowed_emails?select=email&email=eq.${encodeURIComponent(email)}`,
      { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${accessToken}` } },
    );
    if (!allow.ok) return null;
    const rows = await allow.json();
    return Array.isArray(rows) && rows.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/** The report, read with the tester's own token (RLS applies). */
async function fetchReport(accessToken, reportId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/qa_reports?select=id,title,description,route,component,source_file,click_trail&id=eq.${reportId}`,
      { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    return (await res.json())?.[0] ?? null;
  } catch {
    return null;
  }
}

/** The run whose session we would resume, if this machine has its transcript. */
async function fetchRun(accessToken, reportId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/qa_runs?select=session_id,worktree,status&report_id=eq.${reportId}&order=id.desc&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    return (await res.json())?.[0] ?? null;
  } catch {
    return null;
  }
}

function closeTerminal(reportId, why) {
  const entry = live.get(reportId);
  if (!entry) return;
  live.delete(reportId);
  clearTimeout(entry.idleTimer);
  try {
    entry.proc.kill();
  } catch {}
  try {
    entry.socket.close(1000, why);
  } catch {}
  console.log(`[term] report ${reportId}: closed (${why})`);
}

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

wss.on('connection', (socket, req) => {
  void (async () => {
    if (!ALLOWED_ORIGINS.has((req.headers.origin ?? '').replace(/\/$/, ''))) {
      console.log(`[term] rejected origin ${req.headers.origin ?? '(none)'}`);
      socket.close(4403, 'origin not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const reportId = Number(url.searchParams.get('report'));
    const accessToken = url.searchParams.get('t') ?? '';
    if (!Number.isInteger(reportId) || reportId <= 0) {
      socket.close(4400, 'bad report');
      return;
    }
    const email = await verifyTester(accessToken);
    if (!email) {
      socket.close(4401, 'unauthorized');
      return;
    }
    if (live.has(reportId)) closeTerminal(reportId, 'replaced');
    if (live.size >= MAX_TERMINALS) {
      socket.close(4429, 'too many terminals open');
      return;
    }

    // Resume the run's session when THIS machine has its transcript (that is
    // only true on the machine that produced the run); otherwise start a fresh
    // Claude in this checkout, seeded with the task so it opens with context.
    const run = await fetchRun(accessToken, reportId);
    const localTranscript =
      run?.session_id && fs.existsSync(path.join(projectDir(REPO), `${run.session_id}.jsonl`));
    const busy = run?.status === 'running';
    const cwd = run?.worktree && fs.existsSync(run.worktree) ? run.worktree : REPO;

    let spawnArgs;
    let banner;
    if (localTranscript) {
      spawnArgs = busy ? ['--resume', run.session_id, '--fork-session'] : ['--resume', run.session_id];
      banner = busy
        ? 'a run is live — forking its session so it is not disturbed'
        : `resuming ${run.session_id.slice(0, 8)}`;
    } else {
      const report = await fetchReport(accessToken, reportId);
      const seed = report
        ? `I'm picking up QA task #${reportId} in this checkout.\n\nReported: ${String(report.description ?? report.title ?? '').slice(0, 1500)}\n\nWhere: ${report.route ?? '?'}${report.component ? ` · ${report.component}` : ''}${report.source_file ? ` · ${report.source_file}` : ''}\n\nStart by orienting yourself in the code — do not change anything yet.`
        : `I'm picking up QA task #${reportId} in this checkout.`;
      spawnArgs = [seed];
      banner = "this machine doesn't have that run's transcript — starting a fresh session with the task's context";
    }

    const proc = pty.spawn(CLAUDE_BIN, spawnArgs, {
      name: 'xterm-256color',
      cwd,
      cols: Number(url.searchParams.get('cols')) || 100,
      rows: Number(url.searchParams.get('rows')) || 30,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const touch = () => setTimeout(() => closeTerminal(reportId, 'idle'), IDLE_TIMEOUT_MS);
    const entry = { proc, socket, idleTimer: touch() };
    live.set(reportId, entry);
    console.log(`[term] report ${reportId}: ${email} · ${banner} · ${cwd}`);
    socket.send(`\r\n\x1b[2m${banner} · ${cwd}\x1b[0m\r\n`);

    proc.onData((d) => {
      if (socket.readyState === socket.OPEN) socket.send(d);
    });
    proc.onExit(({ exitCode }) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(`\r\n\x1b[2mclaude exited (${exitCode})\x1b[0m\r\n`);
      }
      closeTerminal(reportId, 'process exited');
    });

    socket.on('message', (raw) => {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = touch();
      const text = raw.toString();
      if (text.startsWith('{')) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === 'resize' && msg.cols && msg.rows) {
            proc.resize(Math.max(20, Math.min(400, msg.cols)), Math.max(5, Math.min(200, msg.rows)));
            return;
          }
        } catch {}
      }
      proc.write(text);
    });
    socket.on('close', () => closeTerminal(reportId, 'socket closed'));
    socket.on('error', () => closeTerminal(reportId, 'socket error'));
  })();
});

wss.on('error', (e) => console.error(`[term] ${e.message}`));
console.log(`QA Pipeline terminal agent
  listening  127.0.0.1:${PORT}  (localhost only — nothing is exposed)
  repo       ${REPO}
  claude     ${CLAUDE_BIN}

Open a task on qa.example.com and press "Attach terminal".`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const id of [...live.keys()]) closeTerminal(id, 'agent shutting down');
    process.exit(0);
  });
}
