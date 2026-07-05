-- WiseSel — Autonomous Email Marketing Agent (campaign layer on the Marketing
-- Assistant foundation). Extends marketing_campaign/email_touch/scheduled_send/
-- subscriber/analytics_event and adds five new author-scoped tables:
--   lead_list / lead_list_member  — named, consent-gated audiences
--   sender_identity                — from/reply-to + mailing address (footer law)
--   follow_up_rule                 — approved behavioral follow-up rules
--   voice_profile                  — creator-level (not course-level) style rules
--
-- Every new table follows the existing convention: uuid PKs, moddatetime
-- triggers, jsonb for variable-shape data, RLS via private.is_course_author
-- (course-scoped) or author_id = auth.uid() (creator-scoped, mirrors
-- audience_contact / voice_profile). No table is public-read.
--
-- Nothing here touches the governance gate, the tool seam, or the event stream
-- as MECHANISMS — it gives them more to grade, more to read, and more to write
-- through the SAME `marketing_action` ledger and the SAME `analytics_event`
-- table (new type values only; no second stream).

create extension if not exists moddatetime schema extensions;

/* ─────────────────── marketing_campaign — full lifecycle ────────────────── */
-- Old: draft | active | paused | archived. New superset supports the campaign
-- state machine from Draft through Completed/Cancelled/Failed. `archived` rows
-- map to `completed` (they were terminal, non-error, out-of-play).
alter table public.marketing_campaign drop constraint marketing_campaign_status_check;
update public.marketing_campaign set status = 'completed' where status = 'archived';
alter table public.marketing_campaign add constraint marketing_campaign_status_check
  check (status in (
    'draft','generated','in_review','approved','scheduled',
    'sending','active','paused','completed','cancelled','failed'
  ));

alter table public.marketing_campaign
  add column compliance_status text not null default 'not_reviewed'
    check (compliance_status in ('not_reviewed','passed','warnings','blocked')),
  add column compliance_report jsonb not null default '{}'::jsonb,
  add column approved_at timestamptz,
  add column approved_by uuid references auth.users(id) on delete set null,
  add column sender_identity_id uuid,
  add column lead_list_id uuid;
-- config jsonb carries: goal, blueprintKey, brief {audienceNotes, proofPoints,
-- offerDetails, thingsToAvoid, freeform, language}, sendWindow {startHour,
-- endHour, timezone, skipWeekends}, approvedAudienceIds (snapshotted at
-- launch), autoPauseReason. No new columns for these — matches the existing
-- "variable shape → jsonb" convention already used for this exact column.

/* ────────────────────────────── email_touch ──────────────────────────────
 * Per-step fields the PRD's EmailStep needs, plus per-step approval + the
 * rubric's advisory quality score (never blocking). */
alter table public.email_touch
  add column stage_name text,
  add column purpose text,
  add column ai_rationale text,
  add column personalization_variables jsonb not null default '[]'::jsonb,
  add column approval_status text not null default 'draft'
    check (approval_status in ('draft','pending_review','approved')),
  add column compliance_warnings jsonb not null default '[]'::jsonb,
  add column quality_score jsonb;

/* ─────────────────────────── scheduled_send ──────────────────────────────
 * Soft-bounce retry counters (Amendment 8) + the click-attribution dimension
 * already implicit via touch_id/subscriber_id — no new column needed there. */
alter table public.scheduled_send
  add column bounce_type text check (bounce_type in ('hard','soft')),
  add column soft_bounce_count integer not null default 0;

/* ──────────────────────────────  subscriber  ─────────────────────────────
 * Explicit consent state machine (Amendment 7: pending → confirmed | lapsed).
 * Ingest-form leads are 'confirmed' at capture (the on-page consent line IS
 * the confirmation); manual imports land 'pending' until double-opt-in. */
alter table public.subscriber
  add column consent_status text not null default 'confirmed'
    check (consent_status in ('confirmed','pending','lapsed')),
  add column consent_requested_at timestamptz;

/* ─────────────────────────── analytics_event ─────────────────────────────
 * New event types: email_delivered (provider ack distinct from accepted-send),
 * spam_complaint (guardrail input), consent_confirmed (double opt-in),
 * campaign_auto_paused (guardrail trip). Same single stream — no new table. */
alter table public.analytics_event drop constraint analytics_event_type_check;
alter table public.analytics_event add constraint analytics_event_type_check
  check (type in (
    'page_view','form_submit','free_lesson_capture',
    'email_sent','email_delivered','email_open','email_click',
    'email_bounce','email_unsubscribe','spam_complaint',
    'consent_confirmed','campaign_auto_paused',
    'enrollment'
  ));

/* ──────────────────────────────  lead_list  ───────────────────────────────
 * A named, consent-gated grouping of subscribers. Totals/eligible counts are
 * ALWAYS computed at read time (query subscriber status), never cached here —
 * consistent with "one event stream, no parallel counters that can drift". */
create table public.lead_list (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.courses(id) on delete cascade,
  campaign_id       uuid references public.marketing_campaign(id) on delete set null,
  name              text not null,
  source_type       text not null default 'manual_import'
    check (source_type in ('manual_import','course_interest_signup','previous_students','custom')),
  consent_confirmed boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index lead_list_course_id_idx on public.lead_list(course_id);
create index lead_list_campaign_id_idx on public.lead_list(campaign_id);
create trigger lead_list_set_updated_at before update on public.lead_list
  for each row execute procedure extensions.moddatetime(updated_at);

create table public.lead_list_member (
  list_id       uuid not null references public.lead_list(id) on delete cascade,
  subscriber_id uuid not null references public.subscriber(id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (list_id, subscriber_id)
);
create index lead_list_member_subscriber_id_idx on public.lead_list_member(subscriber_id);

/* ───────────────────────────  sender_identity  ────────────────────────────
 * MVP = one platform-verified sender per course; mailing_address is REQUIRED
 * (the compliance footer needs it and the platform can't supply a creator's
 * address). Per-creator verified domains are the existing later seam. */
create table public.sender_identity (
  id             uuid primary key default gen_random_uuid(),
  course_id      uuid not null references public.courses(id) on delete cascade,
  from_name      text not null,
  from_email     text not null,
  reply_to       text,
  mailing_address text not null,
  business_name  text,
  verified       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index sender_identity_course_id_idx on public.sender_identity(course_id);
create trigger sender_identity_set_updated_at before update on public.sender_identity
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.marketing_campaign
  add constraint marketing_campaign_sender_identity_fkey
    foreign key (sender_identity_id) references public.sender_identity(id) on delete set null,
  add constraint marketing_campaign_lead_list_fkey
    foreign key (lead_list_id) references public.lead_list(id) on delete set null;

/* ───────────────────────────  follow_up_rule  ─────────────────────────────
 * First-class approved follow-up rules (Amendment: click-first defaults —
 * `after_previous_email` / `clicked_not_enrolled` favored; open-based triggers
 * remain available but the UI/agent caveat them). */
create table public.follow_up_rule (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.marketing_campaign(id) on delete cascade,
  course_id      uuid not null references public.courses(id) on delete cascade,
  name           text not null,
  trigger        text not null check (trigger in (
    'after_previous_email','opened_not_clicked','clicked_not_enrolled',
    'not_opened','not_enrolled'
  )),
  delay_days     integer not null default 2,
  email_touch_id uuid references public.email_touch(id) on delete set null,
  status         text not null default 'draft'
    check (status in ('draft','approved','active','paused')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index follow_up_rule_campaign_id_idx on public.follow_up_rule(campaign_id);
create index follow_up_rule_course_id_idx on public.follow_up_rule(course_id);
create trigger follow_up_rule_set_updated_at before update on public.follow_up_rule
  for each row execute procedure extensions.moddatetime(updated_at);

/* ───────────────────────────── voice_profile ──────────────────────────────
 * CREATOR-scoped (not course-scoped) — one durable style profile that every
 * course's copy generation reads. Mirrors audience_contact's RLS shape. */
create table public.voice_profile (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null references auth.users(id) on delete cascade,
  rules      jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_id)
);
create trigger voice_profile_set_updated_at before update on public.voice_profile
  for each row execute procedure extensions.moddatetime(updated_at);

/* ──────────────────────────────────  RLS  ─────────────────────────────────
 * lead_list / sender_identity / follow_up_rule: author-only via course_id,
 * same split-per-action pattern as every other course-scoped marketing table.
 * lead_list_member: no course_id of its own — gated through its list_id.
 * voice_profile: author-only via author_id = auth.uid(), like audience_contact. */
alter table public.lead_list        enable row level security;
alter table public.lead_list_member enable row level security;
alter table public.sender_identity  enable row level security;
alter table public.follow_up_rule   enable row level security;
alter table public.voice_profile    enable row level security;

create policy "lead_list_select" on public.lead_list for select using (private.is_course_author(course_id));
create policy "lead_list_insert" on public.lead_list for insert with check (private.is_course_author(course_id));
create policy "lead_list_update" on public.lead_list for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "lead_list_delete" on public.lead_list for delete using (private.is_course_author(course_id));

create policy "lead_list_member_select" on public.lead_list_member for select
  using (exists (select 1 from public.lead_list l where l.id = list_id and private.is_course_author(l.course_id)));
create policy "lead_list_member_insert" on public.lead_list_member for insert
  with check (exists (select 1 from public.lead_list l where l.id = list_id and private.is_course_author(l.course_id)));
create policy "lead_list_member_delete" on public.lead_list_member for delete
  using (exists (select 1 from public.lead_list l where l.id = list_id and private.is_course_author(l.course_id)));

create policy "sender_identity_select" on public.sender_identity for select using (private.is_course_author(course_id));
create policy "sender_identity_insert" on public.sender_identity for insert with check (private.is_course_author(course_id));
create policy "sender_identity_update" on public.sender_identity for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "sender_identity_delete" on public.sender_identity for delete using (private.is_course_author(course_id));

create policy "follow_up_rule_select" on public.follow_up_rule for select using (private.is_course_author(course_id));
create policy "follow_up_rule_insert" on public.follow_up_rule for insert with check (private.is_course_author(course_id));
create policy "follow_up_rule_update" on public.follow_up_rule for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "follow_up_rule_delete" on public.follow_up_rule for delete using (private.is_course_author(course_id));

create policy "voice_profile_select" on public.voice_profile for select using (author_id = (select auth.uid()));
create policy "voice_profile_insert" on public.voice_profile for insert with check (author_id = (select auth.uid()));
create policy "voice_profile_update" on public.voice_profile for update using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "voice_profile_delete" on public.voice_profile for delete using (author_id = (select auth.uid()));
