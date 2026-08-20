-- 0009: QA Docs — Notion-style documents whose sections carry app context +
-- recordings and dispatch to Claude as reports (contracts §QA Docs).
create table if not exists qa_docs (
  id bigint generated always as identity primary key,
  slug text not null unique,
  emoji text,
  title text not null,
  description text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists qa_docs_touch on qa_docs;
create trigger qa_docs_touch before update on qa_docs
  for each row execute function qa_touch_updated_at();

create table if not exists qa_doc_sections (
  id bigint generated always as identity primary key,
  doc_id bigint not null references qa_docs(id) on delete cascade,
  position double precision not null,
  title text not null default '',
  body text not null default '',
  kind text not null default 'feature' check (kind in ('bug', 'feature')),
  -- Context captured from the app (widget doc mode) — all optional.
  route text,
  component text,
  source_file text,
  selector text,
  element_text text,
  click_trail jsonb,
  viewport jsonb,
  screenshots text[] not null default '{}',
  replay_path text,
  -- Set at dispatch; deleting the report only unlinks the section.
  report_id bigint references qa_reports(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists qa_doc_sections_touch on qa_doc_sections;
create trigger qa_doc_sections_touch before update on qa_doc_sections
  for each row execute function qa_touch_updated_at();
create index if not exists qa_doc_sections_doc_idx on qa_doc_sections (doc_id, position);

-- Back-reference: a report knows the section that dispatched it.
alter table qa_reports add column if not exists doc_section_id bigint references qa_doc_sections(id) on delete set null;

alter table qa_docs enable row level security;
alter table qa_doc_sections enable row level security;
drop policy if exists qa_docs_tester_all on qa_docs;
create policy qa_docs_tester_all on qa_docs
  for all to authenticated using (qa_is_tester()) with check (qa_is_tester());
drop policy if exists qa_doc_sections_tester_all on qa_doc_sections;
create policy qa_doc_sections_tester_all on qa_doc_sections
  for all to authenticated using (qa_is_tester()) with check (qa_is_tester());

do $$
begin
  begin execute 'alter publication supabase_realtime add table qa_docs'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table qa_doc_sections'; exception when duplicate_object then null; end;
end $$;
