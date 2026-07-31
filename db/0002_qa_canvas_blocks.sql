-- Canvas view state: sticky positions + free text labels. (Applied 2026-07-31 via MCP.)
create table if not exists qa_canvas_blocks (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('pos','text')),
  report_id  bigint unique references qa_reports (id) on delete cascade,
  text       text,
  x          double precision not null default 0,
  y          double precision not null default 0,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table qa_canvas_blocks enable row level security;
drop policy if exists qa_canvas_blocks_tester_all on qa_canvas_blocks;
create policy qa_canvas_blocks_tester_all on qa_canvas_blocks
  for all to authenticated using (qa_is_tester()) with check (qa_is_tester());
do $$ begin
  begin execute 'alter publication supabase_realtime add table qa_canvas_blocks'; exception when duplicate_object then null; end;
end $$;
