-- PERF-1 C1 — /dashboard bundle RPC (docs/perf/PERF-1_diagnosis.md §A2:
-- "/dashboard — 13 round trips, 5 sequential waves").
--
-- The creator dashboard used to issue: profiles(*) ∥ courses → a 5-way
-- .in(courseIds) batch (live publications, ALL enrollment rows shipped to JS
-- just to be counted, review rollups, EVERY open agent_finding incl. its
-- jsonb though the rail renders 5, draft learner_messages) → the spotlight
-- funnel + the FULL publication snapshot fetched only for lessonId→title
-- labels. public.creator_dashboard() collapses everything into ONE round
-- trip of pre-aggregated jsonb; the snapshot read moved to the immutable
-- publication cache (lib/learn/publicationCache.ts), so the page is
-- 1 RPC + at most 1 cold cached-snapshot read.
--
-- Contract (Zod-validated by lib/analytics/creatorHomeLoader.ts — the TS
-- schema is the consumer source of truth):
--   {
--     "profile": <full profiles row>            | null,
--     "courses": [{ id, title, status, updated_at, cover_image_url,
--                   live_publication: {id, version, visibility} | null,
--                   enrollments_total, enrollments_active,
--                   enrollments_completed, avg_rating|null, review_count,
--                   open_findings, draft_messages }]   -- updated_at desc
--     "attention_findings": top-5 open findings ({id, course_id, finding,
--                   created_at}), ranked like parseAttentionFindings,
--     "open_findings_total": int,
--     "spotlight": { publication_id, course_id,
--                    funnel: [{lesson_id, lesson_order, started_count,
--                              completed_count, dropoff_pct}] } | null
--   }
--
-- SECURITY: definer, no args — EVERYTHING derives from auth.uid() (pinned
-- once; a forged course id cannot be supplied because none is accepted).
-- Anonymous callers are rejected; grants mirror course_analytics_overview
-- (revoked from public+anon, authenticated only).

create or replace function public.creator_dashboard()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid         uuid := (select auth.uid());
  v_profile     jsonb;
  v_courses     jsonb;
  v_attention   jsonb;
  v_open_total  integer;
  v_spot_course uuid;
  v_spot_pub    uuid;
  v_spotlight   jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- Full row (to_jsonb) so the identity band's fields (display_name /
  -- headline / bio / avatar_url) ride along regardless of which optional
  -- profile columns a given environment has — the loader strips extras.
  select to_jsonb(p) into v_profile
  from public.profiles p
  where p.id = v_uid;

  -- Per-course health: counts via GROUP BY joins — no row transfer. The
  -- partial unique index on course_publications ("one live row per course")
  -- guarantees the live_publication left join stays 1:1.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',                    c.id,
           'title',                 c.title,
           'status',                c.status,
           'updated_at',            c.updated_at,
           'cover_image_url',       c.cover_image_url,
           'live_publication',      case when p.id is null then null
                                    else jsonb_build_object(
                                      'id',         p.id,
                                      'version',    p.version,
                                      'visibility', p.visibility) end,
           'enrollments_total',     coalesce(en.total, 0),
           'enrollments_active',    coalesce(en.active, 0),
           'enrollments_completed', coalesce(en.completed, 0),
           'avg_rating',            r.avg_rating,
           'review_count',          coalesce(r.review_count, 0),
           'open_findings',         coalesce(fi.n, 0),
           'draft_messages',        coalesce(dm.n, 0)
         ) order by c.updated_at desc, c.id), '[]'::jsonb)
    into v_courses
  from public.courses c
  left join public.course_publications p
    on p.course_id = c.id and p.status = 'live'
  left join (
    select e.course_id,
           count(*)::integer as total,
           count(*) filter (where e.status = 'active')::integer    as active,
           count(*) filter (where e.status = 'completed')::integer as completed
    from public.enrollments e
    where e.course_id in (select id from public.courses where author_id = v_uid)
    group by e.course_id
  ) en on en.course_id = c.id
  left join public.rollup_course_reviews r on r.course_id = c.id
  left join (
    select f.course_id, count(*)::integer as n
    from public.agent_findings f
    where f.status = 'open'
      and f.course_id in (select id from public.courses where author_id = v_uid)
    group by f.course_id
  ) fi on fi.course_id = c.id
  left join (
    select m.course_id, count(*)::integer as n
    from public.learner_messages m
    where m.status = 'draft'
      and m.course_id in (select id from public.courses where author_id = v_uid)
    group by m.course_id
  ) dm on dm.course_id = c.id
  where c.author_id = v_uid;

  select count(*)::integer into v_open_total
  from public.agent_findings f
  where f.status = 'open'
    and f.course_id in (select id from public.courses where author_id = v_uid);

  -- Attention rail: the top 5 by the EXACT parseAttentionFindings order
  -- (lib/analytics/creatorHome.ts — the TS source of truth): severity rank
  -- high→medium→low with unknown treated as medium (FindingCardSchema's
  -- .catch("medium")), then newest first. Rows whose model-authored jsonb
  -- cannot render a card (non-object, missing/empty/non-string title) are
  -- SKIPPED here exactly as the TS parse skips them, so they never consume a
  -- cap slot. The page re-runs parseAttentionFindings over these 5 rows for
  -- parse defense + final ordering — SQL and TS must agree or a high-severity
  -- 6th-newest finding would silently drop off the rail.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         a.id,
           'course_id',  a.course_id,
           'finding',    a.finding,
           'created_at', a.created_at
         ) order by a.severity_rank, a.created_at desc), '[]'::jsonb)
    into v_attention
  from (
    select f.id, f.course_id, f.finding, f.created_at,
           case f.finding->>'severity'
             when 'high' then 0
             when 'low'  then 2
             else 1 -- 'medium' AND anything unknown (.catch("medium"))
           end as severity_rank
    from public.agent_findings f
    where f.status = 'open'
      and f.course_id in (select id from public.courses where author_id = v_uid)
      and jsonb_typeof(f.finding) = 'object'
      and jsonb_typeof(f.finding->'title') = 'string'
      and f.finding->>'title' <> ''
    order by severity_rank, f.created_at desc
    limit 5
  ) a;

  -- Spotlight: mirrors pickSpotlightCourse() in lib/analytics/creatorHome.ts
  -- (the TS source of truth) EXACTLY: among courses WITH a live publication,
  -- most learners wins (learners = ALL enrollment rows, any status — the
  -- same count the health card shows); ties break ascending by display title
  -- ('Untitled course' when the title is the empty string — buildCourseHealth's
  -- fallback, which is what pickSpotlightCourse compares); any remaining tie
  -- falls back to the course-list iteration order (updated_at desc, then id
  -- for determinism). Text collation is the DB default vs. JS localeCompare —
  -- identical for the plain-ASCII common case; locale exotica only matter on
  -- an exact learner-count tie.
  select c.id, p.id
    into v_spot_course, v_spot_pub
  from public.courses c
  join public.course_publications p
    on p.course_id = c.id and p.status = 'live'
  left join (
    select e.course_id, count(*)::integer as total
    from public.enrollments e
    where e.course_id in (select id from public.courses where author_id = v_uid)
    group by e.course_id
  ) en on en.course_id = c.id
  where c.author_id = v_uid
  order by coalesce(en.total, 0) desc,
           coalesce(nullif(c.title, ''), 'Untitled course') asc,
           c.updated_at desc,
           c.id
  limit 1;

  if v_spot_pub is not null then
    v_spotlight := jsonb_build_object(
      'publication_id', v_spot_pub,
      'course_id',      v_spot_course,
      'funnel', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'lesson_id',       f.lesson_id,
                 'lesson_order',    f.lesson_order,
                 'started_count',   f.started_count,
                 'completed_count', f.completed_count,
                 'dropoff_pct',     f.dropoff_pct
               ) order by f.lesson_order)
        from public.rollup_lesson_funnel f
        where f.publication_id = v_spot_pub), '[]'::jsonb));
  end if;

  return jsonb_build_object(
    'profile',             v_profile,            -- SQL null → JSON null
    'courses',             v_courses,
    'attention_findings',  v_attention,
    'open_findings_total', coalesce(v_open_total, 0),
    'spotlight',           v_spotlight           -- null when nothing is live
  );
end;
$$;

revoke all on function public.creator_dashboard() from public, anon;
grant execute on function public.creator_dashboard() to authenticated;
