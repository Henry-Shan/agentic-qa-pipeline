# Setup

Three runtimes, one npm workspace:

- **QA site** (`apps/site`) — Next.js on Vercel (or anywhere Next runs). Board, task pages, ingest API, serves `widget.js`.
- **Worker** (`worker`) — a Node 22 daemon on a machine that has `claude`, `gh`, and a checkout of *your* app.
- **Widget** (`packages/widget`) — built into the site, loaded by your app when a tester is filing a report.

Every interface and environment variable is specified in [`contracts/CONTRACTS.md`](contracts/CONTRACTS.md).

## 0. Prerequisites

- Node ≥ 22, npm ≥ 11
- A Supabase project your app already uses for auth — testers sign in to the QA site with the accounts they already have
- On the worker machine: the `claude` CLI, `gh` authenticated with push access to your app's repo, and a clone of your app with the `ship-task` Claude Code skill installed
- Optional: `cloudflared` for previews reachable off the worker machine

## 1. Database

Apply `db/*.sql` in order to your Supabase project (SQL editor, `supabase db push`, or the Supabase MCP). Everything is `qa_`-prefixed and additive; migration 0001 also creates the private storage bucket `qa-screenshots`.

Then two decisions:

- **Who may mark a task shipped.** Set `owner_name` in `db/0018_owner_only_shipped.sql` and `NEXT_PUBLIC_QA_OWNER_NAME` to that person's QA display name (the name they pick at login, stored in `qa_allowed_emails.display_name`).
- **Role enrichment (optional).** If the host project exposes a security-definer function `qa_reporter_roles(uid uuid)` returning `[{scope, name, role, is_admin}]` and a `profiles(id, email, first_name, last_name)` table, every report carries the reporter's roles and the agent is instructed to reproduce and verify *as that role*. Without them, reports still file; the agent just doesn't know the reporter's permissions.

## 2. QA site

```bash
cp apps/site/.env.example apps/site/.env.local   # fill in
npm install
npm run build:widget                              # → apps/site/public/widget.js
npm run dev                                       # http://localhost:3200
```

Deploy with the same variables (`cd apps/site && vercel --prod`), and set `NEXT_PUBLIC_SITE_URL` to the public URL. `QA_HOST_ORIGINS` must list every origin your app is served from, or `/api/ingest` will reject the widget's POST.

## 3. Testers

Any account in your Supabase project that signs in to the QA site with the team access code (`QA_ACCESS_CODE`) is enrolled into `qa_allowed_emails` on first login. Rotate the code by changing the env var and redeploying. Manual add / remove:

```sql
insert into qa_allowed_emails (email, added_by) values ('tester@example.com', 'admin');
delete from qa_allowed_emails where email = 'former@example.com';
```

## 4. Widget in your app

The widget is **frame-gated**: your app only loads it when it is embedded by the QA site's `/capture` page, so end users never see it. Add a loader to your app that

1. when `window.self !== window.top`, posts `{type:'qa-pipeline:hello'}` to the parent until it receives `qa-pipeline:activate` from an origin in your allowlist (the QA site), then
2. injects `<script src="<NEXT_PUBLIC_SITE_URL>/widget.js" data-qa-endpoint=… data-qa-email=…>` once, with a `window.QAPipeline = { getToken }` bridge that returns the signed-in user's Supabase access token.

Protocol and a reference loader: [`packages/widget/README.md`](packages/widget/README.md) and CONTRACTS § *Widget host integration*. For the sharpest reports, have your build emit `data-component` / `data-element` / `data-source-file` attributes on rendered elements — element pick resolves straight to a source file.

Optional: a `/qa-session` page in your app that accepts a magic-link `token_hash` lets the task page's preview embed sign the tester in without typing credentials (CONTRACTS § *Preview auto-login*).

## 5. Worker

```bash
cp worker/.env.example worker/.env   # RUNNER_REPO, WORKTREE_BASE, PREVIEW_API_ORIGIN, PREVIEW_SUPABASE_* at minimum
npm run dev:worker
npm run selftest                      # end-to-end with a mock dispatcher; cleans up after itself
```

The worker claims `queued` reports every 3 s, builds the evidence envelope, launches headless `claude` in a fresh worktree off `RUNNER_REPO`, and serves a production build of each result as a preview. `PREVIEW_BUILD_CMD` is whatever builds your app inside a worktree (`npm run build` by default); `PREVIEW_APP_DIR` is where the web app lives if it isn't the repo root (`apps/web` in a monorepo). Previews are served with `next start`, so the app is expected to be a Next.js app; the injected `.env.production.local` sets `NEXT_PUBLIC_API_BASE_URL` and the Supabase public vars.

Run it as a service: on macOS edit the paths in [`worker/launchd/com.qa-pipeline.worker.plist`](worker/launchd/com.qa-pipeline.worker.plist), copy it to `~/Library/LaunchAgents/`, and `launchctl load -w` it; on Linux a systemd unit running `node_modules/.bin/tsx worker/src/index.ts` with `WorkingDirectory=<repo>/worker` does the same. State lives in `~/.qa-pipeline/` (`worker.log`, `runs/<reportId>/`, `PAUSED`).

## 6. Previews

- **`PREVIEW_MODE=local`** (default) — `http://localhost:<port>` on the worker machine. Safe; visible only there.
- **Preview agent** — any tester can see every task's preview on their *own* machine by running `npm run dev:agent` (`QA_ROLE=preview`). The site links previews as `http://localhost:4521/p/<task>`; the agent builds that task's branch locally on first open. It only reads the shared DB, so any number can run alongside the single real worker.
- **`PREVIEW_MODE=tunnel`** — `https://<PREVIEW_HOST_PREFIX><reportId>.<PREVIEW_ZONE>` through a managed `cloudflared` tunnel. Previews are one label deep so the zone's existing `*.<zone>` certificate covers them. **Put Cloudflare Access (or equivalent) in front** — a preview is a real build wired to real data. `./worker/setup-tunnel.sh` walks through it and refuses to flip modes until you confirm. The worker never writes DNS for the zone apex, `www`, `api`, `app`, `qa`, or anything in `PROTECTED_HOSTS`.

## Daily ops

- Pause dispatch: `touch ~/.qa-pipeline/PAUSED` (remove to resume)
- Budget: `RUNS_PER_DAY` in `worker/.env`
- Concurrency: `max_runs` / `max_previews` live in `qa_settings` — edit from the site's gear menu; the worker applies changes within ~10 s
- Worktrees: `WORKTREE_BASE`; merged reports tear theirs down automatically
- Logs: `~/.qa-pipeline/worker.log`, per-run `~/.qa-pipeline/runs/<reportId>/`
