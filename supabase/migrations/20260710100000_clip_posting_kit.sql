/* ═══════════════════════════════════════════════════════════════════════════
 * Lesson Clip Repurposing — Milestone M-D: posting kit + short links
 *
 * short_link — creator-scoped short codes for clip captions/bios:
 *   /l/{code} → 302 to the course destination (the ctaDestination rule:
 *   /learn/{slug} when a live publication exists, /p/{slug} before) with a
 *   ?ref={code} param so enrollment attribution can thread the refCode.
 *   Codes are globally unique, human-typeable (no 0/O/1/l ambiguity).
 *   RLS: creator-scoped CRUD; the PUBLIC redirect route uses the service
 *   role (no anon read policy — code possession is the capability).
 *
 * posting_kit — one kit per social_post (the clip's caption/hashtags/
 *   comment-keyword/disclosure bundle, PRD §10). Kit text is AI-drafted
 *   (small tier) but the DISCLOSURE LINE is code-inserted — never model
 *   output. comment_keyword is unique per creator among ACTIVE kits (the
 *   keyword-uniqueness rule: two live clips must not claim the same DM word).
 * ═══════════════════════════════════════════════════════════════════════ */

create table public.short_link (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references auth.users(id) on delete cascade,
  course_id    uuid references public.courses(id) on delete cascade,
  code         text not null unique,
  destination  text not null,
  clicks       int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index short_link_creator_idx on public.short_link(creator_id);
create trigger short_link_set_updated_at before update on public.short_link
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.short_link enable row level security;
create policy "short_link_select" on public.short_link
  for select using (creator_id = (select auth.uid()));
create policy "short_link_insert" on public.short_link
  for insert with check (creator_id = (select auth.uid()));
create policy "short_link_update" on public.short_link
  for update using (creator_id = (select auth.uid()));
create policy "short_link_delete" on public.short_link
  for delete using (creator_id = (select auth.uid()));

create table public.posting_kit (
  id                uuid primary key default gen_random_uuid(),
  creator_id        uuid not null references auth.users(id) on delete cascade,
  post_id           uuid not null unique references public.social_post(id) on delete cascade,
  course_id         uuid references public.courses(id) on delete set null,
  caption           text not null,
  hashtags          jsonb not null default '[]'::jsonb,
  comment_keyword   text,
  short_link_id     uuid references public.short_link(id) on delete set null,
  -- The code-inserted disclosure (never model output) — stored so the UI
  -- copy button reproduces the exact reviewed text.
  disclosure_line   text not null,
  status            text not null default 'active' check (status in ('active','retired')),
  ai_metadata       jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index posting_kit_creator_idx on public.posting_kit(creator_id);
-- keyword uniqueness among ACTIVE kits per creator (retired kits free theirs)
create unique index posting_kit_keyword_idx
  on public.posting_kit(creator_id, comment_keyword)
  where comment_keyword is not null and status = 'active';
create trigger posting_kit_set_updated_at before update on public.posting_kit
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.posting_kit enable row level security;
create policy "posting_kit_select" on public.posting_kit
  for select using (creator_id = (select auth.uid()));
create policy "posting_kit_insert" on public.posting_kit
  for insert with check (creator_id = (select auth.uid()));
create policy "posting_kit_update" on public.posting_kit
  for update using (creator_id = (select auth.uid()));
create policy "posting_kit_delete" on public.posting_kit
  for delete using (creator_id = (select auth.uid()));

/* ─────────────── analytics_event: kit + link events ─────────────────────── */

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
    'posting_kit_generated','short_link_click'
  ));
