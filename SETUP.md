# Setup — QA Pipeline

One-time setup on the dev Mac + cloud. Everything here assumes the repo lives at
`~/qa-pipeline` and the runner clone at `~/qa-pipeline-runner/the host app` (already provisioned).

## 0. Prerequisites (already done on this machine)

- Node ≥22, npm ≥11, `claude` CLI, `gh` (authed), `cloudflared` (brew)
- Supabase: `qa_` tables migrated into the shared the host app project; bucket `qa-screenshots`
- `apps/site/.env.local` and `worker/.env` exist with real values (never commit)

## 1. Site → Vercel  ✅ DONE

Deployed and live at **https://qa-pipeline.vercel.app** (project `qa-pipeline`, all env vars set,
`NEXT_PUBLIC_SITE_URL=https://qa-pipeline.vercel.app`). Redeploy: `cd apps/site && vercel --prod`.

Optional custom domain (qa.example.com): in Cloudflare (example.com zone) add `qa` as CNAME →
`cname.vercel-dns.com`, run `vercel domains add qa.example.com`, then update
`NEXT_PUBLIC_SITE_URL` env + the the host app `NEXT_PUBLIC_QA_WIDGET_URL` accordingly.

## 2. Testers

**Self-enroll (default):** any the host app account signs in at the QA site with the team
**access code** (env `QA_ACCESS_CODE`, currently set) — first successful sign-in adds them to
`qa_allowed_emails` automatically. Rotate the code: update the env var on Vercel + redeploy.

Manual add / remove:

```sql
insert into qa_allowed_emails (email, added_by) values ('tester@lab.edu', 'admin');
delete from qa_allowed_emails where email = 'former@lab.edu';
```

Each report automatically captures the reporter's the host app roles
(lab/department/institution + role name, via `qa_reporter_roles()`) into
`app_context.reporterRoles`, and Claude's dispatch instructions tell it to reproduce as that
role — so a departmental-admin bug is tested with departmental-admin permissions.

## 3. Preview tunnel (remote testers see worktree previews)

```bash
cloudflared tunnel login                 # opens browser, pick example.com zone
cloudflared tunnel create qa-pipeline    # note the tunnel UUID
```

Wildcard DNS: `*.qa-preview.example.com` CNAME → `<TUNNEL_UUID>.cfargotunnel.com` (Cloudflare
dashboard; wildcard routes can't be created by `cloudflared tunnel route dns`).
Then in `worker/.env` set `PREVIEW_MODE=tunnel`, `PREVIEW_DOMAIN=qa-preview.example.com`,
`CF_TUNNEL_NAME=qa-pipeline`. The worker maintains the ingress file and the cloudflared child
process itself.

**Cloudflare Access is REQUIRED, not recommended.** A preview is an in-progress build wired to
the real Supabase and the real API, so an unauthenticated hostname would put lab data on the
public internet. Zero Trust → Access → Applications → Self-hosted, domain
`*.qa-preview.example.com`, policy Allow · Emails → the tester list, identity One-time PIN.

**Certificate prerequisite (this is what blocks it today).** Cloudflare's Universal SSL covers
`example.com` and `*.example.com` but NOT a second-level wildcard like
`*.qa-preview.example.com` — so `preview-50.qa-preview.example.com` gets no certificate and
TLS fails before Access is even consulted (verified: `sslv3 alert handshake failure`, while
`qa.example.com` serves a cert normally). Enable **Advanced Certificate Manager** on the zone
(~$10/mo) with a `*.qa-preview.example.com` cert, and everything else here already works — the
tunnel connects, DNS records are created per run, and the Access policy is in place.

Then run `./worker/setup-tunnel.sh`. It authenticates checks, creates the tunnel, refuses to
switch modes until you confirm Access is in place, flips `PREVIEW_MODE=tunnel`, restarts the
worker, and tells you how to verify (and how to revert). Until then previews stay
`PREVIEW_MODE=local` — visible only on this machine, which is the safe default.

## 3b. Preview agent — previews on a tester's own machine (no tunnel needed)

Any tester can see every task's preview on their **own** localhost by running the preview
agent. The site links previews as `http://localhost:4521/p/<task>`; that URL resolves on
whichever machine clicks it, and the agent there builds the task's branch locally and
redirects to it. First open of a task costs a local build (a few minutes); after that it is
instant until the branch changes.

One-time setup on the tester's Mac (same prerequisites as §0 — Node ≥22, `gh` authed with
repo access; `claude` is NOT needed):

1. Clone this repo, `npm install`.
2. Clone the host app as the runner repo (worktree source): `git clone <the host app> ~/qa-pipeline-runner/the host app`.
3. `worker/.env` with at minimum: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (transfer
   securely), `RUNNER_REPO`, `WORKTREE_BASE`, and the preview values
   (`PREVIEW_SUPABASE_URL`, `PREVIEW_SUPABASE_ANON_KEY`). Leave `QA_BASE_SESSION*` unset.
4. Run it: `npm run dev:agent` (that is `QA_ROLE=preview` — front door + local builds only).

The agent **reads** the shared DB and never writes run state, so any number of testers can
run one alongside the single real worker. Do NOT run `npm run dev:worker` (the full runner
role) on a second machine — its reconcile/steer loops assume the shared rows describe the
local machine and will fight the real worker.

## 4. Worker as a service (launchd)

```bash
cp worker/launchd/com.qa-pipeline.worker.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.qa-pipeline.worker.plist
tail -f ~/.qa-pipeline/worker.log
```

The agent runs the TypeScript source through tsx, so there is no build step and
no risk of a stale `dist` serving old code. It starts at login and restarts on
crash (verified: `kill -9` → back in seconds under a new pid). Sleep still
pauses everything — a sleeping Mac runs nothing — but waking resumes the poll
loop and queued reports are claimed within ~3s.

Useful commands:

```bash
launchctl list | grep qa-worker                 # pid + last exit status
launchctl kickstart -k gui/$UID/com.qa-pipeline.worker   # restart (after code changes)
launchctl unload ~/Library/LaunchAgents/com.qa-pipeline.worker.plist  # stop for good
```

Dev mode instead: `npm run dev:worker`.

## 5. Widget in the host app (branch `feature/qa-widget`)

Merge the branch via the normal PR flow, then set in the the host app web deployment env:

```
NEXT_PUBLIC_QA_WIDGET_URL=https://qa.example.com/widget.js
NEXT_PUBLIC_QA_TESTER_DOMAINS=example.com        # and/or explicit emails:
NEXT_PUBLIC_QA_TESTER_EMAILS=alice@lab.edu,bob@lab.edu
```

Unset = widget fully dormant. Annotation attributes emitted by the build:
`data-component`, `data-element`, `data-source-file`.

## Daily ops

- Pause dispatch: `touch ~/.qa-pipeline/PAUSED` (remove to resume)
- Budget: `RUNS_PER_DAY` in `worker/.env` (default 25)
- Concurrency: `max_runs` / `max_previews` live in the `qa_settings` table — edit from the
  site's gear menu (top bar); the worker applies changes within ~10s. `worker/.env`
  `MAX_RUNS`/`MAX_PREVIEWS` are only fallbacks when the table is missing.
- Worktrees live in `~/qa-pipeline-worktrees`; merged reports tear down automatically; manual:
  `~/qa-pipeline-runner/the host app/.claude/skills/ship-task/teardown-worktree.sh <name>`
- Logs: `~/.qa-pipeline/runs/<reportId>/`, worker log `~/.qa-pipeline/worker.log`
