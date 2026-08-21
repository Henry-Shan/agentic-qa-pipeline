-- 0012: the task questionnaire (contracts §Task input).
--
-- done_when   the tester's own definition of fixed — the examiner's pass/fail
--             oracle and the acceptance criteria the blind test agent encodes.
-- constraints hard boundaries ("no schema migration; web only"). Crossing one
--             is a stop, not a judgment call.
-- reproduce_as role name to reproduce/verify under; null = the reporter's own.
-- files       storage paths of fixtures a recording cannot carry (the PDF that
--             breaks the importer).
alter table qa_doc_sections add column if not exists done_when text not null default '';
alter table qa_doc_sections add column if not exists constraints text not null default '';
alter table qa_doc_sections add column if not exists reproduce_as text;
alter table qa_doc_sections add column if not exists files text[] not null default '{}';
-- Captured alongside the steps, so a dispatched section carries the same
-- diagnostics a widget-filed report does.
alter table qa_doc_sections add column if not exists console_log jsonb not null default '[]'::jsonb;
alter table qa_doc_sections add column if not exists network_log jsonb not null default '[]'::jsonb;

alter table qa_reports add column if not exists done_when text not null default '';
alter table qa_reports add column if not exists constraints text not null default '';
alter table qa_reports add column if not exists reproduce_as text;
alter table qa_reports add column if not exists files text[] not null default '{}';
