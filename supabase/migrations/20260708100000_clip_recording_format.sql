/* ═══════════════════════════════════════════════════════════════════════════
 * Lesson Clip Repurposing — amendment: recording-format-aware routing
 * (FR-1 + FR-2 schema; guide: docs/clips.md § Recording formats & routing)
 *
 * lesson_transcript gains the recording-format FACT (+ where it came from):
 *   recording_format  camera_only | screen_camera | screen_only
 *   format_source     platform (block metadata) | classifier (sampled-frame
 *                     fallback, external uploads only) | creator_override
 *
 * clip_moment_candidate gains the LAYOUT DECISION (FR-2) so creators see what
 * kind of clip a candidate becomes BEFORE rendering:
 *   layout  face_track | stacked_split | slide_short | screen_action_zoom
 *         | audiogram
 *
 * The directive's third layout column target, clip_render_jobs, does not
 * exist yet (M-B) — per the amendment, it folds into that table's CREATE.
 *
 * Backfill note: the pre-amendment rows are integration-test artifacts.
 * Rows whose lesson has a video block carrying recording.mode backfill from
 * that metadata (source 'platform'); the rest take the conservative default
 * camera_only with source 'classifier' (the same degraded default the code
 * uses when no metadata and no frame inspector exist).
 *
 * layout carries a DB default ('face_track') deliberately: pre-amendment gate
 * before-snapshots were captured WITHOUT the column, and the gate's restore
 * upserts those rows verbatim — a defaultless NOT NULL would break legacy
 * reverts. Code always writes layout explicitly; the default only serves
 * legacy snapshot restores.
 * ═══════════════════════════════════════════════════════════════════════ */

/* ─────────────────── lesson_transcript: format columns ────────────────── */

alter table public.lesson_transcript
  add column recording_format text,
  add column format_source text not null default 'platform'
    check (format_source in ('platform','classifier','creator_override'));

update public.lesson_transcript t
set recording_format = b.mode,
    format_source    = 'platform'
from (
  select distinct on (lesson_id)
         lesson_id, content->'recording'->>'mode' as mode
    from public.blocks
   where type = 'video'
     and content->'recording'->>'mode' in ('camera_only','screen_camera','screen_only')
) b
where b.lesson_id = t.lesson_id;

update public.lesson_transcript
set recording_format = 'camera_only',
    format_source    = 'classifier'
where recording_format is null;

alter table public.lesson_transcript
  alter column recording_format set not null;
alter table public.lesson_transcript
  add constraint lesson_transcript_recording_format_check
    check (recording_format in ('camera_only','screen_camera','screen_only'));

/* ────────────────── clip_moment_candidate: layout column ──────────────── */

alter table public.clip_moment_candidate
  add column layout text not null default 'face_track'
    check (layout in ('face_track','stacked_split','slide_short','screen_action_zoom','audiogram'));

/* Pre-amendment candidate rows: their lessons' videos carry no recording
 * metadata (int-test uploads) → camera_only → face_track; the column default
 * already stamped them correctly. */
