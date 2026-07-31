-- Task assignment to a tester display name. (Applied 2026-07-31 via MCP.)
alter table qa_reports add column if not exists assignee text;
create index if not exists qa_reports_assignee_idx on qa_reports (assignee) where assignee is not null;
