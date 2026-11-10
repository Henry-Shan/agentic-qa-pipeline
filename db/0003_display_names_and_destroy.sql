-- Tester display names + destroy message kind. (Applied 2026-07-31 via MCP.)
alter table qa_allowed_emails add column if not exists display_name text;

create table if not exists qa_tester_names (
  name       text primary key,
  created_at timestamptz not null default now()
);
-- Seed your testers' display names, e.g.:
-- insert into qa_tester_names (name) values ('alice'), ('bob') on conflict do nothing;
alter table qa_tester_names enable row level security;
drop policy if exists qa_tester_names_tester_all on qa_tester_names;
create policy qa_tester_names_tester_all on qa_tester_names
  for all to authenticated using (qa_is_tester()) with check (qa_is_tester());

alter table qa_messages drop constraint if exists qa_messages_kind_check;
alter table qa_messages add constraint qa_messages_kind_check
  check (kind in ('steer','stop','verdict_fixed','verdict_broken','answer','destroy'));
