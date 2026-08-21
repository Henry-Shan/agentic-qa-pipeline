-- 0010: the examination loop (contracts §Examination). After a fix's preview
-- comes up, the worker re-executes the tester's recorded steps headlessly and
-- an examiner model judges whether the expected result is there. A fail steers
-- a rework; two failed fix attempts stop and route to a human.
create table if not exists qa_examinations (
  id bigint generated always as identity primary key,
  report_id bigint not null references qa_reports(id) on delete cascade,
  run_id bigint references qa_runs(id) on delete set null,
  /** qa_runs.attempt this examination judged. */
  attempt integer not null default 1,
  verdict text not null check (verdict in ('pass', 'fail', 'inconclusive')),
  summary text not null default '',
  /** [{claim, met, evidence}] — the examiner's per-criterion findings. */
  findings jsonb not null default '[]'::jsonb,
  /** Storage paths of the per-step screenshots the examiner read. */
  shots text[] not null default '{}',
  steps_shown integer not null default 0,
  steps_skipped integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists qa_examinations_report_idx on qa_examinations (report_id, id desc);

alter table qa_examinations enable row level security;
drop policy if exists qa_examinations_tester_all on qa_examinations;
create policy qa_examinations_tester_all on qa_examinations
  for all to authenticated using (qa_is_tester()) with check (qa_is_tester());

do $$
begin
  begin execute 'alter publication supabase_realtime add table qa_examinations'; exception when duplicate_object then null; end;
end $$;
