/* ═══════════════════════════════════════════════════════════════════════════
 * Lesson Clip Repurposing — Milestone M-C: ingest into the social queue
 *
 * A completed render becomes a `social_post` row (`post_type='clip'`) so the
 * ONE queue holds text posts and clips (PRD M-C). Platform enum extension is
 * GATED: text posts stay closed at LinkedIn+Facebook (the Phase 1 fence,
 * enforced by a row-level check AND the TS superRefine); clip platforms add
 * Instagram/TikTok/YouTube Shorts.
 *
 * Lineage: re-rendering a candidate records `regenerated_from_post_id` on
 * the new row (the prior post stays, creator decides what to keep).
 * ═══════════════════════════════════════════════════════════════════════ */

alter table public.social_post drop constraint social_post_platform_check;
alter table public.social_post add constraint social_post_platform_check
  check (platform in ('linkedin','facebook','instagram','tiktok','youtube_shorts'));
-- text posts stay closed at the Phase 1 pair — clips opened the enum.
alter table public.social_post add constraint social_post_text_platform_check
  check (post_type <> 'text' or platform in ('linkedin','facebook'));

alter table public.social_post
  add column clip_job_id uuid references public.clip_render_job(id) on delete set null,
  add column video_path text,
  add column regenerated_from_post_id uuid references public.social_post(id) on delete set null;

create index social_post_clip_job_idx on public.social_post(clip_job_id)
  where clip_job_id is not null;

/* ─────────────── analytics_event: the ingest event ─────────────────────── */

alter table public.analytics_event drop constraint analytics_event_type_check;
alter table public.analytics_event add constraint analytics_event_type_check
  check (type in (
    'page_view','form_submit','free_lesson_capture',
    'email_sent','email_delivered','email_open','email_click',
    'email_bounce','email_unsubscribe','spam_complaint',
    'consent_confirmed','campaign_auto_paused',
    'enrollment',
    'social_post_batch_generated','social_post_created','social_post_updated',
    'social_post_revised_by_agent','social_post_status_changed',
    'social_post_copied','social_post_downloaded',
    'social_post_image_attached','social_post_image_removed',
    'social_post_performance_logged','social_post_generation_failed',
    'social_voice_profile_derived','social_voice_profile_edited',
    'lesson_transcribed','clip_moments_generated','clip_moments_generation_failed',
    'clip_moment_selected','clip_moment_dismissed',
    'clip_job_submitted','clip_job_completed','clip_job_failed',
    'clip_ingested'
  ));
