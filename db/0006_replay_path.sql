-- rrweb session replay: storage path of the recorded events JSON. (Applied 2026-07-31 via MCP.)
alter table qa_reports add column if not exists replay_path text;
