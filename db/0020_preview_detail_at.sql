-- When the current preview phase began, so the site can show how long it has
-- been going. qa_runs.updated_at moves on every unrelated write, so it cannot
-- answer "how long has this been compiling".
alter table qa_runs add column if not exists preview_detail_at timestamptz;

comment on column qa_runs.preview_detail_at is
  'When preview_detail was last written — the start of the current preview phase.';
