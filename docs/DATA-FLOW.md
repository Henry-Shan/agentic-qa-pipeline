# Data flow — tester input → Claude's ship-task skill

From what the tester types/clicks/records in the browser, through Supabase, to the
headless `claude` run on the dev Mac — and the results flowing back.

```mermaid
flowchart TD
  subgraph BROWSER["Tester's browser — example.com (widget injected)"]
    IN["<b>Inputs</b><br/>· description / section body — text<br/>· element pick — selector, component, source_file<br/>· ⏺ Start→Finish recording:<br/>&nbsp;&nbsp;clickTrail (JSON steps, passwords masked)<br/>&nbsp;&nbsp;+ rrweb events (DOM video, ≤8M chars)<br/>· screenshots — ≤4 PNG data-URLs<br/>· ambient: consoleLog, networkLog, viewport, route"]
    W["QA widget<br/>(widget.js from qa.example.com)"]
    IN --> W
  end

  subgraph SITE["QA site — Vercel (qa.example.com)"]
    ING["POST /api/ingest<br/>light JSON + uploads:{shots,replay}"]
    DCAP["/doc-capture/[sectionId]<br/>receives postMessage draft"]
    DISP["POST /api/docs/dispatch"]
  end

  subgraph SB["Supabase (shared the host app project)"]
    SEC[("qa_doc_sections<br/>title · body · context · click_trail")]
    REP[("qa_reports — status: queued<br/>+ app_context.reporterRoles<br/>(qa_reporter_roles RPC)")]
    STOR[("Storage: qa-screenshots<br/>report-N/marked*.png · replay.json")]
  end

  W -- "report path: JWT-authed JSON" --> ING
  W -- "doc path: qa-pipeline:draft<br/>(postMessage to parent)" --> DCAP
  ING -- "signed-URL PUTs (binary,<br/>bypasses Vercel 4.5MB cap)" --> STOR
  ING --> REP
  DCAP --> SEC
  DCAP -- "signed-URL PUTs" --> STOR
  SEC -- "Send to Claude ▸" --> DISP
  DISP -- "insert + copy evidence<br/>+ doc_section_id" --> REP

  subgraph MAC["Dev Mac — worker daemon (~/qa-pipeline)"]
    CLAIM["claim loop (3s poll)<br/>queued → running (conditional update)"]
    ENV["envelope.json<br/>· grounding instructions<br/>· full report row<br/>· screenshots downloaded to local files<br/>· area + last 10 area_notes"]
    CLA["headless claude CLI<br/>opus / xhigh + QA-worker preamble<br/>(shim token, beacons, '(auto qa)' title,<br/>stop at PR-ready)"]
    SHIP["<b>ship-task skill</b> (runner repo)<br/>worktree off origin/develop →<br/>blind tests → implement → verify →<br/>feature-test → PR"]
    SHIM["localhost shim :4519<br/>progress / runinfo / ask"]
    PREV["preview server<br/>localhost:33xx (worktree)"]
  end

  REP --> CLAIM --> ENV --> CLA --> SHIP
  STOR -- "screenshot download" --> ENV
  SHIP -- "beacons + runinfo" --> SHIM
  SHIM -- "qa_runs / qa_events /<br/>status pr_ready" --> REP
  SHIP -- "branch + PR '(auto qa) …'" --> GH["GitHub<br/>your-org/the host app → develop"]
  SHIM --> PREV

  subgraph BACK["Feedback to the tester"]
    BOARD["board / doc section<br/>(realtime: pills + pipeline)"]
    EMB["task-page preview embed<br/>auto-login → replays clickTrail<br/>→ 'After the fix' recording"]
  end

  REP -- "supabase realtime" --> BOARD
  PREV --> EMB
  EMB -- "after-replay upload" --> STOR
```

## How Claude consumes each input type

| Input | Consumed as |
|---|---|
| description / section body | the task statement, verbatim (+ `[from doc …]` trailer) |
| selector / component / source_file | entry point for the code trace — never assumed to be the bug's location |
| screenshots | read **as images** (Read tool) before any edit |
| clickTrail | reproduction steps; later re-executed on the preview for the After recording |
| networkLog | the exact failing request — replayed with curl to reproduce & verify |
| rrweb recording | never parsed by Claude — human players only (Before / After tabs) |
| reporterRoles | Claude reproduces and verifies **as that role** (RBAC bugs) |
| area_notes | lessons from previous QA runs in the same code area |
