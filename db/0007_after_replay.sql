-- "After the fix" session replay: rrweb recording of the replay executed against the
-- preview build, produced by the task page's embedded preview. (Applied 2026-07-31 via MCP.)
alter table qa_runs add column if not exists after_replay_path text;
