/* ═══════════════════════════════════════════════════════════════════════════
 * Social Media Post Generator — Marketing Phase 1 (PRD: docs/prd/
 * Social-Media-Post-Generator-Marketing-Web.html · guide: docs/social-posts.md)
 *
 * Three tables (repo convention: singular names, moddatetime triggers,
 * creator-scoped RLS):
 *   social_post_batch    — first-class batch row (grouping, retry, audit,
 *                          idempotency, per-day rate-limit counting)
 *   social_post          — the post; versioned optimistic-concurrency writes;
 *                          SOFT delete only (deleted_at) — no delete policy
 *   social_voice_profile — derived, versioned per-creator style profile
 *                          (DISTINCT from the email suite's `voice_profile`
 *                          rules table — different lifecycle: derived +
 *                          regenerable vs. creator-authored rules)
 *
 * Plus: the transactional `social_create_batch` function (all posts commit or
 * none; idempotency replay), the private `social-post-images` storage bucket,
 * and 13 new event types on the SINGLE analytics_event stream.
 *
 * Forward-compat fields ([FWD] in the PRD) are present but unused by Phase 1
 * UI: post_type ('clip'/'carousel' in 1.5), external_ref (Phase 3 publish
 * state), performance.source='api' (Phase 4). plannedPostAt is a PLANNING
 * LABEL — nothing in this schema or any code fires from it.
 * ═══════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────── social_post_batch ────────────────────────── */

create table public.social_post_batch (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references auth.users(id) on delete cascade,
  -- Content refs are nullable + set-null so an archived/deleted course never
  -- cascade-destroys marketing history (PRD §12.1).
  course_id       uuid references public.courses(id) on delete set null,
  module_id       uuid references public.modules(id) on delete set null,
  lesson_id       uuid references public.lessons(id) on delete set null,
  source_type     text not null check (source_type in ('course','module','lesson','manual')),
  source_text     text,
  -- Platform enum deliberately closed at 2 (LinkedIn, Facebook) for MVP —
  -- Instagram returns when image/video generation ships (Phase 1.5+).
  platform        text not null check (platform in ('linkedin','facebook')),
  requested_count int  not null check (requested_count between 1 and 5),
  funnel_mix      text not null default 'pinned' check (funnel_mix in ('balanced','pinned')),
  timing_preset   text not null default 'none'
    check (timing_preset in ('none','same_day','spread_week','spread_2_weeks','custom')),
  -- POST /generate Idempotency-Key: a replay returns the original batch.
  idempotency_key text,
  -- model, promptVersion, tokens, latencyMs, repairUsed, droppedByLint
  ai_metadata     jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index social_post_batch_creator_created_idx
  on public.social_post_batch(creator_id, created_at);
create unique index social_post_batch_idempotency_idx
  on public.social_post_batch(creator_id, idempotency_key)
  where idempotency_key is not null;

/* ────────────────────────────── social_post ───────────────────────────── */

create table public.social_post (
  id                  uuid primary key default gen_random_uuid(),
  creator_id          uuid not null references auth.users(id) on delete cascade,
  course_id           uuid references public.courses(id) on delete set null,
  module_id           uuid references public.modules(id) on delete set null,
  lesson_id           uuid references public.lessons(id) on delete set null,
  campaign_id         uuid references public.marketing_campaign(id) on delete set null,
  batch_id            uuid references public.social_post_batch(id) on delete set null,
  batch_order         int check (batch_order between 1 and 5),
  source_type         text not null check (source_type in ('course','module','lesson','manual')),
  source_text         text,
  platform            text not null check (platform in ('linkedin','facebook')),
  post_type           text not null default 'text',  -- [FWD] 'clip','carousel' in Phase 1.5
  goal                text not null check (goal in
    ('launch','value','benefit','problem_solution','pain_point','promo_cta')),
  funnel_stage        text not null check (funnel_stage in ('tofu','mofu','bofu')),
  audience            text,
  tone                text not null check (tone in
    ('professional','friendly','founder_led','educational','casual')),
  body                text not null,
  cta                 text,
  hashtags            text[] not null default '{}',
  image_url           text,
  image_storage_path  text,
  image_alt_text      text,
  suggested_image_idea text,
  -- A planning label ONLY. No job, timer, or notification reads it in Phase 1;
  -- the Phase 3 scheduler will read this same column — do not rename.
  planned_post_at     timestamptz,
  status              text not null default 'draft'
    check (status in ('draft','ready','planned','posted_manual','archived')),
  posted_manually_at  timestamptz,
  performance         jsonb,          -- PostPerformanceSchema (§12.3)
  external_ref        jsonb,          -- [FWD] Phase 3: unified-API id, publish state
  version             int  not null default 1,
  -- model, promptVersion, parentPostId, variantOf, voiceProfileVersion, image dims
  ai_metadata         jsonb not null default '{}'::jsonb,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index social_post_creator_status_idx
  on public.social_post(creator_id, status) where deleted_at is null;
create index social_post_creator_planned_idx
  on public.social_post(creator_id, planned_post_at) where deleted_at is null;
create index social_post_batch_id_idx on public.social_post(batch_id);
create index social_post_course_id_idx on public.social_post(course_id);
create trigger social_post_set_updated_at before update on public.social_post
  for each row execute procedure extensions.moddatetime(updated_at);

/* NOTE on the versioned-update rule: the ONLY legal content update is
 *   update social_post set ..., version = version + 1
 *     where id = $1 and version = $2 and deleted_at is null returning *;
 * funneled through ONE repository function
 * (lib/marketing/social/repository.ts · versionedUpdateSocialPost). It is
 * deliberately NOT enforced by a trigger: the governance gate's revert path
 * restores a before-snapshot verbatim (including its version), which a
 * monotonic-version trigger would forbid. verify-social.ts greps for stray
 * `.from("social_post")…update` call sites instead. */

/* ─────────────────────────── social_voice_profile ─────────────────────── */

create table public.social_voice_profile (
  id          uuid primary key default gen_random_uuid(),
  creator_id  uuid not null unique references auth.users(id) on delete cascade,
  -- summary, register, sentenceLength, emojiTolerance, signatureMoves[],
  -- bannedPhrases[], sampleExcerpts[] (SocialVoiceProfileSchema)
  profile     jsonb not null,
  source      text not null default 'derived' check (source in ('derived','creator_edited')),
  version     int  not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger social_voice_profile_set_updated_at before update on public.social_voice_profile
  for each row execute procedure extensions.moddatetime(updated_at);

/* ─────────────────────────────────── RLS ───────────────────────────────
 * Creator-scoped: select/insert/update where creator_id = auth.uid().
 * NO delete policy on any table — deletion is the soft `deleted_at` flag
 * (hard purge is a later-phase retention job). The int suite asserts a raw
 * DELETE is refused for the owner too. */

alter table public.social_post_batch    enable row level security;
alter table public.social_post          enable row level security;
alter table public.social_voice_profile enable row level security;

create policy "social_post_batch_select" on public.social_post_batch
  for select using (creator_id = (select auth.uid()));
create policy "social_post_batch_insert" on public.social_post_batch
  for insert with check (creator_id = (select auth.uid()));
create policy "social_post_batch_update" on public.social_post_batch
  for update using (creator_id = (select auth.uid()));

create policy "social_post_select" on public.social_post
  for select using (creator_id = (select auth.uid()));
create policy "social_post_insert" on public.social_post
  for insert with check (creator_id = (select auth.uid()));
create policy "social_post_update" on public.social_post
  for update using (creator_id = (select auth.uid()));

create policy "social_voice_profile_select" on public.social_voice_profile
  for select using (creator_id = (select auth.uid()));
create policy "social_voice_profile_insert" on public.social_voice_profile
  for insert with check (creator_id = (select auth.uid()));
create policy "social_voice_profile_update" on public.social_voice_profile
  for update using (creator_id = (select auth.uid()));

/* ───────────────────── transactional batch persist ─────────────────────
 * All posts commit or none (PRD §8: batch persistence is transactional).
 * SECURITY INVOKER on purpose: every insert passes the RLS policies above —
 * the function adds atomicity + idempotency, never privilege. creator_id is
 * pinned to auth.uid() regardless of payload. A concurrent duplicate
 * Idempotency-Key loses the unique-index race and returns the winner's batch. */

create or replace function public.social_create_batch(p_batch jsonb, p_posts jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_creator uuid := auth.uid();
  v_key text := nullif(p_batch->>'idempotency_key', '');
  v_existing_id uuid;
  v_batch_id uuid;
  v_post jsonb;
  v_order int := 0;
  v_post_ids uuid[] := '{}';
  v_id uuid;
begin
  if v_creator is null then
    raise exception 'social_create_batch: not authenticated';
  end if;
  if p_posts is null or jsonb_typeof(p_posts) <> 'array'
     or jsonb_array_length(p_posts) < 1 or jsonb_array_length(p_posts) > 5 then
    raise exception 'social_create_batch: batch must contain 1-5 posts';
  end if;

  if v_key is not null then
    select id into v_existing_id from public.social_post_batch
      where creator_id = v_creator and idempotency_key = v_key;
    if found then
      return jsonb_build_object('batch_id', v_existing_id, 'replayed', true);
    end if;
  end if;

  begin
    insert into public.social_post_batch
      (creator_id, course_id, module_id, lesson_id, source_type, source_text,
       platform, requested_count, funnel_mix, timing_preset, idempotency_key, ai_metadata)
    values
      (v_creator,
       nullif(p_batch->>'course_id','')::uuid,
       nullif(p_batch->>'module_id','')::uuid,
       nullif(p_batch->>'lesson_id','')::uuid,
       p_batch->>'source_type',
       p_batch->>'source_text',
       p_batch->>'platform',
       (p_batch->>'requested_count')::int,
       coalesce(p_batch->>'funnel_mix','pinned'),
       coalesce(p_batch->>'timing_preset','none'),
       v_key,
       coalesce(p_batch->'ai_metadata','{}'::jsonb))
    returning id into v_batch_id;
  exception when unique_violation then
    -- Lost the idempotency race — return the winner's batch, insert nothing.
    select id into v_existing_id from public.social_post_batch
      where creator_id = v_creator and idempotency_key = v_key;
    return jsonb_build_object('batch_id', v_existing_id, 'replayed', true);
  end;

  for v_post in select * from jsonb_array_elements(p_posts) loop
    v_order := v_order + 1;
    insert into public.social_post
      (creator_id, course_id, module_id, lesson_id, batch_id, batch_order,
       source_type, source_text, platform, goal, funnel_stage, audience, tone,
       body, cta, hashtags, suggested_image_idea, planned_post_at, ai_metadata)
    values
      (v_creator,
       nullif(p_batch->>'course_id','')::uuid,
       nullif(p_batch->>'module_id','')::uuid,
       nullif(p_batch->>'lesson_id','')::uuid,
       v_batch_id,
       v_order,
       p_batch->>'source_type',
       p_batch->>'source_text',
       p_batch->>'platform',
       v_post->>'goal',
       v_post->>'funnel_stage',
       nullif(v_post->>'audience',''),
       v_post->>'tone',
       v_post->>'body',
       nullif(v_post->>'cta',''),
       coalesce(
         (select array_agg(x) from jsonb_array_elements_text(v_post->'hashtags') as t(x)),
         '{}'::text[]),
       nullif(v_post->>'suggested_image_idea',''),
       nullif(v_post->>'planned_post_at','')::timestamptz,
       coalesce(v_post->'ai_metadata','{}'::jsonb))
    returning id into v_id;
    v_post_ids := array_append(v_post_ids, v_id);
  end loop;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'post_ids', to_jsonb(v_post_ids),
    'replayed', false);
end;
$$;

revoke execute on function public.social_create_batch(jsonb, jsonb) from anon;
grant execute on function public.social_create_batch(jsonb, jsonb) to authenticated;

/* ───────────────────── storage: social-post-images ─────────────────────
 * PRIVATE bucket (signed URLs, short TTL — regenerated on view). Path
 * convention: {creatorId}/social/{postId}/{uuid}.{ext} — first folder =
 * auth.uid(), same own-folder policy shape as course-assets. Upload only,
 * never generated. Removing an image DETACHES the reference; the object is
 * retained (revert-friendly) until a later retention purge. */

insert into storage.buckets (id, name, public)
values ('social-post-images', 'social-post-images', false)
on conflict (id) do nothing;

create policy "social_images_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'social-post-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "social_images_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'social-post-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "social_images_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'social-post-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "social_images_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'social-post-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

/* ───────────────── analytics_event: 13 new social types ─────────────────
 * Same SINGLE stream (no new table). Marketing events, not course-consumption
 * events: course_id = the hub's course context (posts generated from a manual
 * topic still carry the hub course). Client SDK + this check extend TOGETHER
 * (the consequential-updates rule); the TS union lives in
 * lib/marketing/types.ts (AnalyticsEventType). */

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
    'social_voice_profile_derived','social_voice_profile_edited'
  ));
