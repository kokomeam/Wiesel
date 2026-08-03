/* ═══════════════════════════════════════════════════════════════════════════
 * M-C — approval governance: the preview-then-decide card is the SOLE path
 * to publishing (docs/social-accounts.md § Publish governance).
 *
 *  - social_publish_approval: one row per card request. The single-use token
 *    is stored HASHED (sha256); minted at card render, expires ~15 min,
 *    consumed exactly once on approve. kind='retry' rows are SYSTEM children
 *    of a human card approval (parent_approval_id) — transient-failure retry
 *    never demands a fresh card, but the audit chain always reaches one.
 *  - social_publish_manifest gains content_hash (approval-staleness abort:
 *    hash of body+cta+hashtags+first_comment+media, re-checked pre-submit),
 *    approval_id (NOT NULL + UNIQUE — one approval → one manifest: token
 *    replay is structurally impossible at the DB layer), approved_via
 *    (always 'card'), and the 'voided' terminal status. A BEFORE UPDATE
 *    trigger makes voided immutable (the publications precedent) — a voided
 *    manifest can NEVER be published, even by a buggy writer.
 *  - social_post gains first_comment (content, hash-covered) and the
 *    posted_api / unpublished_local statuses — posted_api is deliberately
 *    DISTINCT from posted_manual (checkpoint amendment 3).
 * ═══════════════════════════════════════════════════════════════════════ */

create table public.social_publish_approval (
  id                  uuid primary key default gen_random_uuid(),
  creator_id          uuid not null references auth.users(id) on delete cascade,
  social_post_id      uuid not null references public.social_post(id) on delete cascade,
  social_account_id   uuid not null references public.social_account(id) on delete cascade,
  platform            text not null check (platform in ('linkedin','youtube','tiktok','instagram','facebook')),
  kind                text not null default 'card' check (kind in ('card','retry')),
  requested_by        text not null default 'creator' check (requested_by in ('creator','agent')),
  proposed_scheduled_for timestamptz,
  content_hash        text not null,
  token_hash          text,
  minted_at           timestamptz,
  expires_at          timestamptz,
  consumed_at         timestamptz,
  declined_at         timestamptz,
  voided_at           timestamptz,
  parent_approval_id  uuid references public.social_publish_approval(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index social_publish_approval_creator_idx on public.social_publish_approval(creator_id, created_at);
create index social_publish_approval_post_idx on public.social_publish_approval(social_post_id);
create unique index social_publish_approval_token_idx on public.social_publish_approval(token_hash) where token_hash is not null;

alter table public.social_publish_approval enable row level security;
create policy "social_publish_approval_select" on public.social_publish_approval for select using (creator_id = (select auth.uid()));
create policy "social_publish_approval_insert" on public.social_publish_approval for insert with check (creator_id = (select auth.uid()));
create policy "social_publish_approval_update" on public.social_publish_approval for update using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
-- No delete policy: approvals are the governance audit trail.

alter table public.social_publish_manifest
  add column content_hash text not null default '',
  add column approval_id uuid references public.social_publish_approval(id),
  add column approved_via text not null default 'card' check (approved_via in ('card'));
-- The live table is empty (verified pre-migration); enforce NOT NULL +
-- UNIQUE on approval_id from day one.
alter table public.social_publish_manifest alter column approval_id set not null;
alter table public.social_publish_manifest alter column content_hash drop default;
create unique index social_publish_manifest_approval_idx on public.social_publish_manifest(approval_id);

alter table public.social_publish_manifest drop constraint social_publish_manifest_status_check;
alter table public.social_publish_manifest add constraint social_publish_manifest_status_check
  check (status in ('queued','held','submitting','submitted','verifying','live','platform_failed','failed','cancelled','voided'));

create or replace function private.social_publish_manifest_guard_voided()
returns trigger language plpgsql as $$
begin
  if old.status = 'voided' and new.status is distinct from 'voided' then
    raise exception 'voided publish manifests are immutable';
  end if;
  return new;
end $$;
create trigger social_publish_manifest_voided_guard
  before update on public.social_publish_manifest
  for each row execute function private.social_publish_manifest_guard_voided();

alter table public.social_post add column first_comment text;
alter table public.social_post drop constraint social_post_status_check;
alter table public.social_post add constraint social_post_status_check
  check (status in ('draft','ready','planned','posted_manual','archived','posted_api','unpublished_local'));

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
    'clip_hook_reburned',
    'social_account_linked','social_account_expired','social_account_revoked',
    'social_publish_card_approved','social_publish_card_rejected',
    'social_publish_approval_voided',
    'social_post_published_api','social_post_unpublished_local'
  ));
