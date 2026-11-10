# Terminal agent

Lets a **task page on qa.example.com open a real Claude Code terminal on _your_
machine**, in _your_ checkout. Everyone runs their own — the page connects to
`127.0.0.1`, so it reaches whatever machine your browser is on and nothing else.

## Install once

```bash
cd agent
npm install                      # builds node-pty from source
npm run start -- --repo ~/your-app
```

If `npm install` skips the native build (npm ≥11 asks first):

```bash
npm install-scripts approve node-pty && npm rebuild node-pty --build-from-source
```

Leave it running. Then open any task on qa.example.com and press
**Attach terminal**.

## Options

| flag | default | what it is |
|---|---|---|
| `--repo` | cwd | your the host app checkout — the terminal opens here |
| `--port` | `4520` | localhost port the page connects to |
| `--site-origin` | (none) | your QA site's origin, e.g. `https://qa.example.com` — the only non-localhost origin allowed to open the socket |
| `--claude` | `/opt/homebrew/bin/claude` | the Claude Code binary |

## What it runs

- **On the machine that produced the run** (its transcript is in
  `~/.claude/projects/…`): `claude --resume <session>` — the actual session,
  in the run's worktree. If a run is still live it uses `--fork-session`, so the
  worker's own run is never disturbed.
- **On anyone else's machine**: a fresh `claude` in your checkout, seeded with
  the task's description and location, so it opens already knowing the job.

## Why it is safe

- **Bound to `127.0.0.1`.** Nothing is exposed; no tunnel, no port forward.
- **Origin allowlist.** Only the QA site may open the socket — without this, any
  site you happened to visit could reach localhost and get a shell.
- **Your own Supabase session.** The page sends its access token; the agent
  verifies it with Supabase and requires your email to be on the QA allowlist.
  The agent holds **no secret** — only the public URL and anon key.
- One terminal per task, ≤4 total, 30-minute idle timeout, killed when the tab
  closes.
