# Shared contracts — site · widget · worker

Single source of truth for every interface. If you need to deviate, STOP and flag it — do not
silently change a shape another component depends on. DB shapes: see `db/0001_qa_schema.sql`.

## Repo layout (npm workspaces)

```
qa-pipeline/
  apps/site/         Next.js (App Router, TS, Tailwind v4) — Vercel
  packages/widget/   dependency-free TS → esbuild IIFE → apps/site/public/widget.js
  worker/            Node 22+ ESM TS daemon (tsx dev / esbuild dist) — the Mac
  db/                SQL migrations (applied via Supabase MCP)
  contracts/         this file
```

Root `package.json` workspaces: `["apps/site","packages/widget","worker"]`. Node ≥22.

## Environment

`apps/site/.env.local` (and Vercel env):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — shared the host app project
- `SUPABASE_SERVICE_ROLE_KEY` — server routes only
- `QA_INGEST_TOKEN` — random 32-byte hex; widget bundle build stamps NOTHING secret; token is
  passed to the widget at runtime by the host page (see Widget § config)
- `QA_ACCESS_CODE` — team access code; any authed the host app account that presents it on the
  login form is self-enrolled into `qa_allowed_emails` via `POST /api/enroll` (middleware
  exempts that route for authed users; already-enrolled users pass regardless of code)
- `NEXT_PUBLIC_SITE_URL` — https://qa.example.com (http://localhost:3200 in dev)
- `NEXT_PUBLIC_CAPTURE_URL` — the the host app instance embedded full-screen by `/capture`
  (default https://example.com; local dogfood http://localhost:3005)

Ingest role enrichment: the server resolves the reporter's the host app memberships via the
security-definer RPC `qa_reporter_roles(uid)` (service-role only) and stores them as
`app_context.reporterRoles: [{scope, name, role, is_admin}]` plus `app_context.reporterName`;
the worker's envelope instructions direct Claude to reproduce/verify as that role.

`worker/.env`:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `RUNNER_REPO=/Users/YOU/qa-pipeline-runner/the host app`
- `WORKTREE_BASE=/Users/YOU/qa-pipeline-worktrees`
- `CLAUDE_BIN=/opt/homebrew/bin/claude`
- `SHIM_PORT=4519` · `MAX_RUNS=2` · `MAX_PREVIEWS=3` · `RUNS_PER_DAY=25`
- `PREVIEW_MODE=local|tunnel` · `PREVIEW_DOMAIN=qa-preview.example.com` · `CF_TUNNEL_NAME=qa-pipeline`
- `SITE_URL=https://qa.example.com`

## Status model (exact strings, used by all three)

`qa_reports.status`: `queued | running | pr_ready | preview | rework | verified | shipped | failed | blocked | stopped | cancelled`

`qa_runs.phase` (live pipeline label): `starting | grounding | testing | implementing | verifying | feature_test | pr | preview | done`

Board pipeline rendering order: Filed(✓ always) → Queued → Fixing(running/rework) → PR ready → Preview → Verified/Shipped, with `blocked/stopped/failed` as terminal badges.

## Widget → Site: `POST {SITE_URL}/api/ingest`

Headers: `content-type: application/json` + ONE of two auth alternatives:
1. **`authorization: Bearer <supabase access token>`** (preferred) — the widget obtains it at
   submit time from the host page's `window.QAPipeline.getToken()` bridge (awaited, 3s timeout;
   static token is the fallback if the bridge fails). The server verifies the JWT with the
   service-role client (`auth.getUser(jwt)`); the verified email must exist in
   `qa_allowed_emails`, and it OVERRIDES the body's `reporterEmail` — the body's claim is never
   trusted on this path. Bad/unverifiable JWT → 401; email not allowlisted → 403.
2. **`x-qa-token: <QA_INGEST_TOKEN>`** (no Authorization header) — static token, timing-safe
   compare; body `reporterEmail` is trusted as provided.

CORS: allow origins `https://example.com`, `https://www.example.com`, `http://localhost:*` —
implement OPTIONS preflight; `access-control-allow-headers` must include `content-type`,
`x-qa-token`, `authorization` (preflight and response paths); reject other origins and bad
tokens with 403.

```ts
interface IngestBody {
  kind: 'bug' | 'feature';
  description: string;              // tester's sentence
  reporterEmail?: string;           // host page config; on the JWT path the server replaces it
                                    // with the VERIFIED email
  route: string;                    // location.pathname
  pageTitle: string;
  component?: string;               // data-sentry-component OR data-component of picked element
  sourceFile?: string;              // data-sentry-source-file OR data-source-file
  selector?: string;                // computed CSS selector
  testid?: string;
  elementText?: string;             // ≤120 chars
  clickTrail: Array<{ ts: number; route: string; text?: string; testid?: string; component?: string }>; // ≤50
  consoleLog: Array<{ ts: number; level: 'error'|'warn'; text: string }>;                              // ≤50, each ≤500 chars
  networkLog: Array<{ ts: number; method: string; url: string; status: number; ms: number; bodySnippet?: string }>; // ≤40, snippet ≤2000 chars, non-2xx always kept
  viewport: { w: number; h: number; dpr: number };
  appContext?: Record<string, string>;
  screenshotDataUrl?: string;       // PNG data URL ≤4MB, element pre-marked
}
// 200 → { id: number; url: string }  (url = task page)
```

Server behavior: validate + clamp sizes; scrub any `authorization|cookie|token|apikey` value that
survived client scrubbing; upload screenshot to bucket `qa-screenshots` as `report-<id>/marked.png`;
title = first 80 chars of description (fallback `Bug on <route>`); insert `qa_reports`
status `queued`; insert `qa_events` (type `system`, "filed by <email>").

## Widget host integration — frame handshake (the host app ⇄ QA site)

The widget never loads for direct visitors to example.com. The host loader
(`apps/web/components/qa/QAWidgetLoader.tsx` in the the host app repo) is FRAME-GATED: it renders
null and does nothing unless the app runs inside an iframe AND an origin-verified postMessage
handshake with the QA site's `/capture` page completes. (This REPLACES the former
`NEXT_PUBLIC_QA_TESTER_EMAILS`/`NEXT_PUBLIC_QA_TESTER_DOMAINS` email gating.)

Messages (exact shapes, implement exactly):

1. **hello** — loader (the host app), only when `window.self !== window.top`:
   `window.parent.postMessage({type:'qa-pipeline:hello'}, '*')`, retried every 1s (max 30)
   until activated.
2. **activate** — QA `/capture` page, on a hello whose `event.origin` === origin of
   `NEXT_PUBLIC_CAPTURE_URL`: `event.source.postMessage({type:'qa-pipeline:activate',
   endpoint: <NEXT_PUBLIC_SITE_URL>, email: <signed-in QA session email>}, event.origin)`.
3. Loader, on an activate whose `event.origin` ∈ `NEXT_PUBLIC_QA_SITE_ORIGINS`
   (comma-separated; default when unset: the origin of `NEXT_PUBLIC_QA_WIDGET_URL`):
   inject the widget script (src `NEXT_PUBLIC_QA_WIDGET_URL`) ONCE with
   `data-qa-endpoint` = activate.endpoint, `data-qa-email` = activate.email, and set the
   `window.QAPipeline.getToken` session bridge before injection. Duplicate activates ignored.
4. **filed** — widget, after a successful submit, only when `window.self !== window.top`:
   `window.parent.postMessage({type:'qa-pipeline:filed', id, url}, <origin of the configured
   endpoint>)`.
5. QA `/capture` page, on a filed (same origin check as hello): client-side navigate
   (`router.push`) to the task page path parsed from `url`.
6. **token** — widget, at submit time when framed:
   `window.parent.postMessage({type:'qa-pipeline:token'}, <origin of the configured endpoint>)`.
7. **token-result** — QA `/capture` page, on a token request (same origin check as hello):
   `event.source.postMessage({type:'qa-pipeline:token-result', token: <QA session access token
   or null>}, event.origin)`. The widget uses it as `Authorization: Bearer` — this is the
   PRIMARY submit auth in framed mode (the tester is always signed into the QA site, even when
   the embedded app is logged out); the host `getToken` bridge and static token are fallbacks.

Env — QA site: `NEXT_PUBLIC_CAPTURE_URL` (embedded the host app URL), `NEXT_PUBLIC_SITE_URL`
(the activate endpoint). the host app: `NEXT_PUBLIC_QA_WIDGET_URL` (widget bundle URL; unset =
feature fully dormant), `NEXT_PUBLIC_QA_SITE_ORIGINS` (parent origins allowed to activate,
e.g. `https://qa-pipeline.vercel.app,http://localhost:3200`).

Security property: activation requires a parent whose origin is in
`NEXT_PUBLIC_QA_SITE_ORIGINS` — direct visitors to example.com never see the widget.
Submission auth is unchanged: the embedded the host app session's JWT (via the `getToken` bridge)
is verified server-side against `qa_allowed_emails` (see § Widget → Site).

## Site pages

- `/login` — Supabase email+password (the host app accounts). After login, RPC `qa_is_tester()`;
  non-allowlisted → signed-out screen with "ask an admin to add your email".
- `/` — board. Tabs: All / Fixing / Preview / Queued / Shipped (+count). Card: title, reporter,
  age, kind, status pill, live pipeline, `log_tail` when running. Realtime via postgres_changes on
  `qa_reports`+`qa_runs`; fallback 5s poll.
- `/capture` — "Report an issue": full-screen iframe of `NEXT_PUBLIC_CAPTURE_URL` under a slim
  h-12 bar (← Board link, title, hint). Runs the frame handshake above: answers hello with
  activate (signed-in tester's email), navigates to the task page on filed. If no hello within
  8s, shows a dismissible "the widget hasn't loaded inside this copy of the host app" note and
  keeps listening. Board header links here via "＋ Report an issue".
- `/task/[id]` — three zones (matches approved prototype):
  1. Grounding trace chips (`qa_runs.grounding: [{label, file?}]`) + log (from `qa_events`,
     type `log|phase|error|question`, autoscroll).
  2. Result card: Open preview (`preview_url`, disabled until `preview_status='live'`), PR link,
     `files_changed: [{file, add, del}]`.
  3. Steer box (always enabled): textarea + **Send** → insert `qa_messages` kind `steer`;
     **■ Stop** → kind `stop`; verdict buttons when status ∈ {pr_ready, preview}:
     **It's fixed** → kind `verdict_fixed`, **Still broken** (+note) → kind `verdict_broken`.
- Screenshots rendered via server-created signed URLs.
- Design: match prototype — teal `#0F766E/#14B8A6` accent, cool paper ground, Avenir Next/system
  stack, amber=running, green=verified, red=broken. Clean and minimal, no clutter.

## Worker behavior

- **Claim**: poll 3s. `update qa_reports set status='running' where id = (select id from qa_reports
  where status='queued' order by id limit 1 for update skip locked) returning *` — respect
  MAX_RUNS, RUNS_PER_DAY, pause file `~/.qa-pipeline/PAUSED`.
- **Envelope**: `~/.qa-pipeline/runs/<reportId>/envelope.json` = full report row + local screenshot
  paths (downloaded from bucket) + last 10 `qa_area_notes` for the matching area (area =
  `sourceFile` dir or route segment) + instructions header (grounding rules from spec §Grounding).
- **Dispatch**: single-flight lock around worktree setup. Spawn (cwd = RUNNER_REPO, detached pgid):
  `claude -p "<PREAMBLE>\n/ship-task 'Read and execute the task envelope at <abs path>'"
  --session-id <uuid> --output-format stream-json --verbose --dangerously-skip-permissions`
  env: `MANAGER_MODE=1 MANAGER_URL=http://127.0.0.1:$SHIM_PORT MANAGER_SESSION_ID=<uuid>
  QA_SHIM_TOKEN=<per-boot random hex>`.
  PREAMBLE (adapted from manager's relay): never AskUserQuestion; every callback curl includes
  header `x-qa-shim: $QA_SHIM_TOKEN`; POST progress beacons
  `{phase}` to `$MANAGER_URL/api/progress`; report hand-off to `/api/runinfo`; questions via
  `/api/ask` + poll `/api/answer`; stop at PR-ready; never merge.
  Insert `qa_runs` row on spawn. Parse stream-json: assistant text → `qa_events` type `log`
  (throttle 1/2s, tail 200 chars → `qa_runs.log_tail`); `{"type":"result"}` → settle:
  success→ keep status from runinfo; error/stopped sentinel → report `blocked|failed` + reason.
- **Shim** (localhost only): every request must carry `x-qa-shim: $QA_SHIM_TOKEN` — a per-boot
  random hex token the worker exports into each spawned run's env; wrong/missing header → 401
  (constant-time compare). `POST /api/runinfo {session_id, pr_url, branch, worktree, test_plan?,
  files_changed?, grounding?}` → update run+report `pr_ready`, kick preview. `worktree` is
  resolved and must live inside `WORKTREE_BASE`, else 400 + error event.
  `POST /api/featuretest {session_id, verdict...}` → `qa_runs.featuretest`.
  `POST /api/ask {session_id, question, options?}` → event type `question`, report `blocked`.
  `GET /api/answer?session_id=` → oldest pending `qa_messages` (steer/answer) → deliver, report
  back to `running`. `POST /api/progress {phase}` → `qa_runs.phase` + event type `phase`.
- **Steer/stop watcher** (poll 2s, pending `qa_messages`):
  `stop` → SIGINT pgid → status `stopped`. `steer` mid-run → SIGINT, then
  `claude --resume <sid> -p "<note + continue instructions>"` same env/flags (new attempt on same
  `qa_runs` row lineage: attempt+1). `steer|verdict_broken` after done → same resume path, report
  `rework`. `verdict_fixed` → report `verified` + event.
- **Preview**: on pr_ready — free port scan from 3300 step 10; in worktree:
  `npm --prefix apps/web run dev -- --port <p>` with `NEXT_PUBLIC_API_BASE_URL=https://api.example.com`,
  nohup, pid file `<wt>/.qa/preview.pid`; poll health 90s → `preview_status live`,
  `preview_url` = `http://localhost:<p>` (PREVIEW_MODE=local) or
  `https://preview-<runId>.<PREVIEW_DOMAIN>` (tunnel: regenerate cloudflared ingress yaml + restart
  managed cloudflared child + `cloudflared tunnel route dns` once per hostname).
  LRU: >MAX_PREVIEWS → kill oldest idle. Teardown on shipped/cancelled via repo's
  `teardown-worktree.sh`.
- **Ship detect**: poll open PRs 10min (`gh pr view <n> --json state,mergedAt`) → merged →
  `shipped`, teardown, distill `qa_area_notes` (grounding + fix summary + stopped lessons).
- Singleton lockfile; graceful shutdown kills previews not runs; on boot reconcile orphans
  (runs with dead pids → `blocked` with reason).

## Definition of done (integration gate)

- `npm install` at root succeeds; `npm run typecheck` (all workspaces) clean;
  `npm run build:widget` emits `apps/site/public/widget.js` ≤80KB gz;
  `npm run build` in `apps/site` passes; `worker: npm run selftest` (shim boots, claims a seeded
  fake report against a MOCK dispatcher, statuses transition queued→running→pr_ready→preview(local,
  mocked server)→verified via a scripted message; no real claude spawn in selftest).
