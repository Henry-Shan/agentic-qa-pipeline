-- 0013: the pre-skill router (contracts §Router).
--
-- lane is decided BEFORE any expensive work, from the reporter's description
-- alone, and recorded on the report (not the run) so the infra lane — which
-- never spawns a run — is recorded too.
--   fast     small, obvious change: no grounding, no skill, just fix it
--   complex  the full ship-task skill (the current pipeline)
--   infra    needs a human harness (AWS/DNS/env/billing) — no code run at all
alter table qa_reports add column if not exists lane text
  check (lane is null or lane in ('fast', 'complex', 'infra'));
alter table qa_reports add column if not exists lane_reason text;
