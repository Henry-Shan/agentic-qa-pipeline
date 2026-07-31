-- Canvas: arrow blocks + per-block section override. (Applied 2026-07-31 via MCP.)
alter table qa_canvas_blocks drop constraint if exists qa_canvas_blocks_kind_check;
alter table qa_canvas_blocks add constraint qa_canvas_blocks_kind_check
  check (kind in ('pos','text','arrow'));
alter table qa_canvas_blocks add column if not exists meta jsonb;
alter table qa_canvas_blocks add column if not exists section text;
