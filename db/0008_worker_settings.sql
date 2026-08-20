-- 0008: site-editable worker settings.
-- Rows override the worker's env defaults (MAX_RUNS / MAX_PREVIEWS) live —
-- the worker polls this table every 10s; a missing row/table falls back to env.
create table if not exists qa_settings (
  key text primary key,
  value integer not null check (value >= 0 and value <= 50),
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into qa_settings (key, value) values ('max_runs', 5), ('max_previews', 3)
  on conflict (key) do nothing;

drop trigger if exists qa_settings_touch on qa_settings;
create trigger qa_settings_touch before update on qa_settings
  for each row execute function qa_touch_updated_at();

alter table qa_settings enable row level security;
drop policy if exists qa_settings_tester_all on qa_settings;
create policy qa_settings_tester_all on qa_settings
  for all to authenticated using (qa_is_tester()) with check (qa_is_tester());
