-- PERF-1 C3 (1/4) — index hygiene (docs/perf/PERF-1_diagnosis.md §A3).
--
-- Three groups, all cheap and behavior-neutral:
--   1. Cover every unindexed FK the Supabase advisors + migration audit
--      flagged. Most matter for ON DELETE cascades/SET NULLs (an unindexed FK
--      turns each parent delete into a child seq scan) — a few are also real
--      app filters (analytics_event.campaign_id, lib/marketing/segments.ts).
--   2. Functional/composite indexes for four measured hot scans:
--      marketplace_listings() live+public ordering, the social queue's
--      primary sort, the revision-budget count before every social AI edit,
--      and the learner-detail heartbeat count (event_type was outside every
--      existing learning_events index).
--   3. Drop the six exact-prefix single-column indexes made redundant by a
--      composite sibling (pure write amplification — the composite serves
--      every query the prefix did).
--
-- The clip/kit/transcript tables ship in the Lesson Clips wave's worktree and
-- exist on the LIVE database but not in this tree's migration set — their
-- indexes are guarded by to_regclass so this file applies cleanly both live
-- (tables present) and on a fresh replay of this tree (tables absent; the
-- clips wave re-runs its own migrations and this file is idempotent to re-run).

-- ───────────────────────── 1. Unindexed FK covers ──────────────────────────

-- Learn / analytics pipeline
create index if not exists learning_events_attempt_id_idx
  on public.learning_events(attempt_id);
create index if not exists homework_submissions_publication_id_idx
  on public.homework_submissions(publication_id);
create index if not exists course_publications_created_by_idx
  on public.course_publications(created_by);
create index if not exists course_reviews_user_id_idx
  on public.course_reviews(user_id);
create index if not exists learner_flags_user_id_idx
  on public.learner_flags(user_id);

-- Rollup tables: PKs start at publication_id/course-agnostic columns, so the
-- courses(id) ON DELETE CASCADE had no child index.
create index if not exists rollup_lesson_funnel_course_id_idx
  on public.rollup_lesson_funnel(course_id);
create index if not exists rollup_question_stats_course_id_idx
  on public.rollup_question_stats(course_id);
create index if not exists rollup_slide_dwell_course_id_idx
  on public.rollup_slide_dwell(course_id);
create index if not exists rollup_video_retention_course_id_idx
  on public.rollup_video_retention(course_id);
create index if not exists rollup_content_feedback_course_id_idx
  on public.rollup_content_feedback(course_id);

-- Maintenance agent + learner comms
create index if not exists agent_findings_change_set_id_idx
  on public.agent_findings(change_set_id);
create index if not exists learner_messages_finding_id_idx
  on public.learner_messages(finding_id);

-- Marketing suite
create index if not exists analytics_event_campaign_id_idx
  on public.analytics_event(campaign_id);
create index if not exists marketing_action_conversation_id_idx
  on public.marketing_action(conversation_id);
create index if not exists marketing_question_campaign_id_idx
  on public.marketing_question(campaign_id);
create index if not exists marketing_question_conversation_id_idx
  on public.marketing_question(conversation_id);
create index if not exists follow_up_rule_email_touch_id_idx
  on public.follow_up_rule(email_touch_id);
create index if not exists marketing_campaign_sender_identity_id_idx
  on public.marketing_campaign(sender_identity_id);
create index if not exists marketing_campaign_lead_list_id_idx
  on public.marketing_campaign(lead_list_id);
create index if not exists marketing_campaign_approved_by_idx
  on public.marketing_campaign(approved_by);

-- Social post generator
create index if not exists social_post_campaign_id_idx
  on public.social_post(campaign_id);
create index if not exists social_post_module_id_idx
  on public.social_post(module_id);
create index if not exists social_post_lesson_id_idx
  on public.social_post(lesson_id);
create index if not exists social_post_batch_course_id_idx
  on public.social_post_batch(course_id);
create index if not exists social_post_batch_module_id_idx
  on public.social_post_batch(module_id);
create index if not exists social_post_batch_lesson_id_idx
  on public.social_post_batch(lesson_id);

-- Lesson Clips wave (tables live-only in this tree — see header).
do $$
begin
  if to_regclass('public.lesson_transcript') is not null then
    create index if not exists lesson_transcript_video_asset_id_idx
      on public.lesson_transcript(video_asset_id);
  end if;
  if to_regclass('public.clip_moment_candidate') is not null then
    create index if not exists clip_moment_candidate_course_id_idx
      on public.clip_moment_candidate(course_id);
  end if;
  if to_regclass('public.clip_render_job') is not null then
    create index if not exists clip_render_job_course_id_idx
      on public.clip_render_job(course_id);
    create index if not exists clip_render_job_lesson_id_idx
      on public.clip_render_job(lesson_id);
  end if;
  if to_regclass('public.posting_kit') is not null then
    create index if not exists posting_kit_course_id_idx
      on public.posting_kit(course_id);
    create index if not exists posting_kit_short_link_id_idx
      on public.posting_kit(short_link_id);
  end if;
  if to_regclass('public.short_link') is not null then
    create index if not exists short_link_course_id_idx
      on public.short_link(course_id);
  end if;
end $$;

-- ──────────────────── 2. Functional / composite indexes ────────────────────

-- marketplace_listings(): the only live+public scan in the system, ordered by
-- published_at desc — previously a seq scan + sort over ALL publications.
create index if not exists course_publications_live_public_idx
  on public.course_publications(published_at desc)
  where status = 'live' and visibility = 'public';

-- Social queue primary sort (listSocialPosts keyset pages on updated_at).
create index if not exists social_post_creator_updated_idx
  on public.social_post(creator_id, updated_at desc)
  where deleted_at is null;

-- countRevisionActionsSince: an exact count over the ever-growing
-- marketing_action ledger filtered by (course, tool, window) before every
-- social AI edit — previously no tool_name/created_at index existed.
create index if not exists marketing_action_course_tool_created_idx
  on public.marketing_action(course_id, tool_name, created_at);

-- Learner-detail heartbeat count filters event_type, which sat outside the
-- (user_id, course_id, server_ts) index — this makes it index-only.
create index if not exists learning_events_user_course_type_idx
  on public.learning_events(user_id, course_id, event_type);

-- ──────────────── 3. Redundant exact-prefix index drops ────────────────────
-- Each is the leading column of a composite sibling that serves every query
-- the single-column index did (verified in §A3):
--   learner_flags_course_idx          ⊂ PK (course_id, user_id, flag_type)
--   subscriber_campaign_id_idx        ⊂ subscriber_status_idx (campaign_id, status)
--   marketing_campaign_course_id_idx  ⊂ marketing_campaign_status_idx (course_id, status)
--   email_sequence_course_id_idx      ⊂ email_sequence_status_idx (course_id, status)
--   change_sets_course_id_idx         ⊂ change_sets_status_idx (course_id, status)
--   marketing_action_course_id_idx    ⊂ marketing_action_status_idx (course_id, status)

drop index if exists public.learner_flags_course_idx;
drop index if exists public.subscriber_campaign_id_idx;
drop index if exists public.marketing_campaign_course_id_idx;
drop index if exists public.email_sequence_course_id_idx;
drop index if exists public.change_sets_course_id_idx;
drop index if exists public.marketing_action_course_id_idx;
