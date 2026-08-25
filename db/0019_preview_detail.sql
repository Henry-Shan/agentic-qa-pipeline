-- Why a preview is in the state it is in, in words, for the person looking at it.
--
-- preview_status says "down"; the site turns that into "Preview waiting" and the
-- reader has no way to learn whether that means evicted, building, queued behind
-- other builds, or broken. Every one of those reasons already exists in the
-- worker log, which nobody reading the board can see.
alter table qa_runs add column if not exists preview_detail text;

comment on column qa_runs.preview_detail is
  'Human sentence explaining the current preview_status: why it is down, what it is waiting on, or what failed. Written by the worker on every preview state change.';
