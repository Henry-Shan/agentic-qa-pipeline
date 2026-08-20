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

**Cloudflare Access (strongly recommended):** Zero Trust → Access → add an application for
`*.qa-preview.example.com` with a policy allowing the same tester emails (one-time PIN). Until
this exists, keep `PREVIEW_MODE=local`.

## 4. Worker as a service (launchd)

```bash
cd ~/qa-pipeline && npm run build:worker
cp worker/launchd/com.qa-pipeline.worker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.qa-pipeline.worker.plist
tail -f ~/.qa-pipeline/worker.log
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
