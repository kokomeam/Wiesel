-- CourseGen Pro — Video Lessons (educator-recorded / uploaded, hosted by Mux).
--
-- Educators attach a recorded or uploaded video to a lesson as a first-class
-- `video` block (a sibling of `slide_deck` / `imported_deck`). Recording uses
-- browser-native APIs (getUserMedia / getDisplayMedia / MediaRecorder); the file
-- is uploaded DIRECTLY to Mux via a server-issued direct-upload URL, so no bytes
-- ever touch our storage. Mux ingests + encodes the asset; status flows back to
-- the block via polling and (optionally) a signed webhook.
--
-- Design notes:
--   • `video_assets` is the SOURCE OF TRUTH for Mux status; the block's content
--     jsonb carries a denormalized snapshot for instant render (mirrors how
--     `imported_deck` mirrors `deck_imports.status`).
--   • `lesson_id` / `block_id` are FK-FREE plain uuids on purpose: the row is
--     created at upload time, and the course autosave reconcile churns block
--     rows — a hard FK would race it (same rationale as deck_imports).
--   • No storage bucket: Mux hosts the media. We store only Mux IDs + metadata.
--   • The `provider` column keeps the schema provider-agnostic (only 'mux' now).

-- ─────────────── 1. allow `video` in blocks.type CHECK ──────────────────────
-- Drop the current (named) type CHECK robustly, then re-add it including 'video'.
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.blocks'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%slide_deck%';
  if cname is not null then
    execute format('alter table public.blocks drop constraint %I', cname);
  end if;
end $$;

alter table public.blocks add constraint blocks_type_check
  check (type in (
    'slide_deck','imported_deck','video','lecture_text',
    'quiz','homework','exercise','example','resource'
  ));

-- ───────────────────────────── 2. video_assets ─────────────────────────────
create table public.video_assets (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  lesson_id         uuid,                 -- soft ref (no FK; see header)
  block_id          uuid,                 -- soft ref (no FK; see header)
  provider          text not null default 'mux' check (provider in ('mux')),
  -- Mux identifiers. `mux_upload_id` exists from the moment a direct upload is
  -- created; `mux_asset_id` / `mux_playback_id` land once Mux creates the asset.
  mux_upload_id     text,
  mux_asset_id      text,
  mux_playback_id   text,
  playback_policy   text not null default 'public'
                      check (playback_policy in ('public','signed')),
  status            text not null default 'uploading'
                      check (status in ('uploading','processing','ready','failed')),
  duration_seconds  double precision,
  aspect_ratio      text,                 -- e.g. "16:9"
  -- Resolved static-rendition (MP4) URL, so the browser <video> plays everywhere
  -- without an HLS library. Null until the rendition is ready / if unavailable.
  mp4_url           text,
  mp4_status        text,                 -- 'preparing' | 'ready' | 'disabled' | null
  thumbnail_time    double precision,     -- poster frame time (seconds)
  error             text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index video_assets_course_id_idx    on public.video_assets(course_id);
create index video_assets_owner_id_idx     on public.video_assets(owner_id);
create index video_assets_status_idx       on public.video_assets(status);
create index video_assets_mux_upload_idx   on public.video_assets(mux_upload_id);
create index video_assets_mux_asset_idx    on public.video_assets(mux_asset_id);
create trigger video_assets_set_updated_at before update on public.video_assets
  for each row execute procedure extensions.moddatetime(updated_at);

-- ─────────────────────────────────── 3. RLS ─────────────────────────────────
alter table public.video_assets enable row level security;

-- Author-only (no public read — educator media is private until a student-facing
-- playback surface ships). Reuses the existing private.is_course_author helper.
create policy "video_assets_select" on public.video_assets for select
  using (private.is_course_author(course_id));
create policy "video_assets_insert" on public.video_assets for insert
  with check (private.is_course_author(course_id) and owner_id = (select auth.uid()));
create policy "video_assets_update" on public.video_assets for update
  using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "video_assets_delete" on public.video_assets for delete
  using (private.is_course_author(course_id));

-- The Mux webhook (no user session) updates rows via the SERVICE-ROLE client,
-- which bypasses RLS by design — see lib/supabase/admin.ts. No public grants.
