-- Portal split (2026-07-08): creator vs learner roles + student-portal data.
--
-- 1. profiles.role — the user's DEFAULT portal ('creator' | 'learner'). This is
--    a routing preference, NOT a security boundary: any signed-in user may use
--    both portals (a creator can learn, a learner can open the studio). All
--    authorization stays where it already lives (author_id checks, enrollment
--    RLS, definer RPCs).
-- 2. private.handle_new_user — stamps role from signup metadata AND fixes a
--    latent bug: the signup form sends raw_user_meta_data->>'display_name' but
--    the trigger only read 'name'/'full_name', so display_name was always NULL.
--    Backfills existing rows from auth metadata, and backfills role='learner'
--    for users who enrolled but never authored a course.
-- 3. my_activity_days() — definer RPC for the student-home streak. learning_events
--    deliberately has NO student select policy (see the ingest RPC notes in
--    20260702050000); this RPC is the sanctioned read path, hard-pinned to
--    auth.uid() and exposing only distinct activity dates.
-- 4. my_learning() v2 — LEFT-ish join via lateral: an enrollment whose course
--    was later unpublished no longer vanishes (completed courses survive); new
--    is_live flag lets the UI disable the link instead. Adds avg_rating /
--    review_count from rollup_course_reviews (definer bypasses the author-only
--    rollup RLS on purpose — aggregates are card-safe, never review bodies).
-- 5. marketplace_listings() v2 — same rating fields for Explore/marketplace cards.
--
-- Return shapes of both RPCs changed (columns APPENDED) ⇒ drop + recreate, and
-- lib/database.types.ts was spliced by hand (never full-regen).

-- ───────────────────────── 1. profiles.role ────────────────────────────────
alter table public.profiles
  add column if not exists role text not null default 'creator'
  check (role in ('creator', 'learner'));

-- ─────────────────── 2. signup trigger fix + backfills ─────────────────────
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'display_name',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name'
    ),
    case
      when new.raw_user_meta_data->>'role' in ('creator', 'learner')
        then new.raw_user_meta_data->>'role'
      else 'creator'
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Backfill display names that the old trigger dropped (form sent 'display_name').
update public.profiles p
set display_name = coalesce(
  u.raw_user_meta_data->>'display_name',
  u.raw_user_meta_data->>'name',
  u.raw_user_meta_data->>'full_name'
)
from auth.users u
where u.id = p.id
  and (p.display_name is null or p.display_name = '')
  and coalesce(
    u.raw_user_meta_data->>'display_name',
    u.raw_user_meta_data->>'name',
    u.raw_user_meta_data->>'full_name'
  ) is not null;

-- Existing accounts that only ever learned default to the learner portal.
update public.profiles p
set role = 'learner'
where not exists (select 1 from public.courses c where c.author_id = p.id)
  and exists (select 1 from public.enrollments e where e.user_id = p.id);

-- ───────────────── 3. my_activity_days (streak source) ─────────────────────
create or replace function public.my_activity_days(p_days integer default 30)
returns table (activity_date date)
language sql security definer stable set search_path = public as $$
  select distinct (le.server_ts at time zone 'utc')::date as activity_date
  from public.learning_events le
  where le.user_id = (select auth.uid())
    and le.server_ts >= now() - make_interval(days => greatest(p_days, 1))
  order by 1 desc;
$$;
revoke all on function public.my_activity_days(integer) from public, anon;
grant execute on function public.my_activity_days(integer) to authenticated;

-- ───────────────────────── 4. my_learning v2 ───────────────────────────────
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
  review_count      integer
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
    coalesce(r.review_count, 0)
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
  where e.user_id = (select auth.uid())
    and e.status in ('active', 'completed')
  order by coalesce((
    select max(lp.last_activity_at) from public.learn_progress lp
    where lp.user_id = e.user_id and lp.course_id = e.course_id
  ), e.enrolled_at) desc;
$$;
revoke all on function public.my_learning() from public, anon;
grant execute on function public.my_learning() to authenticated;

-- ─────────────────────── 5. marketplace_listings v2 ────────────────────────
drop function if exists public.marketplace_listings();
create function public.marketplace_listings()
returns table (
  publication_id uuid,
  course_id      uuid,
  slug           text,
  version        integer,
  title          text,
  description    text,
  level          text,
  audience       text,
  creator_name   text,
  module_count   integer,
  lesson_count   integer,
  published_at   timestamptz,
  avg_rating     numeric,
  review_count   integer
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
    coalesce(r.review_count, 0)
  from public.course_publications p
  left join public.profiles pr on pr.id = p.created_by
  left join public.rollup_course_reviews r on r.course_id = p.course_id
  where p.status = 'live' and p.visibility = 'public'
  order by p.published_at desc;
$$;
revoke all on function public.marketplace_listings() from public, anon;
grant execute on function public.marketplace_listings() to authenticated;
