-- 0016: one shareable preview at a time (contracts §Preview).
-- Universal SSL covers *.example.com but NOT *.qa-preview.example.com, so a
-- per-run hostname needs a paid certificate. A SINGLE one-level hostname is
-- already covered, so the worker points it at whichever run is "published".
-- 0 = nothing published (previews stay local-only).
alter table qa_settings drop constraint if exists qa_settings_value_check;
alter table qa_settings add constraint qa_settings_value_check
  check (value >= 0 and value <= 100000000);
insert into qa_settings (key, value) values ('published_run', 0)
  on conflict (key) do nothing;
