-- 0011: per-task base context + model choice (contracts §Base context).
--
-- base_session: a Claude Code session id to FORK from instead of starting cold
-- (`--resume <id> --fork-session`), so the run begins with that session's
-- accumulated understanding of the codebase. The parent session is never
-- written to. NULL = the worker default (QA_BASE_SESSION), '' = explicitly cold.
-- model: which model runs this task — 'fable' | 'opus' | 'sonnet'; NULL = worker default.
alter table qa_reports add column if not exists base_session text;
alter table qa_reports add column if not exists model text;
alter table qa_doc_sections add column if not exists base_session text;
alter table qa_doc_sections add column if not exists model text;
