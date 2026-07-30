-- QA Pipeline — additive-only migration for the shared Supabase project.
-- Everything is qa_-prefixed; never touches product tables.

create table if not exists qa_allowed_emails (
  email      text primary key,
  added_by   text,
  created_at timestamptz not null default now()
);

create or replace function qa_is_tester() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from qa_allowed_emails
                  where email = coalesce(auth.jwt() ->> 'email', '')) $$;

create table if not exists qa_reports (
  id             bigint generated always as identity primary key,
  title          text not null,
  description    text,
  kind           text not null default 'bug' check (kind in ('bug','feature')),
  status         text not null default 'queued' check (status in
                 ('queued','running','pr_ready','preview','rework','verified',
                  'shipped','failed','blocked','stopped','cancelled')),
  reporter_email text,
  route          text,
  page_title     text,
  component      text,
  source_file    text,
  selector       text,
  testid         text,
  element_text   text,
  click_trail    jsonb not null default '[]',
  console_log    jsonb not null default '[]',
  network_log    jsonb not null default '[]',
  screenshots    jsonb not null default '[]',
  viewport       jsonb,
  app_context    jsonb,
  envelope       jsonb,
  dedup_note     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists qa_reports_status_idx on qa_reports (status, id desc);

create table if not exists qa_runs (
  id             bigint generated always as identity primary key,
  report_id      bigint not null references qa_reports (id) on delete cascade,
  session_id     uuid not null,
  attempt        int not null default 1,
  status         text not null default 'running' check (status in
                 ('running','done','stopped','failed','limited')),
  phase          text not null default 'starting',
  tier           int,
  worktree       text,
  branch         text,
  pr_url         text,
  pr_number      int,
  preview_url    text,
  preview_port   int,
  preview_status text not null default 'none' check (preview_status in
                 ('none','starting','live','down')),
  grounding      jsonb,
  files_changed  jsonb,
  log_tail       text,
  test_plan      text,
  featuretest    jsonb,
  stopped_reason text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  updated_at     timestamptz not null default now()
);
create index if not exists qa_runs_report_idx on qa_runs (report_id, id desc);

create table if not exists qa_events (
  id        bigint generated always as identity primary key,
  report_id bigint not null references qa_reports (id) on delete cascade,
  run_id    bigint references qa_runs (id) on delete cascade,
  ts        timestamptz not null default now(),
  type      text not null,
  message   text,
  payload   jsonb
);
create index if not exists qa_events_report_idx on qa_events (report_id, id);

create table if not exists qa_messages (
  id           bigint generated always as identity primary key,
  report_id    bigint not null references qa_reports (id) on delete cascade,
  author_email text,
  body         text not null default '',
  kind         text not null default 'steer' check (kind in
               ('steer','stop','verdict_fixed','verdict_broken','answer')),
  status       text not null default 'pending' check (status in
               ('pending','delivered','done')),
  created_at   timestamptz not null default now()
);
create index if not exists qa_messages_pending_idx on qa_messages (status, report_id);

create table if not exists qa_area_notes (
  id               bigint generated always as identity primary key,
  area             text not null,
  note             text not null,
  source_report_id bigint,
  created_at       timestamptz not null default now()
);
create index if not exists qa_area_notes_area_idx on qa_area_notes (area, id desc);

-- updated_at maintenance
create or replace function qa_touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists qa_reports_touch on qa_reports;
create trigger qa_reports_touch before update on qa_reports
  for each row execute function qa_touch_updated_at();
drop trigger if exists qa_runs_touch on qa_runs;
create trigger qa_runs_touch before update on qa_runs
  for each row execute function qa_touch_updated_at();

-- RLS: testers (allowlisted, authenticated) can do everything; everyone else nothing.
-- Worker + site API routes use the service role (bypasses RLS).
alter table qa_allowed_emails enable row level security;
alter table qa_reports  enable row level security;
alter table qa_runs     enable row level security;
alter table qa_events   enable row level security;
alter table qa_messages enable row level security;
alter table qa_area_notes enable row level security;

drop policy if exists qa_allowed_emails_read on qa_allowed_emails;
create policy qa_allowed_emails_read on qa_allowed_emails
  for select to authenticated using (qa_is_tester());

do $$
declare t text;
begin
  foreach t in array array['qa_reports','qa_runs','qa_events','qa_messages','qa_area_notes'] loop
    execute format('drop policy if exists %I_tester_all on %I', t, t);
    execute format(
      'create policy %I_tester_all on %I for all to authenticated
       using (qa_is_tester()) with check (qa_is_tester())', t, t);
  end loop;
end $$;

-- Realtime
do $$
begin
  begin execute 'alter publication supabase_realtime add table qa_reports';  exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table qa_runs';     exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table qa_events';   exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table qa_messages'; exception when duplicate_object then null; end;
end $$;

-- Screenshot bucket (private; site serves signed URLs)
insert into storage.buckets (id, name, public)
values ('qa-screenshots', 'qa-screenshots', false)
on conflict (id) do nothing;

-- Seed
insert into qa_allowed_emails (email, added_by)
values ('admin@example.com', 'seed')
on conflict do nothing;
