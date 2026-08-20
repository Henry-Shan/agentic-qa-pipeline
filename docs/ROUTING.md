# How a report flows through the ship-task skill — and a router redesign

## A · Current workflow (the router lives INSIDE the skill, after grounding)

```
Input (the report envelope)
┌────────────────────────────────────────────┐
│ location of the issue (component +         │
│   source_file, route)                      │
│ console log + network log captured         │
│ user's recorded actions (click trail)      │
│ user's description + screenshots           │
│ reporter's role (lab / dept / institution) │
└────────────────────────────────────────────┘
        │
        ▼
┌────────────────────┐   always happens, even for tiny fixes:
│ Grounding          │   read screenshots as images, trace the
│ (QA preamble)      │   vertical slice, reproduce the failing
└────────────────────┘   request with curl, act as reporter's role
        │
        ▼
┌────────────────────┐   signals: files/types touched, spec clarity,
│ Router             │   blast radius + a risk floor — anything
│ (skill Step 1)     │   touching auth / tenancy / migrations /
└────────────────────┘   payments is FORCED to Tier 2+. Doubt → tier up.
        │
        ├── Tier 0 · trivial (docs, copy) ──────► edit directly, no tests
        │
        ├── Tier 1 · small (one obvious fix) ───► one focused test, then fix (TDD, no subagents)
        │
        ├── Tier 2 · standard feature/bugfix ───► blind test agent → separate impl agent → verify
        │
        └── Tier 3 · large / ambiguous ─────────► Tier 2 + adversarial review; STOP and
                                                  ask if acceptance criteria untestable
        │
        ▼
all tiers land the same way:
verify gate → feature-test → branch → push → PR "(auto qa) …" → preview for the tester
```

What today's flow does NOT have: a cheap pre-skill triage. Every report — even a
typo — pays for grounding, and infra-shaped issues (DNS, AWS, env vars) run the
whole code pipeline just to end up "Blocked — needs a human".

## B · Redesign — a router BEFORE the skill

```
Input (same envelope)
┌────────────────────────────────────────────┐
│ location · console log · user's actions    │
│ user's description · screenshots · role    │
└────────────────────────────────────────────┘
        │
        ▼
┌────────────────────┐  one cheap, fast model call (haiku / low effort):
│ Router             │  reads ONLY the envelope, never the codebase.
│ (new worker step,  │  outputs: lane + one-line reason, logged to the
│  before dispatch)  │  task page. Doubt → escalate to the skill lane.
└────────────────────┘
        │
        ├── Fast, simple fix ───────► no grounding, no skill — a small model
        │   (copy, style, one          edits directly in the worktree, runs
        │    obvious file)             typecheck, opens the PR. Minutes, cents.
        │
        ├── Complex fix ────────────► the full ship-task skill, exactly as in
        │   (real feature or           part A: grounding → tiers → blind tests
        │    multi-file bug)           → verify → PR.
        │
        └── Infra fix ──────────────► NO code run at all. Claude drafts a
            (needs human harness:      runbook (what's wrong, which console,
             AWS, DNS, deploy,         which commands), report goes straight
             env vars, billing)        to "needs a human" + assigned — with
                                       the runbook instead of a dead PR.
        │
        ▼
same landing for the two code lanes: verify → PR "(auto qa)" → preview
safety net: any lane can RE-ROUTE UP mid-run (fast fix discovers real logic →
hand off to the skill lane; skill run hits an AWS wall → flip to infra runbook)
```

Where each piece would live: the router is a new worker step (`worker/src/route.ts`,
called from the claim loop before `dispatchRun`); the lane rides on the run row
(`qa_runs.lane`) so the board can show it; the fast lane is a second, slimmer
preamble (no grounding instructions, cheaper `--model`); the infra lane reuses the
existing blocked/assign flow, just with a generated runbook event instead of a
failed run.
