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
  — `MAX_RUNS`/`MAX_PREVIEWS` are only **fallbacks**: live values come from `qa_settings` (below)
- `PREVIEW_MODE=local|tunnel` · `CF_TUNNEL_NAME=qa-pipeline` · `WAKE_PORT=4521`
- `PREVIEW_HOST_PREFIX=qa-preview-` · `PREVIEW_ZONE=example.com` — a task's permanent
  preview address is `<prefix><reportId>.<zone>`; ONE label deep so `*.<zone>` TLS covers it
- `SITE_URL=https://qa.example.com`

## Worker settings (`qa_settings`, migration 0008)

Key/value rows editable from the site (gear menu in the top bar; tester RLS, any tester may
change them). The worker polls the table every 10s and applies valid rows **over** its env
defaults; a missing table/row or out-of-range value (not an integer 0–50) falls back to env.

- `max_runs` — concurrent claude runs (claim-loop gate). `0` pauses claiming of new reports.
- `max_previews` — live preview servers kept up (oldest evicted above the cap).

Columns: `key text pk · value integer (0–50) · updated_at · updated_by text` (editor's email).

## Ingest direct-upload mode (widget → site → storage)

Vercel serverless functions cap request bodies at ~4.5 MB, so screenshots/replays must
never ride the ingest POST (inline base64 blew it with 413s). The widget now sends
`uploads: { shots: n, replay: bool }` instead of `screenshotDataUrl`/`screenshotsDataUrls`/
`replayEvents`; ingest creates the report, pre-records the storage paths
(`report-<id>/marked.png`, `marked-2.png`…, `replay.json` — identical to the inline flow),
and returns `uploads: { shots: [{path,signedUrl,token}], replay: {…}|null }` (signed
storage-upload URLs). The widget then PUTs each blob directly to Supabase storage
(binary PNG / JSON — best-effort; a failed PUT means missing evidence, never a lost
report). The inline fields remain accepted for backward compatibility (small payloads,
old cached widget bundles).

## Interrupted runs pause and resume themselves (db/0015)

A closed laptop, a sleeping Mac or a worker restart is **not a failure** — the task simply
stopped mid-flight, and the machine can pick it up again. So instead of `failed` + `blocked` +
"press Send to resume", those runs settle as:

- `qa_runs.status = 'interrupted'`, `stopped_reason` "paused — resuming automatically"
- `qa_reports.status = 'queued'` (never `blocked`, never auto-assigned)
- a calm `system` event: "paused — the machine went to sleep or the worker stopped. Resuming
  automatically." — not an `error`
- the board/task pill reads **"Paused — resumes automatically"** (amber, working dot) rather
  than "Queued", because it is waiting to RESUME, not to start

The claim loop treats `interrupted` exactly like `limited`: it `--resume`s the SAME session
(worktree, branch and partial work still on disk) with a note telling the run to re-orient via
`git status` and continue. Detection: reconcile at boot and the orphan sweep both use it, and a
tracked child that exits with **no result text at all** — a vanished process, which is what
sleep looks like — is treated as interrupted rather than failed. A run that genuinely fails
still reports `failed`.

*Verified end to end: a 'running' run whose process was gone → interrupted + requeued + calm
event; unpausing the worker → claimed → attempt 2 resumed the same session, no human involved.*

## Terminal — a real pty, one per tester's own machine

A task page can attach a REAL Claude Code terminal. The page connects to
`ws://127.0.0.1:<port>`, so it reaches **whatever machine the browser is on** — every tester
runs their own host and gets their own terminal, and nobody can reach anyone else's machine.

Two hosts, one protocol and one auth model:
- `worker/src/term.ts` — built into the worker (the machine that produces runs).
- `agent/term-agent.mjs` — a standalone agent any tester runs: `cd agent && npm i && npm start
  -- --repo ~/the host app`. See `agent/README.md`.

**What it runs** depends on whether the machine has that run's transcript
(`~/.claude/projects/<repo-as-dashes>/<session>.jsonl`):
- has it → `claude --resume <session>` in the run's worktree; `--fork-session` when the run is
  still live, so the worker's own run is never hijacked.
- does not → a fresh `claude` in that tester's checkout, seeded with the task's description and
  location, so it opens already knowing the job.

**Security — all four verified against a live socket:**
1. **Bound to `127.0.0.1`.** Never public, never tunnelled. A terminal reachable from the
   internet is remote code execution as that user.
2. **Origin allowlist**, checked before a byte is read. Without it any site you visit could open
   a socket to localhost and get a shell. *Verified: valid tester token + foreign origin → 4403.*
3. **The viewer's own Supabase session.** The page sends its access token; the host verifies it
   with Supabase and requires the email to be on `qa_allowed_emails`. The host holds **no
   secret** — only the public URL and anon key — which is precisely what makes it safe to ship
   to other testers. *Verified: garbage token → 4401; signed-in non-tester → 4401; tester → pty.*
4. Bounded: one terminal per report, ≤4 total, 30-minute idle kill, killed on socket close.

`QA_TERM=0` disables the worker's host; the agent is opt-in by not running it.

## Router — lanes (db/0013)

Before any expensive work, the claim loop asks a cheap model (`QA_ROUTER_MODEL`, default opus
at low effort) to pick a lane from **the reporter's words alone** — no codebase, no
screenshots, no recording. The decision + one-line reason land on `qa_reports.lane` /
`lane_reason` (on the REPORT, so the infra lane, which spawns no run, is recorded too) and show
on the task page. `QA_ROUTER=0` sends everything down the full pipeline.

- **fast** — small, obvious, self-contained. `worker/src/dispatch.ts` `fastPreamble`: **no
  grounding, no `/ship-task`** — reuse `setup-worktree.sh`, make the smallest edit, typecheck +
  lint + existing tests (writes NO new tests), open the "(auto qa)" PR, report runinfo. Preview
  and examination still happen, so the fix is still checked against the tester's own steps.
- **complex** — the full ship-task pipeline, unchanged. **This is the fallback for everything
  uncertain**: an unparseable/timed-out router answer, a disabled router, or any doubt in the
  rubric routes here. Under-routing is expensive; over-routing only costs tokens.
- **infra** — the cause lives outside the repo (cloud console, DNS, env vars, deploy, quota).
  `worker/src/infra.ts` spawns **no code run**: it generates a runbook
  (`{likely_cause, checks[], fix[], verify, risk}`) and posts it as the `needs_human` event,
  then blocks + auto-assigns. Runs in the report's own run dir with an INLINE prompt — claude
  only reads files inside its cwd, and this keeps the lane unable to touch the runner checkout.
- **Route-up escape hatch.** A fast run that discovers the task is bigger must stop with
  `ROUTE-UP: <why>` instead of improvising or opening a PR. The worker re-queues the report with
  `lane='complex'` — a wrong routing costs one cheap run, not a bad PR. A report that already
  has a lane is never re-routed on requeue.

## Widget flow — the record button IS the entry point

There is no element picker in the primary flow. The floating button is a two-state recorder:
**⏺ Record** → recording, live step count (**⏹ Stop · N steps**) → stop opens the form already
holding that window. Consequences:
- `kind` is an explicit **Bug / New feature** toggle in the form (was: picked = bug, skipped =
  feature), and `model` is a **fable / opus / sonnet** toggle defaulting to **opus** —
  `IngestBody.model` → `qa_reports.model`, which the worker uses for the dispatch and every
  later resume.
- **Code location is derived from the recording**, not from a picker: the most recent step that
  named a component/testid wins. Trail entries therefore carry `sourceFile` alongside
  `component`/`testid`/`selector`.
- **Where** shows `recording.route` — the FULL in-app route (pathname + query + hash) captured
  at ⏺ Start, which is where a replay begins.
- **Screenshots are optional**: none is taken automatically; "＋ Add screenshot" re-enters the
  element picker for a targeted shot.
- The collapse pill is now only a collapse affordance (recording no longer lives in the form).

## Task fields carried by a report (db/0012)

Docs were removed (db/0014); the widget is the only entry point. These columns survive on
`qa_reports` because the PIPELINE reads them — they are simply empty for a widget-filed report
until a UI sets them:

- `done_when` — the reporter's own definition of fixed. When present the examiner judges against
  it instead of inventing a bar (`worker/src/examine.ts`); when empty it derives expectations
  from the description, which is the current widget behavior.
- `constraints` — hard boundaries stated in the envelope: crossing one is a STOP, not a
  judgment call.
- `reproduce_as` — role override; null means the reporter's own roles.
- `files` — fixture paths (`report-<id>/files/…`) the envelope downloads into the run dir, for
  bugs a recording cannot carry (a recording has no file bytes).

## Base context + per-task model (db/0011)

A run can START from an existing Claude Code session instead of cold — the **base-context**
session, which already holds an accumulated understanding of the the host app codebase.

- **Fork, don't continue.** The spawn becomes
  `claude --resume <base> --fork-session --session-id <new uuid> …`. Verified behavior: the
  fork inherits the parent's context and **the parent transcript is never written to**, so
  base-context stays pristine across any number of runs. The worker still controls the new
  session id, so tracking (`pgrep` by id) and steer/rework (`--resume <id>`) are unchanged.
- **Staging is required.** Claude Code scopes sessions to the project directory derived from
  cwd (`~/.claude/projects/<abs-path-with-slashes-as-dashes>`). base-context lives under the
  user's own checkout while runs execute from the runner clone, where `--resume` finds nothing.
  `worker/src/base-session.ts` copies the transcript into the runner's project dir (re-copying
  only when the source is newer). A failure to stage is never fatal — the run starts cold.
- **Resolution order** per run: `qa_reports.base_session` (`''` = explicitly cold) → else
  `QA_BASE_SESSION` → else cold. `qa_reports.model` (`fable|opus|sonnet`) overrides
  `QA_CLAUDE_MODEL` for the dispatch AND every later resume of that task.
- Doc sections carry the same two columns and hand them to the report at dispatch; the section
  UI exposes a model segmented control and a "start from base context" checkbox, and the
  "What Claude receives" panel states both. A fork is logged as a `system` event on the task.
- **Cost note:** forking a large session prepends its whole context to every run. Leave it on
  where that grounding pays for itself; uncheck it for trivial tasks.

## Examination — the closed loop (db/0010)

When a fix's preview comes up, the worker re-runs the tester's OWN recorded steps against it
and an examiner model judges whether the expected result is there. No test is written for this
— the recording is the test.

- **Harness** (`worker/exam/exam-run.mjs`, Playwright from the runner repo's node_modules):
  signs in through the preview's `/qa-session` one-time token **as the reporter** (so
  role-dependent behavior reproduces), lands on the report's route (verify-and-retry: the app's
  own post-login redirect can otherwise win the race), then executes each step — resolution
  order testid → selector → label/placeholder/role (typing steps) → text — re-aligning to each
  step's recorded route first. Per step it captures a screenshot, the VISIBLE text (a DOM walk
  that skips mounted-but-hidden drawers, which would otherwise describe a screen the screenshot
  does not show), console errors and failed requests. Writes `evidence.json` + `step-N.png`.
  It asserts nothing.
- **Examiner** (`QA_EXAMINER_MODEL`, default opus/high): a FRESH context that never sees the
  diff. Input: the tester's own words (the oracle), the steps, and the evidence — screenshots
  read as images. It derives the expected results itself and writes
  `{verdict:'pass'|'fail'|'inconclusive', summary, findings:[{claim,met,evidence}]}` to
  `verdict.json`. `inconclusive` is REQUIRED when the evidence can't decide (sign-in failed,
  harness error, the expectation isn't observable) — it must never guess.
- **Loop** (`worker/src/examine.ts`): `pass` → logged, the human still merges. `inconclusive` →
  logged, NO rework (a broken harness must never steer code). `fail` on attempt 1 → automatic
  rework via `resumeRun`, steered with exactly what the examiner observed. `fail` on attempt
  ≥ 2 (`MAX_FIX_ATTEMPTS`) → **stop**: status `blocked` + auto-assigned + a `needs_human` event
  carrying the findings, so a human takes over instead of burning runs.
- Rows land in `qa_examinations` (realtime; tester RLS) and render on the task page with the
  frames the examiner read (`GET /api/exam-shot/[examId]?i=N`). Reports with no recorded steps
  are not examined. Boot-restarted previews are not re-examined. `QA_EXAM=0` disables the loop.

## Preview auto-login (site ↔ the host app web)

The task page's preview embed (and its open-in-tab button) never shows the the host app login
form. Flow: embed POSTs `/api/preview-token` (middleware-gated to testers) → the site's
service role mints `auth.admin.generateLink({type:'magiclink'})` and returns its
`hashed_token` → the iframe/tab loads `<preview>/qa-session#token_hash=…&next=/` → that
the host app-web page (`apps/web/app/(auth)/qa-session/page.tsx`) calls
`verifyOtp({type:'email'})`, establishing a fresh independent session (single-use token;
one minted per embed/tab; the QA site's own session is never shared). On preview hosts
(`localhost`, `127.0.0.1`, `*.qa-preview.example.com`) the host app web writes its auth
cookies `SameSite=None; Secure` so the cross-site iframe can send them; example.com
keeps `Lax`.

## Status model (exact strings, used by all three)

`qa_reports.status`: `queued | running | pr_ready | preview | rework | verified | shipped | failed | blocked | stopped | cancelled`

`qa_messages.kind` now includes **`destroy`** — full teardown request for a report. The worker,
on a pending destroy message: SIGINT any live run · stop the preview server · run the repo's
`teardown-worktree.sh` on the run's worktree · close the PR and delete its remote branch
(`gh pr close <n> --delete-branch`, non-fatal if already closed/merged) · delete the report's
screenshots from the `qa-screenshots` bucket · hard-delete the `qa_reports` row (cascades runs/
events/messages/canvas pos) · remove `~/.qa-pipeline/runs/<id>`. The UI sets the report status
to `cancelled` immediately when queueing a destroy so it disappears from views; the row's actual
deletion lands when the worker completes.

**Display names**: `qa_allowed_emails.display_name` (chosen at login from `qa_tester_names`,
which testers may append to; seeded: owner, mika) is the identity ALL UI surfaces show —
board cards, canvas stickies, task meta, events, `updated_by` labels — falling back to the
email local-part when unset. `reporter_email` remains the auth truth; the login flow saves the
choice via `POST /api/enroll` (`{code?, name}`), and ingest copies it into
`app_context.reporterName` (taking precedence over the the host app profile name).

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
  clickTrail: Array<{ ts: number; route: string; kind?: 'click'|'input'; text?: string; testid?: string; component?: string; selector?: string; value?: string }>; // ≤200
  //  `route` is the FULL route — pathname + search + hash (`buffers.currentRoute()`).
  //  Query/hash carry real app state (selected sheet, filters, open entry), so a bare
  //  pathname replays into a different screen than the tester recorded.
  //  Key steps are `kind:'click'` with `text:'pressed Enter'|'pressed Escape'|'pressed Tab'`.
                                    // kind defaults to 'click'. 'input' entries record typing:
                                    // value = final field value (≤120 chars, scrubbed; NEVER
                                    // recorded for type=password / autocomplete password|cc-*),
                                    // selector = stable selector for replay targeting.
                                    // TOTAL-RECALL rules: listeners are window-level capture-phase
                                    // (stopPropagation cannot hide events); recorded inputs include
                                    // text fields, textareas, contenteditable, select changes
                                    // (value = chosen label), checkbox/radio toggles
                                    // (value = 'checked'/'unchecked'), and Enter-key submits
                                    // (kind 'click', text 'pressed Enter'). Ring buffer 200;
                                    // server clamps to the last 200. Privacy rules unchanged.
  consoleLog: Array<{ ts: number; level: 'error'|'warn'; text: string }>;                              // ≤50, each ≤500 chars
  networkLog: Array<{ ts: number; method: string; url: string; status: number; ms: number; bodySnippet?: string }>; // ≤40, snippet ≤2000 chars, non-2xx always kept
  viewport: { w: number; h: number; dpr: number };
  appContext?: Record<string, string>;
  screenshotDataUrl?: string;       // PNG data URL ≤4MB, element pre-marked
  screenshotsDataUrls?: string[];   // additional captures (≤3), same limits each; the widget's
                                    // drawer lets the tester re-enter the picker to add more.
                                    // Server stores marked.png + marked-2.png … under report-<id>/.
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

### Replay (embedded preview on the task page)

The task page embeds the run's `preview_url` in an iframe and answers the loader's hello with
the SAME activate flow as /capture (shared logic). Additional messages:
8. **replay** — task page → widget, once after activation:
   `{type:'qa-pipeline:replay', route, trail: ClickTrailEntry[], selector?, elementText?}`.
   The widget enters replay mode: navigates to `route` — the FULL route including query and
   hash, so `/inventory?sheet=a` replays on that sheet, not on a bare `/inventory` — then
   EXECUTES the recorded procedure in order. **Fidelity rules:** before each step, if the
   step's own recorded `route` differs from the current location, re-navigate to it (follows
   the tester's actual path even when a click no longer navigates, or they used Back); and the
   tester's OWN pacing is honored — the recorded gap between consecutive steps beyond the
   ~1.2s execution cadence is slept off, capped at 3s per gap (90s whole-replay budget), so
   deliberate pauses and rapid sequences reproduce rather than being flattened.
   For `click` steps: cursor glide + REAL `.click()` on the resolved target (so
   navigation/dialogs actually happen); for `input` steps: focus the field and type the
   recorded `value` character-by-character (~30ms/char, native value setter + `input` event so
   React-controlled fields update), caption "N · typed …". Resolution: selector → testid →
   `[data-component]` → visible text; unresolvable steps are skipped and counted. Finish with a
   sustained highlight on `selector`/`elementText`. Password steps never exist (never recorded).
   The fab stays hidden during replay.
9. **replay-done** — widget → task page: `{type:'qa-pipeline:replay-done', shown, skipped}`.
   The task page shows a small "replayed N steps" note and a ⟳ Replay button re-sends message 8.

### Needs-a-human (blocked) flow

When a run settles `blocked`, the worker: (1) never has a PR — the dispatch PREAMBLE forbids
creating a PR when stopping blocked (report the branch/worktree instead); (2) generates a
concise handoff via `claude --resume <session> -p` asking for EXACTLY this structure (≤1500
chars): "**What went wrong** (1-2 sentences) / **What I analyzed** (2-4 bullets) / **What to
do** (numbered steps a human can follow)"; (3) stores it as `qa_events`
`{type:'needs_human', message: <summary>}` and keeps report status `blocked`.
Site: the board shows a "Needs <displayName>" band pinned above the tabs listing blocked
reports whose `reporter_email` = the signed-in user, each expandable to the needs_human
summary; the task page renders the summary prominently. The top bar greets with the chosen
display name (email only in the tooltip).

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
- **Canvas view: REMOVED** (route, components, tools; `qa_canvas_blocks` table retained but unused).



### Session replay (rrweb)

- **Recording is EXPLICIT — ⏺ Start / Finish, no ambient capture.** The drawer's
  "⏺ Record the steps" button starts a FRESH single-window rrweb recorder (`manual` mode: no
  checkout rotation, so a long take never loses its beginning) and collapses the drawer to a red
  Finish pill; the pill (or closing the drawer, which discards the take) ends it. The report
  ships ONLY that window: `clickTrail` = the trail entries inside [t0, t1] (empty array when
  nothing was recorded), `replayEvents` = that window's recording, `route` = the route at
  ⏺ Start. Console/network buffers stay rolling from page load as before. The after-the-fix
  replay recorder keeps the rolling two-window mode (its length is bounded by the replay).
  `blockSelector: '[data-qa-pipeline]'` (never records its
  own UI). **Input masking mirrors the click-trail rules exactly — no stricter, no looser**:
  typed values ARE recorded (the replay must show what the tester actually typed), EXCEPT
  `type=password` and fields whose autocomplete matches `password|cc-|card|otp`, which are
  masked unconditionally. (A stricter mask made replays useless — the video showed an empty
  field for a step captioned `typed "…"`.) Recording only when the widget is active.
- Submit: `IngestBody.replayEvents?: string` — JSON.stringify of the buffered rrweb events,
  client-capped at 8_000_000 chars (drop the field entirely when over). Server: validate size,
  upload VERBATIM to bucket `qa-screenshots` as `report-<id>/replay.json`, store the path in
  `qa_reports.replay_path` (db/0006). Events are display data — never parsed server-side.
- **Step markers.** Every trail step captured during a ⏺ Start→Finish window also emits an
  rrweb custom event `addCustomEvent('qa-step', {i, kind, label})` — `i` re-sequenced to the
  step's 1-based index WITHIN the window (= its `clickTrail` index) — and the dedicated recorder
  marks steps while a replay executes. Players read them back
  (`{type:5, data:{tag:'qa-step', payload}}`) as marks at `ev.timestamp - events[0].timestamp`.
- **Player UX (task page only — the drawer has no player): CONTINUOUS playback.** The recording
  plays as real footage — the actual site DOM with the cursor moving, clicks landing and typing
  appearing — autoplaying from the top on load. Transport: ▶/⏸, scrub bar with clock, 1×/2×
  speed, ⟲. The step marks ride a tick rail above the transport and the numbered trail list
  beneath stays synced with the footage (via the marks); clicking a tick or row jumps playback
  there.
  - **Step jumps while PAUSED land on the SETTLED frame**: `mark.offset + 700ms`, clamped to
    `nextMark.offset - 50ms` and the recording length — the static frame shows the step's
    EFFECT. While PLAYING a jump seeks to the step's instant and the effect unfolds as footage.
  - **Final outcome mark**: when the recording continues ≥500ms past the last step, a synthetic
    trailing mark labelled "result" keeps the outcome reachable from the rail/keys.
  - **Navigation**: ← / → / Home / End while the card has focus (ignored while a text field has
    focus); clicking the LEFT third of the stage steps back, the RIGHT third forward, the middle
    third stays inert.
  Recordings without `qa-step` marks (pre-existing ones) fall back to marks derived from the
  report's `click_trail` timestamps, and failing that to a plain timeline.
- Site: `GET /api/replay/[id]` — auth+allowlist gated like /api/shot, 302 to a 10-min signed URL.
  The task page, when `replay_path` is set, shows a "Session replay" player card (rrweb-player
  or rrweb Replayer + minimal controls) in the hero area — above/tabbed with the live-preview
  embed for web reports; hidden for reports without a recording.
- Bundle budget: widget ≤80KB gzipped (recorder only — the player lives in the site bundle).
- Task page "Talk to Claude" card includes **⧉ Copy Claude session** — copies
  `cd $NEXT_PUBLIC_RUNNER_REPO && claude --resume <latest run session_id>` to the clipboard so a
  developer can open the very session that produced the fix.
- Task page layout: the HERO is large, top-center, full content width (~16:9), above the
  trace/log and result columns. Its content is a **segmented switch**, in this order:
  **Before (the report)** — the tester's rrweb session replay, DEFAULT whenever `replay_path`
  is set · **After the fix** — the rrweb recording of the replay executed against the preview
  build (`qa_runs.after_replay_path`), shown only once it exists · **Live preview** — the
  interactive preview iframe, only while `preview_status='live'`.
  There is NO "preview offline" placeholder — when nothing is available (no recording, no live
  preview) the hero is simply omitted.
- **After-the-fix recording**: when the task page runs the auto-replay inside the live preview,
  the widget records that execution with rrweb and returns it — message 9 gains
  `events?: string` (JSON, same 8 MB cap; omitted when over). The task page POSTs it to
  `POST /api/after-replay/[id]` (tester-auth'd) which stores it at
  `report-<id>/after-replay-<runId>.json` and sets `qa_runs.after_replay_path` (db/0007).
  Re-running the replay overwrites it.
- **Task action row** (single organized row under the steer textarea, left→right):
  primary **Send to Claude** · secondary **Assign to <name>** (with its ▾ picker) ·
  destructive-ghost **■ Stop run** (while running/rework/blocked — a blocked run still holds a
  dispatch slot and polls for an answer, so it must be stoppable), right-aligned and visually
  separated. Equal heights (36px), 8px radius, 8px gaps, wrapping gracefully on narrow widths.
  "Delete everything" stays where it is — bottom, outside this row.
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
  `preview_url` = `http://localhost:<p>`. Previews are local-only until shared.
  LRU: >MAX_PREVIEWS → kill oldest idle, **except the published run** (evicting the one
  link outsiders hold would 530 it silently). Teardown on shipped/cancelled via repo's
  `teardown-worktree.sh`.
- **Per-task preview URL** (PREVIEW_MODE=tunnel): every task has ONE permanent address,
  `qa-preview-<reportId>.example.com` — keyed by report, not run, so a rework keeps the
  same link. One label deep on purpose: the zone's existing `*.example.com` certificate
  covers it, while `preview-<n>.qa-preview.example.com` (two levels) fails the TLS
  handshake and would need a paid wildcard.
  On preview live: `cloudflared tunnel route dns` once per hostname (persisted in
  `routed-hostnames.json`, idempotent), regenerate ingress yaml, restart the managed
  cloudflared child. The DNS record is never deleted — that is what makes the URL
  permanent. A newer run for the same report supersedes the older run's preview so two
  dev servers never contend for one hostname.
  **Guard**: only `^<prefix>\d+\.<zone>$` may ever be routed or served
  (`qa-preview-<digits>.example.com`). A digits-only label cannot spell `api`, `www`,
  `qa` or the apex, so no misconfiguration can aim a DNS write at production;
  `PROTECTED_HOSTS` is a second, redundant check. Enforced in `startPreview` and
  per-record in the DNS loop. 23 unit cases.
- **Front door** (`frontdoor.ts`, 127.0.0.1:`WAKE_PORT`, tunnel mode only): cloudflared's
  ingress is a SINGLE catch-all rule pointing here — no per-hostname rules, so starting or
  stopping a preview never rewrites the config or restarts cloudflared. It routes by Host:
  - preview up → **proxy** to its dev server (HTTP + the `/_next/webpack-hmr` websocket)
  - preview down → start it and hold the browser on a self-reloading page
  - host not `<prefix><digits>.<zone>` → 404
  **Header rewrite (this is load-bearing).** Next 16 blocks cross-origin requests to
  `/_next/*` unless the host is in `allowedDevOrigins`, keying off the **Origin** header
  (Referer for `sec-fetch-mode: no-cors`) — see `block-cross-site-dev.ts`. A preview served
  at `qa-preview-46.example.com` is cross-origin by that rule, so HMR and every dev chunk
  403: the HTML renders and then nothing hydrates, i.e. the page looks fine but no click
  does anything. The front door therefore presents each request as `localhost:<port>`
  (Origin, Referer, Host) and adds `x-forwarded-proto/host` so the app still knows it is on
  https. The fix lives here, NOT in the app's `next.config` — the worktree's diff becomes
  the PR, and a preview-only config change has no business in it.
  Also rewrites upstream `Location` headers off `localhost:<port>` back onto the public host.
  *Verified in a real browser: all `_next` chunks 200, HMR socket 101, clicking Sign In
  navigates to /login, typing lands in React state, zero console errors. Direct to the dev
  server with the public Origin still 403s — the rewrite is what fixes it.*
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
