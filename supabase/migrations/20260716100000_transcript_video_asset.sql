-- The transcript cache must know WHICH video it was built from: a lesson can
-- hold several takes (a re-record lands beside the old one), and an
-- asset-blind cache stays pinned to the abandoned take forever (found live:
-- a re-recorded 6:07 lesson kept transcribing/rendering the dead 6:19 take
-- because the source pickers were longest-first and the cache never
-- re-checked). Null = legacy row; acquisition stamps or rebuilds it.
alter table public.lesson_transcript
  add column video_asset_id uuid references public.video_assets(id) on delete set null;
