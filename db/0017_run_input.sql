-- What the model was actually given, kept next to the run that used it.
--
-- The envelope is built per claim and written to ~/.qa-pipeline/runs/<id>/envelope.json,
-- which only exists on the worker's machine — so the task page could never show
-- what Claude was really handed, only a reconstruction from the report row. These
-- two columns make the real input readable from the site.
--
-- On the RUN, not the report: an envelope embeds the whole report, so storing it on
-- qa_reports would nest the row inside itself on every rebuild.
alter table qa_runs add column if not exists envelope jsonb;
alter table qa_runs add column if not exists prompt text;

comment on column qa_runs.envelope is
  'The exact envelope.json handed to Claude for this run: instructions, the report as it stood, screenshots/files, area and area notes.';
comment on column qa_runs.prompt is
  'The literal -p string the run was started with (the first thing the model reads).';
