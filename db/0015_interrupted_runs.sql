-- 0015: an interrupted run is PAUSED, not failed (contracts §Worker behavior).
-- A closed laptop, a sleeping Mac or a worker restart used to settle a run as
-- 'failed' + report 'blocked' + "press Send to resume" — a human chore for
-- something the machine can do itself. 'interrupted' means "nothing is wrong,
-- it just stopped mid-flight": the report returns to 'queued' and the claim
-- loop resumes the SAME session automatically when the worker is next alive.
alter table qa_runs drop constraint if exists qa_runs_status_check;
alter table qa_runs add constraint qa_runs_status_check
  check (status in ('running','done','stopped','failed','limited','interrupted'));
