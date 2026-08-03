-- PERF-1 C3 (3/4) — persist lesson/module counts on course_publications
-- (docs/perf/PERF-1_diagnosis.md §A3 "Over-fetch / heavyweight RPCs").
--
-- The definer RPCs re-expand the immutable publication `snapshot` jsonb per
-- row per request: marketplace_listings() and my_learning() run
-- jsonb_array_elements(snapshot->'modules') for every listing/enrollment, and
-- private.is_review_eligible (called via review_prompt_state on every learn
-- page) counts lessons by expanding the live snapshot. The snapshot is
-- DB-trigger-enforced immutable, so the counts are safe to persist ONCE at
-- publish time (checkpoint decision #4 approved this schema addition).
--
-- Contents:
--   1. Two new int columns + backfill from the existing snapshots.
--   2. Immutability trigger extended: the counts reject UPDATE once set
--      (null → value stays legal so the backfill and any later repair work).
--   3. publish_course copied verbatim from 20260702020000 (its only
--      definition — grep-verified) changed ONLY to compute + insert them.
--   4. marketplace_listings() / my_learning() (latest = 20260711000000 v3)
--      and private.is_review_eligible (20260707020000) read the columns,
--      with a COALESCE(...) fallback to the old jsonb expression so
--      pre-backfill rows (or a fresh-environment race) never misreport.
--      Signatures and returned column sets are byte-identical.

-- ───────────────────────── 1. Columns + backfill ───────────────────────────

alter table public.course_publications
  add column if not exists lesson_count integer,
  add column if not exists module_count integer;

-- Backfill BEFORE the trigger extension below guards the columns. The counts
-- mirror the RPCs' exact jsonb expressions (modules array length; lessons =
-- sum of each module's lessons array length).
update public.course_publications
set
  module_count = coalesce(jsonb_array_length(snapshot->'modules'), 0),
  lesson_count = coalesce((
    select sum(jsonb_array_length(m->'lessons'))::integer
    from jsonb_array_elements(snapshot->'modules') as m
  ), 0)
where lesson_count is null or module_count is null;

-- ──────────────── 2. Immutability trigger: guard the counts ────────────────
-- Original: 20260702020000 (search_path pinned by 20260702020100). The counts
-- are content-derived, so they join the frozen set — but only ONCE SET, so a
-- legacy null can still be filled in.

create or replace function private.enforce_publication_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.snapshot      is distinct from old.snapshot
     or new.content_hash  is distinct from old.content_hash
     or new.version       is distinct from old.version
     or new.course_id     is distinct from old.course_id
     or new.published_at  is distinct from old.published_at
     or new.created_by    is distinct from old.created_by
     or new.linter_report is distinct from old.linter_report
     or (old.lesson_count is not null
         and new.lesson_count is distinct from old.lesson_count)
     or (old.module_count is not null
         and new.module_count is distinct from old.module_count)
  then
    raise exception 'course_publications is immutable: snapshot/version/hash/report/counts can never change';
  end if;
  return new;
end;
$$;

-- ─────────────── 3. publish_course: compute + insert the counts ────────────
-- Verbatim copy of the 20260702020000 definition; the ONLY changes are the
-- two v_*_count declarations, their computation, and the two insert columns.

create or replace function public.publish_course(
  p_course_id     uuid,
  p_snapshot      jsonb,
  p_answer_keys   jsonb,          -- [{ "blockId": "<uuid>", "keys": {...} }, …]
  p_content_hash  text,
  p_linter_report jsonb default null,
  p_slug          text  default null,
  p_visibility    text  default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid          uuid := (select auth.uid());
  v_prev         public.course_publications%rowtype;
  v_version      integer;
  v_slug         text;
  v_visibility   text;
  v_pub          public.course_publications%rowtype;
  v_module_count integer;
  v_lesson_count integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  perform 1 from public.courses
    where id = p_course_id and author_id = v_uid
    for update;
  if not found then
    raise exception 'not the course author';
  end if;
  if p_snapshot is null or p_content_hash is null then
    raise exception 'snapshot and content_hash are required';
  end if;

  select * into v_prev from public.course_publications
    where course_id = p_course_id
    order by version desc
    limit 1;

  v_version := coalesce(v_prev.version, 0) + 1;
  v_slug := coalesce(v_prev.slug, p_slug);
  if v_slug is null then
    raise exception 'slug is required on first publish';
  end if;
  v_visibility := coalesce(p_visibility, v_prev.visibility, 'public');
  if v_visibility not in ('public','unlisted') then
    raise exception 'visibility must be public or unlisted';
  end if;

  v_module_count := coalesce(jsonb_array_length(p_snapshot->'modules'), 0);
  select coalesce(sum(jsonb_array_length(m->'lessons'))::integer, 0)
    into v_lesson_count
    from jsonb_array_elements(coalesce(p_snapshot->'modules', '[]'::jsonb)) as m;

  update public.course_publications
    set status = 'unpublished'
    where course_id = p_course_id and status = 'live';

  insert into public.course_publications
      (course_id, version, slug, previous_slugs, snapshot, visibility,
       status, content_hash, linter_report, created_by,
       lesson_count, module_count)
    values
      (p_course_id, v_version, v_slug, coalesce(v_prev.previous_slugs, '{}'),
       p_snapshot, v_visibility, 'live', p_content_hash, p_linter_report, v_uid,
       v_lesson_count, v_module_count)
    returning * into v_pub;

  insert into public.quiz_answer_keys (publication_id, block_id, keys)
    select v_pub.id, (k->>'blockId')::uuid, k->'keys'
    from jsonb_array_elements(coalesce(p_answer_keys, '[]'::jsonb)) as k;

  update public.courses set status = 'published' where id = p_course_id;

  return jsonb_build_object(
    'id', v_pub.id,
    'courseId', v_pub.course_id,
    'version', v_pub.version,
    'slug', v_pub.slug,
    'visibility', v_pub.visibility,
    'status', v_pub.status,
    'contentHash', v_pub.content_hash,
    'publishedAt', v_pub.published_at
  );
end;
$$;

revoke all on function public.publish_course(uuid, jsonb, jsonb, text, jsonb, text, text) from public, anon;
grant execute on function public.publish_course(uuid, jsonb, jsonb, text, jsonb, text, text) to authenticated;

-- ──────────────── 4a. my_learning: read the persisted count ────────────────
-- 20260711000000 v3 body verbatim; ONLY total_lessons now reads
-- p.lesson_count first (COALESCE short-circuits — the jsonb subquery runs
-- only for a null column). Same signature + returned columns → in-place
-- CREATE OR REPLACE (grants persist; re-asserted for parity).

create or replace function public.my_learning()
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
    coalesce(p.lesson_count, (
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

-- ──────────── 4b. marketplace_listings: read the persisted counts ──────────
-- 20260711000000 v3 body verbatim; ONLY module_count/lesson_count changed.

create or replace function public.marketplace_listings()
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
    coalesce(p.module_count, jsonb_array_length(p.snapshot->'modules'), 0),
    coalesce(p.lesson_count, (
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

-- ──────────── 4c. is_review_eligible: count from the column ────────────────
-- 20260707020000 body verbatim except v_total: the live publication's
-- lesson_count first, the old double-expansion only as the null fallback.
-- No-live-publication still yields v_total null → false (unchanged: the
-- original count(*)-over-no-rows path returned 0 → false).

create or replace function private.is_review_eligible(cid uuid, uid uuid)
returns boolean language plpgsql security definer stable
set search_path = public as $$
declare
  v_status text;
  v_total  numeric;
  v_sum    numeric;
begin
  select e.status into v_status
  from public.enrollments e
  where e.course_id = cid and e.user_id = uid;
  if not found then return false; end if;
  if v_status = 'completed' then return true; end if;
  if v_status <> 'active' then return false; end if; -- dropped learners aren't asked

  select coalesce(pub.lesson_count, (
      select count(*)::integer
      from jsonb_array_elements(pub.snapshot->'modules') m(value),
           jsonb_array_elements(m.value->'lessons') l(value)
    ))::numeric
  into v_total
  from public.course_publications pub
  where pub.course_id = cid and pub.status = 'live';
  if v_total is null or v_total = 0 then return false; end if;

  select coalesce(sum(lp.pct), 0)::numeric into v_sum
  from public.learn_progress lp
  where lp.course_id = cid and lp.user_id = uid;

  -- The "almost done" threshold already used elsewhere (comms templates,
  -- Stuck queue) — mirrored as REVIEW_ELIGIBLE_PROGRESS_PCT in TS.
  return (v_sum / v_total) >= 70;
end;
$$;
