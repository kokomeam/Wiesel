/* ═══════════════════════════════════════════════════════════════════════════
 * Social publishing foundation (M-A) — connected accounts data layer.
 *
 * CREATOR-scoped (the voice_profile / social_voice_profile RLS shape):
 *   - social_provider_profile : 1 row per creator per provider — the minted
 *     provider-side profile username, AES-256-GCM ENCRYPTED at rest
 *     (profile_ref_enc; decrypted only inside the server adapter path).
 *   - social_account          : per-platform connected account + health
 *     (linked | expired | revoked). All content writes go through the
 *     versioned repository function (version optimistic-lock — the
 *     social_post precedent); grep-enforced.
 *   - social_publish_ledger   : one row per provider-ACCEPTED upload. The
 *     provider has NO quota-read endpoint (Task 0a) — monthly usage is
 *     self-tracked by counting this ledger (the clip_render_job precedent).
 *     M-A ships the table + counting; M-B writes rows at publish time.
 *
 * Events: +3 on the single analytics_event stream (snake_case per repo
 * convention): social_account_linked / social_account_expired /
 * social_account_revoked. TS union in lib/marketing/types.ts extended
 * TOGETHER with this migration (consequential-updates rule; drift-guarded in
 * verify-accounts.ts).
 * ═══════════════════════════════════════════════════════════════════════ */

create table public.social_provider_profile (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references auth.users(id) on delete cascade,
  provider        text not null default 'upload_post',
  profile_ref_enc text not null,
  version         integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (creator_id, provider)
);

create table public.social_account (
  id             uuid primary key default gen_random_uuid(),
  creator_id     uuid not null references auth.users(id) on delete cascade,
  provider       text not null default 'upload_post',
  platform       text not null check (platform in ('linkedin','youtube','tiktok','instagram','facebook')),
  status         text not null default 'linked' check (status in ('linked','expired','revoked')),
  display_name   text,
  handle         text,
  avatar_url     text,
  last_synced_at timestamptz,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (creator_id, provider, platform)
);

create index social_account_creator_idx on public.social_account(creator_id, status);

create table public.social_publish_ledger (
  id                  uuid primary key default gen_random_uuid(),
  creator_id          uuid not null references auth.users(id) on delete cascade,
  social_account_id   uuid not null references public.social_account(id) on delete cascade,
  platform            text not null check (platform in ('linkedin','youtube','tiktok','instagram','facebook')),
  client_ref          text not null,
  provider_request_id text,
  created_at          timestamptz not null default now()
);

create index social_publish_ledger_account_idx on public.social_publish_ledger(social_account_id, created_at);
create index social_publish_ledger_creator_idx on public.social_publish_ledger(creator_id, created_at);

alter table public.social_provider_profile enable row level security;
alter table public.social_account enable row level security;
alter table public.social_publish_ledger enable row level security;

create policy "social_provider_profile_select" on public.social_provider_profile for select using (creator_id = (select auth.uid()));
create policy "social_provider_profile_insert" on public.social_provider_profile for insert with check (creator_id = (select auth.uid()));
create policy "social_provider_profile_update" on public.social_provider_profile for update using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
create policy "social_provider_profile_delete" on public.social_provider_profile for delete using (creator_id = (select auth.uid()));

create policy "social_account_select" on public.social_account for select using (creator_id = (select auth.uid()));
create policy "social_account_insert" on public.social_account for insert with check (creator_id = (select auth.uid()));
create policy "social_account_update" on public.social_account for update using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
create policy "social_account_delete" on public.social_account for delete using (creator_id = (select auth.uid()));

create policy "social_publish_ledger_select" on public.social_publish_ledger for select using (creator_id = (select auth.uid()));
create policy "social_publish_ledger_insert" on public.social_publish_ledger for insert with check (creator_id = (select auth.uid()));
-- No update/delete policies on the ledger: spend can't be unspent (the
-- clip_render_job cost-ledger precedent).

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
    'social_account_linked','social_account_expired','social_account_revoked'
  ));
