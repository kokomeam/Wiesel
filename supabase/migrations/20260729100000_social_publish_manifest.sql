/* ═══════════════════════════════════════════════════════════════════════════
 * Social publishing M-B — the publish manifest.
 *
 * One row per publish attempt of a social_post to a connected account. The
 * row id IS the provider clientRef (M-B binding decision 2): the manifest is
 * persisted BEFORE the provider publish call, and the provider request ref is
 * persisted as its own durable step IMMEDIATELY after the call returns — the
 * primary crash-recovery handle (history limit=10 is fallback-only).
 *
 * State machine (single write path = transitionPublishManifest in
 * lib/marketing/publish/manifestRepository.ts, optimistic on status+version):
 *   queued → submitting → submitted → (live | verifying → live)
 *   queued|held → cancelled · guard failures → held (self-healing)
 *   platformError on accept → platform_failed · permanent errors → failed
 * live/platform_failed/failed/cancelled are terminal. NO delete policy —
 * cancel, never delete (the clip_render_job audit precedent). Our runtime
 * owns scheduled_for entirely; no provider scheduling parameter exists.
 * ═══════════════════════════════════════════════════════════════════════ */

create table public.social_publish_manifest (
  id                  uuid primary key default gen_random_uuid(),
  creator_id          uuid not null references auth.users(id) on delete cascade,
  social_post_id      uuid not null references public.social_post(id) on delete cascade,
  social_account_id   uuid not null references public.social_account(id) on delete cascade,
  platform            text not null check (platform in ('linkedin','youtube','tiktok','instagram','facebook')),
  status              text not null default 'queued' check (status in
    ('queued','held','submitting','submitted','verifying','live','platform_failed','failed','cancelled')),
  scheduled_for       timestamptz,
  hold_reason         text,
  provider_request_id text,
  platform_post_id    text,
  post_url            text,
  attempt             integer not null default 0,
  last_error          jsonb,
  version             integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index social_publish_manifest_active_idx on public.social_publish_manifest(status, created_at);
create index social_publish_manifest_creator_idx on public.social_publish_manifest(creator_id, created_at);
create index social_publish_manifest_post_idx on public.social_publish_manifest(social_post_id);

alter table public.social_publish_manifest enable row level security;

create policy "social_publish_manifest_select" on public.social_publish_manifest for select using (creator_id = (select auth.uid()));
create policy "social_publish_manifest_insert" on public.social_publish_manifest for insert with check (creator_id = (select auth.uid()));
create policy "social_publish_manifest_update" on public.social_publish_manifest for update using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
-- No delete policy: cancel, never delete — the manifest is the publish audit
-- trail (the clip_render_job precedent).
