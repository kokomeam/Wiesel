/* ═══════════════════════════════════════════════════════════════════════════
 * Clip text burn (Hook Overlay + Karaoke Caption directive, H-2/H-3)
 *
 * Rendered clips now ship with an IN-HOUSE burned hook overlay + karaoke
 * captions (FFmpeg/libass over the final-resolution video). Two artifacts
 * per clip post:
 *   - video_path        (existing) → the BURNED artifact creators download
 *   - clean_video_path  (new)      → the pre-burn CLEAN MASTER, so hook
 *                                    edits are free local re-burns (no
 *                                    provider job, no clip minutes)
 * Burn provenance + the rotated burn-artifact history live in
 * ai_metadata.textBurn (jsonb — no columns needed).
 *
 * New event: clip_hook_reburned (the H-3 edit path).
 * ═══════════════════════════════════════════════════════════════════════ */

alter table public.social_post add column clean_video_path text;

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
    'clip_ingested',
    'posting_kit_generated','short_link_click',
    'clip_hook_reburned'
  ));
