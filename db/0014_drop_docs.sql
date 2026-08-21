-- 0014: remove QA Docs. The board + widget is the only entry point again.
--
-- The pipeline features that were introduced alongside Docs STAY, because they
-- belong to the report pipeline, not to Docs: the router (lane/lane_reason),
-- base context (base_session/model), and the examination loop.
--
-- done_when / constraints / reproduce_as / files also stay on qa_reports: the
-- envelope and the examiner read them, and they default to empty, so a
-- widget-filed report simply carries none of them.
alter table qa_reports drop column if exists doc_section_id;
drop table if exists qa_doc_sections;
drop table if exists qa_docs;
