/* ═══════════════════════════════════════════════════════════════════════════
 * Lesson Clip Repurposing — Marketing Phase 1.5, Milestone M-A
 * (PRD §12.1-12.2, §12.5 M-A slice · guide: docs/clips.md)
 *
 * Two tables (repo convention: singular names, moddatetime triggers,
 * creator-scoped RLS):
 *   lesson_transcript      — word-timestamped transcript cache, ONE row per
 *                            lesson (source: platform Mux captions | provider)
 *   clip_moment_candidate  — ranked teachable-moment candidates from one
 *                            selection run; request_id groups the run's SET
 *                            (the gate's composite revert unit — the
 *                            social_post_batch precedent)
 *
 * Plus 5 clip event types on the SINGLE analytics_event stream (snake_case
 * per repo convention — the PRD's dotted names are a documented deviation).
 * Later milestones add their own tables/events: clip_render_job + webhook
 * ingest (M-B, gated on Task 0), social_post clip columns + platform
 * extension (M-C), short_link + posting kit + preview access (M-D).
 *
 * DELETE policies (deliberate): clip_moment_candidate HAS one — the gate's
 * revert-of-create must remove the created set (the social_voice_profile
 * precedent). lesson_transcript has NONE — it's a regenerated cache, never a
 * gate target; re-transcription upserts over it.
 * ═══════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── lesson_transcript ──────────────────────────── */

create table public.lesson_transcript (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references auth.users(id) on delete cascade,
  -- course_id survives course archival semantics like other marketing tables;
  -- the lesson FK cascades (a transcript without its lesson is garbage).
  course_id        uuid references public.courses(id) on delete set null,
  lesson_id        uuid not null unique references public.lessons(id) on delete cascade,
  source           text not null check (source in ('platform','provider')),
  language         text not null default 'en',
  duration_seconds numeric not null,
  -- [{w, startMs, endMs, speaker}] — word-level; platform (Mux cue-level)
  -- timings are interpolated inside each cue (see lib/marketing/clips/transcripts.ts).
  words            jsonb not null,
  text             text not null,
  provider_ref     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index lesson_transcript_creator_idx on public.lesson_transcript(creator_id);
create index lesson_transcript_course_idx  on public.lesson_transcript(course_id);
create trigger lesson_transcript_set_updated_at before update on public.lesson_transcript
  for each row execute procedure extensions.moddatetime(updated_at);

/* ─────────────────────── clip_moment_candidate ────────────────────────── */

create table public.clip_moment_candidate (
  id                  uuid primary key default gen_random_uuid(),
  creator_id          uuid not null references auth.users(id) on delete cascade,
  course_id           uuid references public.courses(id) on delete set null,
  lesson_id           uuid not null references public.lessons(id) on delete cascade,
  transcript_id       uuid not null references public.lesson_transcript(id) on delete cascade,
  -- Groups one selection run's candidate SET — the gate's revert unit.
  request_id          uuid not null,
  rank                int  not null check (rank between 1 and 5),
  start_ms            int  not null check (start_ms >= 0),
  end_ms              int  not null check (end_ms > start_ms),
  -- Multi-segment exception ONLY (PRD §7.3): [{startMs,endMs}...] + script.
  segments            jsonb,
  stitched_script     text,
  moment_type         text not null check (moment_type in
    ('misconception_buster','counterintuitive_reveal','concrete_win','mistake_autopsy',
     'before_after','demo_payoff','story_beat','definition_reframe')),
  hook_text           text not null,
  alt_hooks           jsonb not null default '[]'::jsonb,
  funnel_stage        text not null check (funnel_stage in ('tofu','mofu','bofu')),
  target_platform_fit jsonb not null default '[]'::jsonb,
  rubric_scores       jsonb not null,
  rationale           text not null,
  caption_draft       text,
  end_card_cta        text,
  status              text not null default 'candidate'
    check (status in ('candidate','selected','dismissed')),
  -- CLIP_PROMPT_VERSION at generation time (§8: prompts are versioned artifacts).
  prompt_version      text not null,
  -- model, promptVersion, voiceProfileVersion, mapReduceUsed, repairUsed, latencyMs
  ai_metadata         jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index clip_moment_candidate_creator_idx  on public.clip_moment_candidate(creator_id, created_at);
create index clip_moment_candidate_lesson_idx   on public.clip_moment_candidate(lesson_id, status);
create index clip_moment_candidate_request_idx  on public.clip_moment_candidate(request_id);
create index clip_moment_candidate_transcript_idx on public.clip_moment_candidate(transcript_id);
create trigger clip_moment_candidate_set_updated_at before update on public.clip_moment_candidate
  for each row execute procedure extensions.moddatetime(updated_at);

/* ─────────────────────────────────── RLS ──────────────────────────────── */

alter table public.lesson_transcript      enable row level security;
alter table public.clip_moment_candidate  enable row level security;

create policy "lesson_transcript_select" on public.lesson_transcript
  for select using (creator_id = (select auth.uid()));
create policy "lesson_transcript_insert" on public.lesson_transcript
  for insert with check (creator_id = (select auth.uid()));
create policy "lesson_transcript_update" on public.lesson_transcript
  for update using (creator_id = (select auth.uid()));

create policy "clip_moment_candidate_select" on public.clip_moment_candidate
  for select using (creator_id = (select auth.uid()));
create policy "clip_moment_candidate_insert" on public.clip_moment_candidate
  for insert with check (creator_id = (select auth.uid()));
create policy "clip_moment_candidate_update" on public.clip_moment_candidate
  for update using (creator_id = (select auth.uid()));
-- Revert-of-create needs delete (gate snapshotter) — creator-scoped.
create policy "clip_moment_candidate_delete" on public.clip_moment_candidate
  for delete using (creator_id = (select auth.uid()));

/* ───────────────── analytics_event: 5 new clip types ────────────────────
 * Same SINGLE stream. TS union (lib/marketing/types.ts AnalyticsEventType)
 * and this check extend TOGETHER (the consequential-updates rule);
 * verify-clips.ts regex-asserts this migration carries every TS value. */

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
    'clip_moment_selected','clip_moment_dismissed'
  ));
