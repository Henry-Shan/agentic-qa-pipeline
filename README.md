# QA Pipeline

Internal tool: testers file bugs/feature requests from inside example.com (widget), Claude
autofixes them via /ship-task on the dev Mac (worker), testers verify the fix on a live
worktree preview — all before a human merges the PR.

- Spec: `docs/specs/2026-07-30-qa-pipeline-design.md`
- Interfaces: `contracts/CONTRACTS.md` (single source of truth)
- DB: `db/0001_qa_schema.sql` — applied to the shared the host app Supabase project (`qa_` tables)
- Setup on a new machine: `SETUP.md`

```
apps/site        qa.example.com — board, task pages, ingest API, serves widget.js
packages/widget  in-app reporter (IIFE bundle → apps/site/public/widget.js)
worker           Mac daemon: claim → dispatch claude ship-task → previews → tunnels
```
