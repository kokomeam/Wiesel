/* ═══════════════════════════════════════════════════════════════════════════
 * Lesson Clip Repurposing — Milestone M-B: render jobs
 * (PRD §9/§11 + amendment FR-2/FR-5/FR-6 + docs/reap-task0-findings.md)
 *
 * clip_render_job — one render of one candidate. The amendment's layout +
 * provider columns are FOLDED INTO the CREATE (the M-A checkpoint note).
 * Singular table name per repo convention (the documented M-A deviation).
 *
 * State machine (transitions enforced by ONE repository function —
 * lib/marketing/clips/render/jobs.ts `transitionRenderJob`, the single
 * legal write path; the M-F local worker uses the SAME function):
 *   queued → precutting → submitted        → completed | failed   (reap)
 *   queued → precutting → rendering_local  → completed | failed   (in-house)
 *   any non-terminal → cancelled (revert path / creator stop)
 *
 * provider: 'reap' (face_track — provider reframe) · 'wisesel_ffmpeg'
 * (stacked_split / screen_action_zoom / audiogram — in-house, the D-5
 * resolution: Reap's tracker is faces-only and its reframe pan-crops PiP
 * footage) · 'wisesel_slides' (slide_short — the M-F Remotion provider).
 * The amendment's enum named only reap|wisesel_slides; 'wisesel_ffmpeg' is
 * the T0-findings extension (surfaced at the M-B checkpoint).
 *
 * NO delete policy (deliberate): a render job is a COST LEDGER row —
 * cost_minutes must survive any revert. The gate's revert-of-create cancels
 * the job (status='cancelled', provider cancel best-effort) instead of
 * deleting (the social_post archive-not-delete precedent).
 *
 * clip-media bucket: PRIVATE, zero user policies — the render tick writes
 * with the service role; playback goes through author-gated signed URLs.
 * ═══════════════════════════════════════════════════════════════════════ */

create table public.clip_render_job (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references auth.users(id) on delete cascade,
  course_id        uuid references public.courses(id) on delete set null,
  lesson_id        uuid not null references public.lessons(id) on delete cascade,
  candidate_id     uuid not null references public.clip_moment_candidate(id) on delete cascade,
  -- FR-2: the layout DECISION this job renders (copied from the candidate at
  -- submit time — the candidate stays the source of truth for routing).
  layout           text not null
    check (layout in ('face_track','stacked_split','slide_short','screen_action_zoom','audiogram')),
  provider         text not null
    check (provider in ('reap','wisesel_ffmpeg','wisesel_slides')),
  -- Packaging preset id (M-C registry; presets × layouts are orthogonal).
  preset           text not null default 'tofu_hook',
  status           text not null default 'queued'
    check (status in ('queued','precutting','submitted','rendering_local','completed','failed','cancelled')),
  -- The exact span being rendered {videoAssetId, playbackId, startMs, endMs,
  -- recordingFormat} — stamped at creation from the candidate + its lesson's
  -- video asset.
  source           jsonb not null,
  -- Pre-cut bookkeeping {muxAssetId, playbackId, mp4Url, status} — the
  -- TEMPORARY Mux clip asset (deleted after download; see render/precut.ts).
  precut           jsonb,
  provider_ref     text,
  upload_ref       text,
  -- D-3 provenance: how the stacked_split face band was located.
  crop_provenance  text check (crop_provenance in ('deterministic','detected')),
  -- {storagePath, width, height, durationSeconds, sourceUrl?} once completed.
  output           jsonb,
  cost_minutes     numeric,
  error            text,
  attempts         int not null default 0,
  idempotency_key  text,
  -- Stamped at provider submission — the 10/min token bucket counts these.
  submitted_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index clip_render_job_creator_idx   on public.clip_render_job(creator_id, created_at);
create index clip_render_job_candidate_idx on public.clip_render_job(candidate_id);
create index clip_render_job_status_idx    on public.clip_render_job(status)
  where status in ('queued','precutting','submitted','rendering_local');
create unique index clip_render_job_idem_idx on public.clip_render_job(creator_id, idempotency_key)
  where idempotency_key is not null;
create trigger clip_render_job_set_updated_at before update on public.clip_render_job
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.clip_render_job enable row level security;
create policy "clip_render_job_select" on public.clip_render_job
  for select using (creator_id = (select auth.uid()));
create policy "clip_render_job_insert" on public.clip_render_job
  for insert with check (creator_id = (select auth.uid()));
create policy "clip_render_job_update" on public.clip_render_job
  for update using (creator_id = (select auth.uid()));
-- no delete policy — cost-ledger rows survive reverts (cancel, never erase)

/* ───────────────────────── clip-media bucket ──────────────────────────── */

insert into storage.buckets (id, name, public)
values ('clip-media', 'clip-media', false)
on conflict (id) do nothing;
-- Zero user storage policies (deliberate): the render tick writes with the
-- service role; reads go through author-gated signed URLs.

/* ─────────────── analytics_event: 3 new clip-job types ────────────────── */

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
    'clip_job_submitted','clip_job_completed','clip_job_failed'
  ));
