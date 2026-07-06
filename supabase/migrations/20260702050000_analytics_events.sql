-- WiseSel — Milestone 3: learning-event pipeline + analytics rollups.
--
-- Adds the append-only learning_events stream, the rollup tables the creator
-- dashboard reads (per-lesson funnel, per-question item analysis, slide dwell,
-- video retention, learner flags), the SECURITY DEFINER recompute functions,
-- two author-gated read RPCs (overview + roster), and the nightly pg_cron job.
--
-- Trust model:
--   • ENGAGEMENT events (lesson_started, slide_viewed, video_progress,
--     video_completed, quiz_started, session_heartbeat) are client-reported
--     through /api/analytics/ingest on the RLS client — the insert policy pins
--     user_id to auth.uid(), requires enrollment (or authorship), and requires
--     the publication to belong to the claimed course (no cross-course rollup
--     pollution). Idempotency = the UNIQUE client_event_id (replays no-op).
--   • AUTHORITATIVE events (quiz_submitted, homework_submitted,
--     lesson_completed) are SERVER-emitted (service role) from the existing
--     grading/submission/progress writers, keyed by stable row uuids as
--     client_event_id so they can never double-count. No dashboard number
--     depends solely on a client event: funnel completion cross-checks
--     learn_progress, quiz stats read quiz_attempts/question_responses.
--   • Students can read NO events. The course author reads their own courses'
--     raw events (drill-down); everyone else sees nothing.
--   • Rollups are written ONLY by the definer functions (no client writes) and
--     are author-readable per course.
--
-- Threshold constants (7 days inactive / ≥2 failed attempts / <60% score) are
-- MIRRORED in lib/analytics/flags.ts — edit both together (verify-analytics.ts
-- asserts the TS side matches these documented values).

-- ─────────────────────────── 1. learning_events ────────────────────────────
create table public.learning_events (
  id              uuid primary key default gen_random_uuid(),
  -- Client-stamped uuid (server-emitted events use stable row uuids). The
  -- unique index is what makes batch replay idempotent (`on conflict do nothing`).
  client_event_id uuid not null unique,
  user_id         uuid not null references auth.users(id) on delete cascade,
  event_type      text not null check (event_type in (
                    'lesson_started','slide_viewed','video_progress',
                    'video_completed','quiz_started','quiz_submitted',
                    'homework_submitted','lesson_completed','session_heartbeat')),
  publication_id  uuid not null references public.course_publications(id) on delete cascade,
  version         integer not null,
  course_id       uuid not null references public.courses(id) on delete cascade,
  -- Node ids are snapshot ids (draft row ids preserved verbatim); no FK — the
  -- draft rows may be deleted while the events live on.
  lesson_id       uuid not null,
  block_id        uuid,
  slide_id        text,
  -- Typed extras the rollups aggregate (kept out of jsonb so SQL stays simple):
  dwell_ms        integer check (dwell_ms is null or dwell_ms >= 0),
  quartile        smallint check (quartile is null or quartile in (1,2,3,4)),
  attempt_id      uuid references public.quiz_attempts(id) on delete set null,
  metadata        jsonb not null default '{}'::jsonb,
  client_ts       timestamptz not null,
  server_ts       timestamptz not null default now()
);
create index learning_events_course_ts_idx
  on public.learning_events(course_id, server_ts);
create index learning_events_user_course_ts_idx
  on public.learning_events(user_id, course_id, server_ts);
-- The rollup scans filter by publication and group by lesson/type:
create index learning_events_pub_lesson_idx
  on public.learning_events(publication_id, lesson_id);

alter table public.learning_events enable row level security;

-- Insert: only your own events, only into a course you're enrolled in (or
-- author), and the publication must belong to that course. NOTE: this policy
-- admits plain INSERTs but NOT `on conflict do nothing` ones — Postgres also
-- requires the row to pass the SELECT policy for the conflict check, and
-- students deliberately have no select. The ingest path is therefore the
-- ingest_learning_events RPC below; this policy stays as defense-in-depth.
create policy "learning_events_insert" on public.learning_events for insert
  with check (
    user_id = (select auth.uid())
    and (private.is_enrolled(course_id) or private.is_course_author(course_id))
    and exists (
      select 1 from public.course_publications p
      where p.id = publication_id and p.course_id = learning_events.course_id
    )
  );
-- Select: the course author only (students read none).
create policy "learning_events_select" on public.learning_events for select
  using (private.is_course_author(course_id));
-- No update/delete policies: the stream is append-only.

-- The ONE ingest path for client events (SECURITY DEFINER so the idempotent
-- `on conflict do nothing` works while students still read none — see the
-- policy note above). Enforces in SQL exactly what the insert policy states:
-- user_id is PINNED to auth.uid() (a forged user_id field is ignored), every
-- event's course must be enrolled-or-authored, and every publication must
-- belong to its claimed course. Whole batch rejects on any violation.
create function public.ingest_learning_events(p_events jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := (select auth.uid());
  v_count integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) < 1 or jsonb_array_length(p_events) > 100 then
    raise exception 'events must be a non-empty array of at most 100';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_events) as e(course_id uuid)
    where not exists (
        select 1 from public.enrollments en
        where en.course_id = e.course_id and en.user_id = v_uid
          and en.status in ('active','completed'))
      and not exists (
        select 1 from public.courses c
        where c.id = e.course_id and c.author_id = v_uid)
  ) then
    raise exception 'not enrolled in the target course';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_events) as e(course_id uuid, publication_id uuid)
    where not exists (
      select 1 from public.course_publications p
      where p.id = e.publication_id and p.course_id = e.course_id)
  ) then
    raise exception 'publication does not belong to the course';
  end if;

  insert into public.learning_events
    (client_event_id, user_id, event_type, publication_id, version, course_id,
     lesson_id, block_id, slide_id, dwell_ms, quartile, attempt_id, metadata, client_ts)
  select
    e.client_event_id, v_uid, e.event_type, e.publication_id, e.version,
    e.course_id, e.lesson_id, e.block_id, e.slide_id, e.dwell_ms, e.quartile,
    e.attempt_id, coalesce(e.metadata, '{}'::jsonb), e.client_ts
  from jsonb_to_recordset(p_events) as e(
    client_event_id uuid, event_type text, publication_id uuid, version integer,
    course_id uuid, lesson_id uuid, block_id uuid, slide_id text,
    dwell_ms integer, quartile smallint, attempt_id uuid, metadata jsonb,
    client_ts timestamptz)
  on conflict (client_event_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.ingest_learning_events(jsonb) from public, anon;
grant execute on function public.ingest_learning_events(jsonb) to authenticated;

-- ─────────────────────────── 2. Rollup tables ──────────────────────────────
-- All keyed by (course_id, publication_id, version) so republished versions
-- never mix; written only by private.recompute_course_analytics.

create table public.rollup_lesson_funnel (
  course_id       uuid not null references public.courses(id) on delete cascade,
  publication_id  uuid not null references public.course_publications(id) on delete cascade,
  version         integer not null,
  lesson_id       uuid not null,
  lesson_order    integer not null,
  started_count   integer not null default 0,
  completed_count integer not null default 0,
  -- 0..1 vs the PREVIOUS lesson's started_count (null for the first lesson).
  dropoff_pct     numeric,
  computed_at     timestamptz not null default now(),
  primary key (publication_id, lesson_id)
);

create table public.rollup_question_stats (
  course_id           uuid not null references public.courses(id) on delete cascade,
  publication_id      uuid not null references public.course_publications(id) on delete cascade,
  version             integer not null,
  block_id            uuid not null,
  question_id         text not null,
  lesson_id           uuid not null,
  n                   integer not null default 0,
  pct_correct         numeric,            -- 0..100
  -- answer value → count. Value key: choiceId | text | 'true'/'false' |
  -- sorted choiceIds joined with '+' (multi-select).
  answer_distribution jsonb not null default '{}'::jsonb,
  -- The CORRECT answer's distribution bucket, resolved from quiz_answer_keys
  -- at rollup time (definer crosses that server-only table so the dashboard
  -- never needs the admin client). Null for short_answer (raw-text buckets
  -- can't exact-match the normalized key) — the distractor flag skips those.
  key_value           text,
  -- Point-biserial item-total correlation (null when undefined: n<2 or sd=0).
  discrimination      numeric,
  computed_at         timestamptz not null default now(),
  primary key (publication_id, question_id)
);

create table public.rollup_slide_dwell (
  course_id       uuid not null references public.courses(id) on delete cascade,
  publication_id  uuid not null references public.course_publications(id) on delete cascade,
  version         integer not null,
  block_id        uuid not null,
  slide_id        text not null,
  lesson_id       uuid not null,
  n               integer not null default 0,
  median_dwell_ms integer,
  p90_dwell_ms    integer,
  computed_at     timestamptz not null default now(),
  primary key (publication_id, slide_id)
);

create table public.rollup_video_retention (
  course_id       uuid not null references public.courses(id) on delete cascade,
  publication_id  uuid not null references public.course_publications(id) on delete cascade,
  version         integer not null,
  block_id        uuid not null,
  lesson_id       uuid not null,
  viewers         integer not null default 0,
  -- Distinct users who REACHED each quartile (q4 ⊆ q3 ⊆ q2 ⊆ q1 ⊆ viewers).
  q1_count        integer not null default 0,
  q2_count        integer not null default 0,
  q3_count        integer not null default 0,
  q4_count        integer not null default 0,
  completed_count integer not null default 0,
  computed_at     timestamptz not null default now(),
  primary key (publication_id, block_id)
);

-- Course-level "who needs attention" flags (Stuck queue + future triggers).
-- detail shapes:
--   inactive_7d_incomplete → {lastActivityAt, completedLessons, totalLessons}
--   repeated_quiz_failure  → {quizzes: [{blockId, failedAttempts, lastScorePct}]}
create table public.learner_flags (
  course_id   uuid not null references public.courses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  flag_type   text not null check (flag_type in
                ('inactive_7d_incomplete','repeated_quiz_failure')),
  detail      jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (course_id, user_id, flag_type)
);
create index learner_flags_course_idx on public.learner_flags(course_id);

alter table public.rollup_lesson_funnel   enable row level security;
alter table public.rollup_question_stats  enable row level security;
alter table public.rollup_slide_dwell     enable row level security;
alter table public.rollup_video_retention enable row level security;
alter table public.learner_flags          enable row level security;

create policy "rollup_lesson_funnel_select" on public.rollup_lesson_funnel
  for select using (private.is_course_author(course_id));
create policy "rollup_question_stats_select" on public.rollup_question_stats
  for select using (private.is_course_author(course_id));
create policy "rollup_slide_dwell_select" on public.rollup_slide_dwell
  for select using (private.is_course_author(course_id));
create policy "rollup_video_retention_select" on public.rollup_video_retention
  for select using (private.is_course_author(course_id));
create policy "learner_flags_select" on public.learner_flags
  for select using (private.is_course_author(course_id));
-- No client writes on any rollup table: the definer functions are the writers.

-- ──────────────────── 3. Recompute worker (no auth check) ──────────────────
create function private.recompute_course_analytics(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  pub record;
begin
  -- Per-publication rollups: every version the course ever shipped, so the
  -- dashboard's "live version" read is a plain publication_id lookup and old
  -- versions stay available for historical drill-down.
  for pub in
    select id, version, snapshot
    from public.course_publications where course_id = cid
  loop
    delete from public.rollup_lesson_funnel   where publication_id = pub.id;
    delete from public.rollup_question_stats  where publication_id = pub.id;
    delete from public.rollup_slide_dwell     where publication_id = pub.id;
    delete from public.rollup_video_retention where publication_id = pub.id;

    -- 3a. Lesson funnel. started = any event for the lesson UNION any
    -- learn_progress activity (backfills learners from before instrumentation
    -- and keeps completed ⊆ started). completed = server-authoritative
    -- learn_progress.status OR a lesson_completed event.
    insert into public.rollup_lesson_funnel
      (course_id, publication_id, version, lesson_id, lesson_order,
       started_count, completed_count, dropoff_pct)
    select
      cid, pub.id, pub.version, ls.lesson_id, ls.lesson_order,
      coalesce(ev.started, 0), coalesce(co.completed, 0),
      round(1 - coalesce(ev.started, 0)::numeric
              / nullif(lag(coalesce(ev.started, 0))
                         over (order by ls.lesson_order), 0), 4)
    from (
      select (l.value->>'id')::uuid as lesson_id,
             row_number() over (order by m.ord, l.ord)::integer as lesson_order
      from jsonb_array_elements(pub.snapshot->'modules') with ordinality m(value, ord),
           jsonb_array_elements(m.value->'lessons') with ordinality l(value, ord)
    ) ls
    left join (
      select y.lesson_id, count(distinct y.user_id)::integer as started
      from (
        select e.lesson_id, e.user_id
        from public.learning_events e where e.publication_id = pub.id
        union
        select lp.lesson_id, lp.user_id
        from public.learn_progress lp
        where lp.course_id = cid and lp.status <> 'not_started'
      ) y group by y.lesson_id
    ) ev on ev.lesson_id = ls.lesson_id
    left join (
      select x.lesson_id, count(distinct x.user_id)::integer as completed
      from (
        select lp.lesson_id, lp.user_id
        from public.learn_progress lp
        where lp.course_id = cid and lp.status = 'completed'
        union
        select e.lesson_id, e.user_id
        from public.learning_events e
        where e.publication_id = pub.id and e.event_type = 'lesson_completed'
      ) x group by x.lesson_id
    ) co on co.lesson_id = ls.lesson_id;

    -- 3b. Slide dwell (median/p90 via percentile_cont). Grouped by slide_id
    -- (the PK); block/lesson labels take the mode (min/max don't exist for
    -- uuid) so a stray mislabeled event can never break the recompute with a
    -- PK conflict.
    insert into public.rollup_slide_dwell
      (course_id, publication_id, version, block_id, slide_id, lesson_id,
       n, median_dwell_ms, p90_dwell_ms)
    select
      cid, pub.id, pub.version,
      mode() within group (order by e.block_id),
      e.slide_id,
      mode() within group (order by e.lesson_id),
      count(*)::integer,
      (percentile_cont(0.5) within group (order by e.dwell_ms))::integer,
      (percentile_cont(0.9) within group (order by e.dwell_ms))::integer
    from public.learning_events e
    where e.publication_id = pub.id
      and e.event_type = 'slide_viewed'
      and e.dwell_ms is not null and e.slide_id is not null
      and e.block_id is not null
    group by e.slide_id;

    -- 3c. Question stats + point-biserial discrimination.
    -- One attempt = one respondent; total score = # correct in the attempt
    -- (item included — classic item-total r_pb, mirrored by
    -- lib/analytics/stats.ts pointBiserial()):
    --   r_pb = ((m1 - m0) / sd_total) * sqrt(p * (1 - p))
    insert into public.rollup_question_stats
      (course_id, publication_id, version, block_id, question_id, lesson_id,
       n, pct_correct, answer_distribution, key_value, discrimination)
    with resp as (
      select a.id as attempt_id, a.block_id, qr.question_id, qr.response, qr.correct
      from public.quiz_attempts a
      join public.question_responses qr on qr.attempt_id = a.id
      where a.publication_id = pub.id
    ),
    totals as (
      select attempt_id,
             sum(case when correct then 1 else 0 end)::numeric as total
      from resp group by attempt_id
    ),
    joined as (
      select r.block_id, r.question_id, r.correct, t.total,
             coalesce(
               r.response->>'choiceId',
               r.response->>'text',
               r.response->>'answer',
               (select string_agg(v, '+' order by v)
                from jsonb_array_elements_text(r.response->'choiceIds') as t2(v)),
               '(blank)'
             ) as answer_key
      from resp r join totals t using (attempt_id)
    ),
    blockmap as (
      select (b.value->>'id')::uuid as block_id, (l.value->>'id')::uuid as lesson_id
      from jsonb_array_elements(pub.snapshot->'modules') m(value),
           jsonb_array_elements(m.value->'lessons') l(value),
           jsonb_array_elements(l.value->'blocks') b(value)
    ),
    dist as (
      select d.question_id, jsonb_object_agg(d.answer_key, d.cnt) as distribution
      from (
        select question_id, answer_key, count(*)::integer as cnt
        from joined group by question_id, answer_key
      ) d group by d.question_id
    ),
    keymap as (
      -- Normalize each question's correct answer to the SAME bucket format
      -- the responses use, so the dashboard's distractor check is a plain
      -- distribution[key_value] lookup.
      select q.value->>'questionId' as question_id,
             case q.value->>'kind'
               when 'multiple_choice' then q.value->>'correctChoiceId'
               when 'true_false'      then q.value->>'correctAnswer'
               when 'multi_select'    then (
                 select string_agg(v, '+' order by v)
                 from jsonb_array_elements_text(q.value->'correctChoiceIds') as t3(v))
               else null  -- short_answer
             end as key_value
      from public.quiz_answer_keys k,
           jsonb_array_elements(k.keys->'questions') q(value)
      where k.publication_id = pub.id
    ),
    agg as (
      select
        j.block_id, j.question_id,
        count(*)::integer as n,
        avg(case when j.correct then 1.0 else 0.0 end) as p,
        stddev_pop(j.total) as sd_total,
        avg(j.total) filter (where j.correct)     as m1,
        avg(j.total) filter (where not j.correct) as m0
      from joined j group by j.block_id, j.question_id
    )
    select
      cid, pub.id, pub.version, agg.block_id, agg.question_id, bm.lesson_id,
      agg.n,
      round(agg.p * 100, 1),
      coalesce(dist.distribution, '{}'::jsonb),
      km.key_value,
      case
        when agg.sd_total is null or agg.sd_total = 0 or agg.n < 2 then null
        else round(((agg.m1 - agg.m0) / agg.sd_total)
                     * sqrt(agg.p * (1 - agg.p)), 4)
      end
    from agg
    join blockmap bm on bm.block_id = agg.block_id
    left join dist on dist.question_id = agg.question_id
    left join keymap km on km.question_id = agg.question_id;

    -- 3d. Video retention (distinct users reaching each quartile).
    insert into public.rollup_video_retention
      (course_id, publication_id, version, block_id, lesson_id,
       viewers, q1_count, q2_count, q3_count, q4_count, completed_count)
    select
      cid, pub.id, pub.version, e.block_id,
      mode() within group (order by e.lesson_id),
      count(distinct e.user_id)::integer,
      (count(distinct e.user_id) filter
        (where e.quartile >= 1 or e.event_type = 'video_completed'))::integer,
      (count(distinct e.user_id) filter
        (where e.quartile >= 2 or e.event_type = 'video_completed'))::integer,
      (count(distinct e.user_id) filter
        (where e.quartile >= 3 or e.event_type = 'video_completed'))::integer,
      (count(distinct e.user_id) filter
        (where e.quartile >= 4 or e.event_type = 'video_completed'))::integer,
      (count(distinct e.user_id) filter
        (where e.event_type = 'video_completed'))::integer
    from public.learning_events e
    where e.publication_id = pub.id
      and e.event_type in ('video_progress','video_completed')
      and e.block_id is not null
    group by e.block_id;
  end loop;

  -- 3e. Learner flags (course-level, CURRENT state — recomputed whole).
  -- Thresholds mirrored in lib/analytics/flags.ts: 7 days / 2 attempts / 60%.
  delete from public.learner_flags where course_id = cid;

  insert into public.learner_flags (course_id, user_id, flag_type, detail)
  select cid, e.user_id, 'inactive_7d_incomplete',
    jsonb_build_object(
      'lastActivityAt', coalesce(la.last, e.enrolled_at),
      'completedLessons', coalesce(cl.n, 0),
      'totalLessons', tl.n
    )
  from public.enrollments e
  cross join lateral (
    select count(*)::integer as n
    from public.course_publications p,
         jsonb_array_elements(p.snapshot->'modules') m(value),
         jsonb_array_elements(m.value->'lessons') l(value)
    where p.course_id = cid and p.status = 'live'
  ) tl
  left join lateral (
    select max(lp.last_activity_at) as last
    from public.learn_progress lp
    where lp.course_id = cid and lp.user_id = e.user_id
  ) la on true
  left join lateral (
    select count(*)::integer as n
    from public.learn_progress lp
    where lp.course_id = cid and lp.user_id = e.user_id
      and lp.status = 'completed'
  ) cl on true
  where e.course_id = cid
    and e.status = 'active'  -- 'completed' isn't stuck; 'dropped' left on purpose
    and coalesce(la.last, e.enrolled_at) < now() - interval '7 days';

  insert into public.learner_flags (course_id, user_id, flag_type, detail)
  select cid, f.user_id, 'repeated_quiz_failure',
    jsonb_build_object('quizzes', jsonb_agg(jsonb_build_object(
      'blockId', f.block_id,
      'failedAttempts', f.failed,
      'lastScorePct', f.last_pct)))
  from (
    select a.user_id, a.block_id, count(*)::integer as failed,
           round(100.0 * (array_agg(a.score order by a.submitted_at desc))[1]
                 / nullif((array_agg(a.max_score order by a.submitted_at desc))[1], 0))
             as last_pct
    from public.quiz_attempts a
    where a.course_id = cid
      and a.score::numeric / a.max_score < 0.60
    group by a.user_id, a.block_id
    having count(*) >= 2
  ) f
  group by f.user_id;
end;
$$;

-- ─────────────── 4. Author-gated manual refresh ("refresh now") ────────────
create function public.refresh_course_analytics(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  perform 1 from public.courses where id = cid and author_id = v_uid;
  if not found then
    raise exception 'not the course author';
  end if;
  perform private.recompute_course_analytics(cid);
end;
$$;
revoke all on function public.refresh_course_analytics(uuid) from public, anon;
grant execute on function public.refresh_course_analytics(uuid) to authenticated;

-- ───────────────────── 5. Nightly refresh (all courses) ────────────────────
create function private.refresh_all_course_analytics()
returns void language plpgsql security definer set search_path = public as $$
declare
  c record;
begin
  for c in
    select distinct course_id from public.course_publications
  loop
    perform private.recompute_course_analytics(c.course_id);
  end loop;
end;
$$;

-- ───────────────── 6. Dashboard read RPCs (author-gated) ───────────────────
-- SECURITY DEFINER because they cross RLS boundaries PostgREST can't compose:
-- auth.users.email + profiles + cross-user aggregation (mirrors my_learning).

create function public.course_analytics_overview(cid uuid)
returns jsonb language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  perform 1 from public.courses where id = cid and author_id = v_uid;
  if not found then
    raise exception 'not the course author';
  end if;

  return jsonb_build_object(
    'totalEnrollments',
      (select count(*) from public.enrollments e where e.course_id = cid),
    'activeEnrollments',
      (select count(*) from public.enrollments e
        where e.course_id = cid and e.status = 'active'),
    'completedEnrollments',
      (select count(*) from public.enrollments e
        where e.course_id = cid and e.status = 'completed'),
    'active7d',
      (select count(distinct lp.user_id) from public.learn_progress lp
        where lp.course_id = cid
          and lp.last_activity_at > now() - interval '7 days'),
    'enrollmentsByDay', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'count', d.n)
                       order by d.day)
      from (
        select (date_trunc('day', enrolled_at))::date as day,
               count(*)::integer as n
        from public.enrollments where course_id = cid group by 1
      ) d), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.course_analytics_overview(uuid) from public, anon;
grant execute on function public.course_analytics_overview(uuid) to authenticated;

create function public.course_roster(cid uuid)
returns table (
  user_id           uuid,
  display_name      text,
  email             text,
  enrolled_at       timestamptz,
  enrollment_status text,
  progress_pct      numeric,
  completed_lessons integer,
  total_lessons     integer,
  last_activity_at  timestamptz,
  flags             jsonb
) language plpgsql security definer stable set search_path = public as $$
declare
  v_uid   uuid := (select auth.uid());
  v_total integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  perform 1 from public.courses c where c.id = cid and c.author_id = v_uid;
  if not found then
    raise exception 'not the course author';
  end if;

  select count(*)::integer into v_total
  from public.course_publications p,
       jsonb_array_elements(p.snapshot->'modules') m(value),
       jsonb_array_elements(m.value->'lessons') l(value)
  where p.course_id = cid and p.status = 'live';

  return query
  select
    e.user_id,
    coalesce(pr.display_name, 'Learner'),
    coalesce(u.email::text, ''),
    e.enrolled_at,
    e.status,
    case when v_total > 0
         then round(coalesce(sum(lp.pct), 0) / v_total, 1)
         else 0::numeric end,
    (count(lp.id) filter (where lp.status = 'completed'))::integer,
    v_total,
    max(lp.last_activity_at),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', lf.flag_type, 'detail', lf.detail, 'computedAt', lf.computed_at))
      from public.learner_flags lf
      where lf.course_id = cid and lf.user_id = e.user_id
    ), '[]'::jsonb)
  from public.enrollments e
  left join public.profiles pr on pr.id = e.user_id
  left join auth.users u on u.id = e.user_id
  left join public.learn_progress lp
    on lp.course_id = cid and lp.user_id = e.user_id
  where e.course_id = cid
  group by e.user_id, pr.display_name, u.email, e.enrolled_at, e.status
  order by e.enrolled_at desc;
end;
$$;
revoke all on function public.course_roster(uuid) from public, anon;
grant execute on function public.course_roster(uuid) to authenticated;

-- ───────────────────────────── 7. pg_cron ──────────────────────────────────
create extension if not exists pg_cron;
select cron.schedule(
  'nightly-analytics-rollup',
  '0 3 * * *',
  $$ select private.refresh_all_course_analytics(); $$
);

-- ──────────────── 8. Rebrand straggler (marketplace fallback) ──────────────
-- The creator-name fallback still said "CourseGen"; the product is WiseSel.
create or replace function public.marketplace_listings()
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
  published_at   timestamptz
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
    p.published_at
  from public.course_publications p
  left join public.profiles pr on pr.id = p.created_by
  where p.status = 'live' and p.visibility = 'public'
  order by p.published_at desc;
$$;
