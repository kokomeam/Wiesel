-- Course covers + creator identity (2026-07-11).
--
-- 1. courses.cover_image_url — live-mutable CARD metadata, deliberately NOT
--    snapshotted (the M2 rule: card metadata never snapshots — a creator can
--    refresh the cover without republishing). No RLS change: the author writes
--    it through the existing courses update policy; public reads flow ONLY
--    through the definer RPCs below.
-- 2. profiles.headline / profiles.bio — public creator-card fields. profiles
--    RLS is select-using-true (world-readable since 0001), so these are
--    PUBLIC by design: never put private data here. avatar_url already exists
--    since 0001 (not re-added). Length CHECKs mirror lib/profile/schema.ts.
-- 3. course_landing_extras(p_course_id) — one definer read for the public
--    course landing: cover + creator card + card-safe AGGREGATES only
--    (student/course/review counts, avg rating — never emails, never review
--    bodies, never enrollment rows). Gate mirrors the landing page's own RLS
--    reality: live + (public OR signed-in caller) — an anonymous caller gets
--    zero rows for an unlisted course, exactly like the page 404s (unlisted
--    "link possession" requires a session, per the M2 design).
-- 4/5. my_learning() v3 + marketplace_listings() v3 — columns APPENDED
--    (cover_image_url; + creator_avatar_url/creator_headline on listings).
--
-- Pending-migration note: this file and 20260708000000 may not be applied to
-- the live DB yet. Every new column/RPC is APPENDED (never reordered) and
-- consumers treat an RPC error / missing field as "hide the section", so
-- pre-migration clients degrade gracefully.

-- ───────────────────── 1. courses.cover_image_url ──────────────────────────
alter table public.courses
  add column if not exists cover_image_url text;

-- ─────────────────── 2. profiles.headline / profiles.bio ───────────────────
alter table public.profiles add column if not exists headline text;
alter table public.profiles add column if not exists bio text;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS — drop-then-add keeps this
-- idempotent. NULL passes both (the fields are optional).
alter table public.profiles drop constraint if exists profiles_headline_len_check;
alter table public.profiles
  add constraint profiles_headline_len_check check (char_length(headline) <= 120);
alter table public.profiles drop constraint if exists profiles_bio_len_check;
alter table public.profiles
  add constraint profiles_bio_len_check check (char_length(bio) <= 2000);

-- ───────────────────── 3. course_landing_extras RPC ────────────────────────
-- Privacy rationale: exposes only card-safe aggregates plus the already
-- world-readable profiles fields; definer access is what lets it read
-- enrollments / rollup_course_reviews (author-only under RLS) — but ONLY as
-- counts and a weighted average, and ONLY while the course has a live
-- publication (unpublish ⇒ zero rows ⇒ the landing hides the sections).
drop function if exists public.course_landing_extras(uuid);
create function public.course_landing_extras(p_course_id uuid)
returns table (
  cover_image_url       text,
  creator_id            uuid,
  creator_name          text,
  creator_headline      text,
  creator_bio           text,
  creator_avatar_url    text,
  creator_student_count integer,
  creator_course_count  integer,
  creator_review_count  integer,
  creator_avg_rating    numeric,
  course_student_count  integer,
  course_review_count   integer,
  course_avg_rating     numeric
)
language sql security definer stable set search_path = public as $$
  select
    c.cover_image_url,
    c.author_id,
    coalesce(pr.display_name, 'A WiseSel educator'),
    pr.headline,
    pr.bio,
    pr.avatar_url,
    -- Creator aggregates are ALL scoped to courses with a live publication —
    -- one consistent basis. An unpublished course's learners/reviews drop out
    -- of the displayed reputation (visitors can't verify a 404'd course, and
    -- "1 course · 100 reviews" from mixed universes reads as broken math).
    -- Distinct learners (a learner enrolled in three courses counts once).
    coalesce((
      select count(distinct e.user_id)::integer
      from public.enrollments e
      join public.courses ac on ac.id = e.course_id
      where ac.author_id = c.author_id
        and e.status in ('active', 'completed')
        and exists (
          select 1 from public.course_publications lcp
          where lcp.course_id = ac.id and lcp.status = 'live'
        )
    ), 0),
    coalesce((
      select count(distinct cp.course_id)::integer
      from public.course_publications cp
      join public.courses ac on ac.id = cp.course_id
      where ac.author_id = c.author_id
        and cp.status = 'live'
    ), 0),
    coalesce((
      select sum(r.review_count)::integer
      from public.rollup_course_reviews r
      join public.courses ac on ac.id = r.course_id
      where ac.author_id = c.author_id
        and exists (
          select 1 from public.course_publications lcp
          where lcp.course_id = ac.id and lcp.status = 'live'
        )
    ), 0),
    -- Weighted across the creator's LIVE courses; NULL until any review exists.
    (
      select round(sum(r.avg_rating * r.review_count)
               / nullif(sum(r.review_count), 0), 2)
      from public.rollup_course_reviews r
      join public.courses ac on ac.id = r.course_id
      where ac.author_id = c.author_id
        and exists (
          select 1 from public.course_publications lcp
          where lcp.course_id = ac.id and lcp.status = 'live'
        )
    ),
    coalesce((
      select count(distinct e.user_id)::integer
      from public.enrollments e
      where e.course_id = c.id
        and e.status in ('active', 'completed')
    ), 0),
    coalesce((
      select r.review_count from public.rollup_course_reviews r
      where r.course_id = c.id
    ), 0),
    (
      select r.avg_rating from public.rollup_course_reviews r
      where r.course_id = c.id
    )
  from public.courses c
  left join public.profiles pr on pr.id = c.author_id
  where c.id = p_course_id
    and exists (
      select 1 from public.course_publications cp
      where cp.course_id = c.id
        and cp.status = 'live'
        -- Anon callers only see PUBLIC courses (unlisted needs a session,
        -- mirroring course_publications RLS / the landing's 404 behavior).
        and (cp.visibility = 'public' or (select auth.uid()) is not null)
    );
$$;
revoke all on function public.course_landing_extras(uuid) from public;
grant execute on function public.course_landing_extras(uuid) to anon, authenticated;

-- ───────────────────────── 4. my_learning v3 ───────────────────────────────
-- Body is the 20260708000000 v2 body verbatim + a courses join selecting
-- cover_image_url, APPENDED as the last column.
drop function if exists public.my_learning();
create function public.my_learning()
returns table (
  enrollment_id     uuid,
  enrollment_status text,
  enrolled_at       timestamptz,
  course_id         uuid,
  publication_id    uuid,
  slug              text,
  version           integer,
  title             text,
  description       text,
  level             text,
  total_lessons     integer,
  completed_lessons integer,
  last_activity_at  timestamptz,
  is_live           boolean,
  avg_rating        numeric,
  review_count      integer,
  cover_image_url   text
)
language sql security definer stable set search_path = public as $$
  select
    e.id,
    e.status,
    e.enrolled_at,
    e.course_id,
    p.id,
    p.slug,
    p.version,
    p.snapshot->'course'->>'title',
    p.snapshot->'course'->>'description',
    p.snapshot->'course'->>'level',
    coalesce((
      select sum(jsonb_array_length(m->'lessons'))::integer
      from jsonb_array_elements(p.snapshot->'modules') as m
    ), 0),
    coalesce((
      select count(*)::integer from public.learn_progress lp
      where lp.user_id = e.user_id
        and lp.course_id = e.course_id
        and lp.status = 'completed'
    ), 0),
    (
      select max(lp.last_activity_at) from public.learn_progress lp
      where lp.user_id = e.user_id and lp.course_id = e.course_id
    ),
    (p.status = 'live'),
    r.avg_rating,
    coalesce(r.review_count, 0),
    c.cover_image_url
  from public.enrollments e
  join lateral (
    -- Prefer the live publication; fall back to the newest retired one so an
    -- unpublish never erases a learner's (possibly completed) course card.
    select * from public.course_publications cp
    where cp.course_id = e.course_id
    order by (cp.status = 'live') desc, cp.version desc
    limit 1
  ) p on true
  left join public.rollup_course_reviews r on r.course_id = e.course_id
  left join public.courses c on c.id = e.course_id
  where e.user_id = (select auth.uid())
    and e.status in ('active', 'completed')
  order by coalesce((
    select max(lp.last_activity_at) from public.learn_progress lp
    where lp.user_id = e.user_id and lp.course_id = e.course_id
  ), e.enrolled_at) desc;
$$;
revoke all on function public.my_learning() from public, anon;
grant execute on function public.my_learning() to authenticated;

-- ─────────────────────── 5. marketplace_listings v3 ────────────────────────
-- v2 body verbatim + courses join; cover_image_url / creator_avatar_url /
-- creator_headline APPENDED.
drop function if exists public.marketplace_listings();
create function public.marketplace_listings()
returns table (
  publication_id     uuid,
  course_id          uuid,
  slug               text,
  version            integer,
  title              text,
  description        text,
  level              text,
  audience           text,
  creator_name       text,
  module_count       integer,
  lesson_count       integer,
  published_at       timestamptz,
  avg_rating         numeric,
  review_count       integer,
  cover_image_url    text,
  creator_avatar_url text,
  creator_headline   text
)
language sql security definer stable set search_path = public as $$
  select
    p.id,
    p.course_id,
    p.slug,
    p.version,
    p.snapshot->'course'->>'title',
    p.snapshot->'course'->>'description',
    p.snapshot->'course'->>'level',
    p.snapshot->'course'->>'audience',
    coalesce(pr.display_name, 'A WiseSel educator'),
    coalesce(jsonb_array_length(p.snapshot->'modules'), 0),
    coalesce((
      select sum(jsonb_array_length(m->'lessons'))::integer
      from jsonb_array_elements(p.snapshot->'modules') as m
    ), 0),
    p.published_at,
    r.avg_rating,
    coalesce(r.review_count, 0),
    c.cover_image_url,
    pr.avatar_url,
    pr.headline
  from public.course_publications p
  left join public.profiles pr on pr.id = p.created_by
  left join public.rollup_course_reviews r on r.course_id = p.course_id
  left join public.courses c on c.id = p.course_id
  where p.status = 'live' and p.visibility = 'public'
  order by p.published_at desc;
$$;
revoke all on function public.marketplace_listings() from public, anon;
grant execute on function public.marketplace_listings() to authenticated;
