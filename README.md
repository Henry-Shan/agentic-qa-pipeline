# Agentic QA-to-PR Pipeline

**A tester files a bug from inside the app. An autonomous Claude Code agent reproduces it as that tester's role, fixes it in an isolated worktree, opens a PR, and serves a live preview the tester verifies. Humans only merge.**

[How a bug becomes a PR](#how-a-bug-becomes-a-pr) · [Components](#components) · [Design decisions](#design-decisions) · [Safety rails](#safety-rails) · [Run it](#run-it)

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff)
![Next.js](https://img.shields.io/badge/Next.js-App%20Router-000?logo=nextdotjs&logoColor=fff)
![Node 22](https://img.shields.io/badge/Node-22%20ESM-339933?logo=nodedotjs&logoColor=fff)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20RLS%20%2B%20Storage-3ecf8e?logo=supabase&logoColor=fff)
![Claude Code](https://img.shields.io/badge/Claude%20Code-headless%20agent-d97757)
![License](https://img.shields.io/badge/license-MIT-blue)

Most "AI fixes bugs" demos start from a well-written ticket. Real QA doesn't. This pipeline starts one step earlier — at the moment a tester notices something wrong — and captures the evidence an engineer would otherwise spend an hour reconstructing: the exact element, the console and network buffers from page load, a recorded click trail with a DOM replay, pre-marked screenshots, and the reporter's permission role. That envelope is what the agent receives. Every fix lands as a PR with a feature test, behind a verify gate, on a per-task preview URL. Built for and dogfooded at [the host app](https://example.com); the pieces are generic.

## How a bug becomes a PR

```mermaid
flowchart LR
  subgraph app["Host app"]
    W["In-app widget<br/>element pick · screenshots<br/>click trail + DOM replay<br/>console / network buffers"]
  end
  subgraph site["QA site · Vercel"]
    I["POST /api/ingest<br/>JWT-authed · signed-URL uploads"]
    B["Board · task pages<br/>lanes · assignees · live run log"]
  end
  subgraph db["Supabase"]
    R[("qa_reports<br/>+ reporter roles via RPC")]
    S[("Storage<br/>screenshots · replay.json")]
  end
  subgraph worker["Worker daemon · dev machine"]
    C["Claim loop<br/>conditional update queued→running"]
    E["Envelope<br/>grounding · evidence · area notes"]
    A["Headless Claude Code<br/>QA preamble + ship-task skill"]
    P["Preview server<br/>per-worktree production build"]
  end
  W --> I --> R
  I --> S
  R --> C --> E --> A
  S --> E
  A -->|"worktree → tests → fix → verify → PR"| PR["Pull request<br/>(auto qa) …"]
  A --> P
  P -->|"tester verifies"| B
  A -.->|"progress · questions · run info<br/>via localhost shim"| B
  B -.->|"answers · steer · settings"| C
```

Inside the agent, every report pays for **grounding** first — read the screenshots as images, trace the vertical slice, reproduce the failing request with `curl`, act as the reporter's role — then a **risk-tiered router** decides how heavy the pipeline gets:

| Tier | Signal | Pipeline |
|---|---|---|
| 0 · trivial | docs, copy | edit directly |
| 1 · small | one obvious fix | one focused test, then fix (TDD) |
| 2 · standard | feature / bugfix | **blind test agent** (never sees the implementation) → separate implement agent → verify gate |
| 3 · large / ambiguous | multi-file, unclear spec | Tier 2 + adversarial review; stops and asks if acceptance criteria are untestable |

A **risk floor** forces anything touching auth, tenancy, migrations or payments to Tier 2+. Doubt tiers up, never down. All tiers land the same way: verify gate → independent feature test → branch → push → PR → preview.

## Components

```
apps/site/        Next.js (App Router, Tailwind v4) — board, task pages, ingest API, capture frame, serves widget.js
packages/widget/  dependency-free TypeScript → esbuild IIFE, ≤80 KB gzipped — the in-app reporter
worker/           Node 22 ESM daemon — claim · envelope · dispatch · shim · previews · tunnels · reconcile · self-test
agent/            node-pty bridge: attach a real Claude Code terminal to a task from the web page
db/               20 SQL migrations — schema, RLS, security-definer RPCs, settings, lanes, previews
contracts/        CONTRACTS.md — single source of truth for every interface between the three runtimes
docs/             DATA-FLOW.md · ROUTING.md · the original design spec
```

| Piece | What it does |
|---|---|
| **Widget** | Records rolling console/network buffers from page load; element pick resolves selector → React component → source file; ⏺ Start/Finish recording captures a click trail (passwords masked) plus an rrweb DOM replay; screenshots are pre-marked on the picked element. Frame-gated loader with a postMessage handshake so the host never ships the reporter to end users. |
| **Ingest** | Validates a per-host JWT, enriches the report with the reporter's memberships via a security-definer RPC, streams binaries to Storage through signed URLs (bypassing the 4.5 MB serverless body cap), inserts `queued`. |
| **Worker** | Polls and claims with a conditional update (no double-dispatch), downloads evidence to local files, writes `envelope.json`, launches headless `claude` with a QA preamble, exposes a localhost **shim** the run calls for progress beacons, run info and `ask` (questions relay to the board and answers flow back), serves a production-build **preview** per worktree (local or Cloudflare tunnel), and on boot re-attaches detached runs that survived a restart (found by session UUID in argv) or blocks the report if they didn't. |
| **Board** | Lanes, assignees, live run log, the agent's questions inbox, "Test this" preview embed, steer / interrupt, mark-shipped, and operator settings (`max_runs`, `max_previews`) that the worker hot-reloads every 10 s. |
| **Terminal agent** | One click opens the run's *actual* Claude Code session (`--resume`, or `--fork-session` if still live) in its worktree on your machine; on anyone else's machine, a fresh session seeded with the task. |

## Design decisions

- **Evidence over description.** The agent gets what a senior engineer would collect before touching code — not the tester's paraphrase of it.
- **Role-faithful reproduction.** The report carries the reporter's lab / department / institution roles; the agent is instructed to reproduce and verify *as that role*, so a departmental-admin bug is tested with departmental-admin permissions.
- **Blind tests, separate implementer.** The agent that writes the failing test never sees the implementation; a fresh verifier writes one integration test of the key behavior after the build is green.
- **Isolation by construction.** Every run is its own git worktree off the base branch; every preview is its own production build on its own port; nothing runs in the main checkout.
- **Operators stay in the loop without being in the inner loop.** Questions the agent can't answer from the repo surface on the board; everything else proceeds. Concurrency and preview caps are edited live from the UI, not redeployed.
- **Humans merge.** The pipeline stops at PR-ready, every time.

## Safety rails

- Preview builds accept an **anon** Supabase key only — the worker decodes the JWT and refuses `service_role`.
- Shim and terminal agent bind to `127.0.0.1` with an origin allowlist; no tunnel, no port forward.
- Click-trail recording masks password fields; DOM replay is size-capped.
- Daily run cap and concurrency cap (`RUNS_PER_DAY`, `max_runs`), single-flight claims, boot reconciliation of in-flight runs.
- Testers self-enroll with a rotating team access code; row-level security on all 12 tables, service-role access confined to server routes and security-definer RPCs.

## Run it

Three runtimes, one npm workspace. Full setup — Supabase migrations, Vercel deploy, worker daemon, optional Cloudflare tunnel — is in [`SETUP.md`](SETUP.md); every interface and environment variable is specified in [`contracts/CONTRACTS.md`](contracts/CONTRACTS.md).

```bash
npm install
npm run build:widget            # → apps/site/public/widget.js
npm run dev                     # QA site on :3200
npm run dev:worker              # worker daemon (needs worker/.env — see worker/.env.example)
npm run selftest                # end-to-end against real tables with a mock dispatcher:
                                # queued → running → pr_ready → preview → verified,
                                # plus destroy and blocked legs; cleans up after itself
```

Host integration is one `<script>` tag (see [`packages/widget/README.md`](packages/widget/README.md)). The worker needs a checkout of the target repo with the `ship-task` Claude Code skill installed and a `claude` binary.

## Context

Designed 2026-07-30 ([spec](docs/specs/2026-07-30-qa-pipeline-design.md)) and run in production for the host app's web and mobile monorepo. Hostnames, the `qa_` schema prefix and the role model reflect that deployment; the widget, ingest, worker and routing are not the host app-specific.

## License

MIT
