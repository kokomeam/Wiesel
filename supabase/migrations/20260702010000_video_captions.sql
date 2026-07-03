-- CourseGen Pro — Video captions & transcripts (Mux auto-generated).
--
-- Adds caption/transcript state to `video_assets` (the source of truth for Mux
-- status). Captions are requested at upload (generated_subtitles) or on demand for
-- an already-ready asset, produced ASYNCHRONOUSLY by Mux after ingest, and detected
-- via polling + the `video.asset.track.ready` webhook. Playback never waits on them.
--
-- Design notes:
--   • Caption metadata (status/track id/name/language/source) is mirrored onto the
--     block via the validated UPDATE_VIDEO_LESSON patch; the heavy transcript text
--     stays HERE (authoritative) and rides in the live view, keeping the course
--     document jsonb lean.
--   • `transcript` = plain text (searchable / future AI: summaries, chapters,
--     quizzes, timestamped help). `transcript_vtt` = the raw WebVTT / timed
--     transcript (drives the synced caption overlay; extension point for WebVTT
--     export + transcript-based editing).

alter table public.video_assets
  add column if not exists caption_status text not null default 'none'
    check (caption_status in ('none','generating','ready','failed')),
  add column if not exists caption_track_id text,
  add column if not exists caption_track_name text,
  add column if not exists caption_language_code text,
  add column if not exists caption_source text
    check (caption_source is null or caption_source in ('generated','uploaded')),
  add column if not exists caption_error text,
  add column if not exists transcript text,
  add column if not exists transcript_vtt text,
  add column if not exists transcript_updated_at timestamptz;

-- Speeds up "which assets are still generating captions" style lookups.
create index if not exists video_assets_caption_status_idx
  on public.video_assets(caption_status);

-- RLS unchanged: the existing author-only policies cover the new columns; the Mux
-- webhook writes via the service-role client (bypasses RLS by design).
