-- PERF-1 C1 — /studio/[courseId]/analytics bundle RPCs
-- (docs/perf/PERF-1_diagnosis.md §A2 "analytics ~20 round trips, 4 serial
-- waves; every ?tab= re-runs all of it").
--
-- Two SECURITY DEFINER read bundles replace the page's fan-out so each view
-- is ONE data round trip (+ the immutable-snapshot cache read):
--
--   1. course_analytics_bundle(p_course_id, p_tab, p_reviews_from)
--      — everything one dashboard tab renders, and ONLY that tab. Shared
--      envelope: course {id,title}, live publication {id,version,slug} | null,
--      stuck_count (the tab-nav badge renders on EVERY tab) and computed_at
--      (the header's "rollups refreshed" line, ditto). Per-tab payloads read
--      the SAME rollup tables / definer RPCs the page used to query directly
--      (course_analytics_overview / course_roster are STABLE definer —
--      composition is fine). The Stuck queue's suppression read mirrors the
--      old admin-client lookup (author-gated above, like the enrollment
--      opt-out flags beside it — advisory only; the send seam re-checks).
--
--   2. learner_detail_bundle(p_course_id, p_user_id, p_before)
--      — the learner-detail page. The single learner's roster computation is
--      filtered INSIDE (the page used to recompute the whole course_roster to
--      .find() one row); the raw-event timeline switches from OFFSET to a
--      KEYSET page on the (user_id, course_id, server_ts) index; the
--      heartbeat count rides learning_events_user_course_type_idx
--      (20260717100000).
--
-- Both: STABLE, search_path pinned, auth.uid() pinned once, authorization
-- INSIDE (author check → null so the page 404s without distinguishing
-- not-found from not-author), jsonb built with jsonb_build_object/jsonb_agg
-- (empty arrays coalesced to '[]'::jsonb), revoked from public+anon.

-- ───────────────── 1. course_analytics_bundle ──────────────────────────────

create function public.course_analytics_bundle(
  p_course_id    uuid,
  p_tab          text,
  p_reviews_from integer default 0
) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_uid    uuid := (select auth.uid());
  v_course record;
  v_pub    record;
  v_result jsonb;
  v_funnel jsonb;
  v_roster jsonb;
begin
  if v_uid is null then
    return null;
  end if;
  if p_tab not in ('overview', 'content', 'learners', 'stuck') then
    raise exception 'unknown tab %', p_tab;
  end if;

  select c.id, c.title into v_course
  from public.courses c
  where c.id = p_course_id and c.author_id = v_uid;
  if not found then
    return null; -- not the author (or no such course) → the page 404s
  end if;

  select p.id, p.version, p.slug into v_pub
  from public.course_publications p
  where p.course_id = p_course_id and p.status = 'live';

  -- Shared envelope (every tab renders the header + the tab-nav badge).
  v_result := jsonb_build_object(
    'course', jsonb_build_object('id', v_course.id, 'title', v_course.title),
    'publication', case when v_pub.id is null then null
      else jsonb_build_object(
        'id', v_pub.id, 'version', v_pub.version, 'slug', v_pub.slug) end,
    'stuck_count', (
      select count(distinct lf.user_id)::integer
      from public.learner_flags lf where lf.course_id = p_course_id),
    'computed_at', (
      select max(f.computed_at)
      from public.rollup_lesson_funnel f where f.publication_id = v_pub.id)
  );

  if v_pub.id is null then
    return v_result; -- no live publication → the page's empty state
  end if;

  if p_tab in ('overview', 'content') then
    select coalesce(jsonb_agg(to_jsonb(f) order by f.lesson_order), '[]'::jsonb)
      into v_funnel
    from public.rollup_lesson_funnel f
    where f.publication_id = v_pub.id;
  end if;

  if p_tab in ('learners', 'stuck') then
    -- Existing definer RPC, called as the SAME author — order preserved.
    select coalesce(jsonb_agg(to_jsonb(r) order by r.enrolled_at desc), '[]'::jsonb)
      into v_roster
    from public.course_roster(p_course_id) r;
  end if;

  if p_tab = 'overview' then
    v_result := v_result || jsonb_build_object(
      'funnel', v_funnel,
      'overview', public.course_analytics_overview(p_course_id),
      'reviews_rollup', (
        select jsonb_build_object(
          'review_count', rr.review_count,
          'avg_rating', rr.avg_rating,
          'rating_distribution', coalesce(rr.rating_distribution, '{}'::jsonb))
        from public.rollup_course_reviews rr
        where rr.course_id = p_course_id),
      -- One page of recent review text (10 + the from offset; the 11th row is
      -- the has_more probe — the page's old .range(from, from+10) contract).
      -- display_name rides along so the card labels reviewers without the
      -- roster (the old page derived names from the full roster fetch).
      'reviews', (
        select jsonb_build_object(
          'rows', coalesce(jsonb_agg(jsonb_build_object(
            'id', s.id,
            'user_id', s.user_id,
            'rating', s.rating,
            'review_text', s.review_text,
            'updated_at', s.updated_at,
            'display_name', coalesce(pr.display_name, 'Learner')
          ) order by s.updated_at desc) filter (where s.rn <= 10), '[]'::jsonb),
          'has_more', count(*) > 10)
        from (
          select t.*, row_number() over (order by t.updated_at desc) as rn
          from (
            select cr.id, cr.user_id, cr.rating, cr.review_text, cr.updated_at
            from public.course_reviews cr
            where cr.course_id = p_course_id
            order by cr.updated_at desc
            offset greatest(coalesce(p_reviews_from, 0), 0) limit 11
          ) t
        ) s
        left join public.profiles pr on pr.id = s.user_id)
    );

  elsif p_tab = 'content' then
    v_result := v_result || jsonb_build_object(
      'funnel', v_funnel,
      'questions', coalesce((
        select jsonb_agg(to_jsonb(q))
        from public.rollup_question_stats q
        where q.publication_id = v_pub.id), '[]'::jsonb),
      'dwell', coalesce((
        select jsonb_agg(to_jsonb(d))
        from public.rollup_slide_dwell d
        where d.publication_id = v_pub.id), '[]'::jsonb),
      'video', coalesce((
        select jsonb_agg(to_jsonb(v))
        from public.rollup_video_retention v
        where v.publication_id = v_pub.id), '[]'::jsonb),
      'feedback', coalesce((
        select jsonb_agg(to_jsonb(cf))
        from public.rollup_content_feedback cf
        where cf.publication_id = v_pub.id), '[]'::jsonb)
    );

  elsif p_tab = 'learners' then
    v_result := v_result || jsonb_build_object('roster', v_roster);

  else -- 'stuck'
    v_result := v_result || jsonb_build_object(
      'roster', v_roster,
      'flags', coalesce((
        select jsonb_agg(to_jsonb(lf))
        from public.learner_flags lf
        where lf.course_id = p_course_id), '[]'::jsonb),
      'opt_outs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'user_id', e.user_id, 'comms_opt_out', e.comms_opt_out))
        from public.enrollments e
        where e.course_id = p_course_id), '[]'::jsonb),
      -- Each learner's latest check-in (the M8 measurement hook): the page
      -- used to fetch EVERY learner_messages row and reduce in JS.
      'last_messages', coalesce((
        select jsonb_agg(to_jsonb(lm))
        from (
          select distinct on (m.user_id)
            m.user_id, m.status, m.delivery_status, m.sent_at, m.created_at
          from public.learner_messages m
          where m.course_id = p_course_id
          order by m.user_id, m.created_at desc
        ) lm), '[]'::jsonb),
      -- Advisory suppression flags (M7). comms_suppressions is RLS-on with
      -- ZERO policies (server-only); this definer read is author-gated above
      -- and returns only the enrolled learners' rows — the same set the old
      -- admin-client lookup returned. The send seam re-checks at send time.
      'suppressions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'user_id', cs.user_id, 'reason', cs.reason))
        from public.comms_suppressions cs
        where cs.user_id in (
          select e.user_id from public.enrollments e
          where e.course_id = p_course_id)), '[]'::jsonb)
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.course_analytics_bundle(uuid, text, integer) from public, anon;
grant execute on function public.course_analytics_bundle(uuid, text, integer) to authenticated;

-- ───────────────── 2. learner_detail_bundle ────────────────────────────────

create function public.learner_detail_bundle(
  p_course_id uuid,
  p_user_id   uuid,
  p_before    timestamptz default null
) returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_uid    uuid := (select auth.uid());
  v_course record;
  v_pub    record;
  v_total  integer;
begin
  if v_uid is null then
    return null;
  end if;

  select c.id, c.title into v_course
  from public.courses c
  where c.id = p_course_id and c.author_id = v_uid;
  if not found then
    return null;
  end if;

  select p.id, p.version, p.slug into v_pub
  from public.course_publications p
  where p.course_id = p_course_id and p.status = 'live';

  -- Total lessons for the roster math: the persisted publish-time column
  -- (20260717100200), with the roster RPC's snapshot expansion as the
  -- pre-backfill fallback — identical values by construction.
  select coalesce(p.lesson_count, (
      select count(*)::integer
      from jsonb_array_elements(p.snapshot->'modules') m(value),
           jsonb_array_elements(m.value->'lessons') l(value)
    ))
  into v_total
  from public.course_publications p
  where p.course_id = p_course_id and p.status = 'live';

  return jsonb_build_object(
    'course', jsonb_build_object('id', v_course.id, 'title', v_course.title),
    'publication', case when v_pub.id is null then null
      else jsonb_build_object(
        'id', v_pub.id, 'version', v_pub.version, 'slug', v_pub.slug) end,

    -- The ONE learner's roster row — course_roster's exact per-learner
    -- computation (display name / email / pct / completed / flags), filtered
    -- to p_user_id instead of computing the whole roster. Null when the
    -- learner isn't enrolled → the page 404s.
    'roster_row', (
      select jsonb_build_object(
        'user_id', e.user_id,
        'display_name', coalesce(pr.display_name, 'Learner'),
        'email', coalesce(u.email::text, ''),
        'enrolled_at', e.enrolled_at,
        'enrollment_status', e.status,
        'progress_pct', case when coalesce(v_total, 0) > 0
          then round(coalesce(lp_agg.pct_sum, 0) / v_total, 1)
          else 0::numeric end,
        'completed_lessons', coalesce(lp_agg.completed, 0),
        'total_lessons', coalesce(v_total, 0),
        'last_activity_at', lp_agg.last_activity,
        'flags', coalesce((
          select jsonb_agg(jsonb_build_object(
            'type', lf.flag_type, 'detail', lf.detail, 'computedAt', lf.computed_at))
          from public.learner_flags lf
          where lf.course_id = p_course_id and lf.user_id = p_user_id), '[]'::jsonb))
      from public.enrollments e
      left join public.profiles pr on pr.id = e.user_id
      left join auth.users u on u.id = e.user_id
      left join lateral (
        select sum(lp.pct) as pct_sum,
               (count(lp.id) filter (where lp.status = 'completed'))::integer as completed,
               max(lp.last_activity_at) as last_activity
        from public.learn_progress lp
        where lp.course_id = p_course_id and lp.user_id = e.user_id
      ) lp_agg on true
      where e.course_id = p_course_id and e.user_id = p_user_id),

    'progress', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lesson_id', lp.lesson_id, 'status', lp.status, 'pct', lp.pct,
        'last_activity_at', lp.last_activity_at))
      from public.learn_progress lp
      where lp.course_id = p_course_id and lp.user_id = p_user_id), '[]'::jsonb),

    -- Newest 25 attempts, each with its nested responses (the page used to
    -- fetch every attempt ever). attempt_count keeps the header Stat exact.
    'attempts', coalesce((
      select jsonb_agg(
        to_jsonb(a) || jsonb_build_object('question_responses', qr.responses)
        order by a.submitted_at desc)
      from (
        select * from public.quiz_attempts qa
        where qa.course_id = p_course_id and qa.user_id = p_user_id
        order by qa.submitted_at desc
        limit 25
      ) a
      left join lateral (
        select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as responses
        from public.question_responses r
        where r.attempt_id = a.id
      ) qr on true), '[]'::jsonb),
    'attempt_count', (
      select count(*)::integer from public.quiz_attempts qa
      where qa.course_id = p_course_id and qa.user_id = p_user_id),

    -- KEYSET timeline page (newest first): 50 + the has_more probe row, on
    -- the (user_id, course_id, server_ts) index. Only the columns the
    -- timeline renders.
    'events', coalesce((
      select jsonb_agg(to_jsonb(ev) order by ev.server_ts desc)
      from (
        select le.id, le.event_type, le.lesson_id, le.block_id,
               le.dwell_ms, le.quartile, le.server_ts
        from public.learning_events le
        where le.user_id = p_user_id and le.course_id = p_course_id
          and le.server_ts < coalesce(p_before, 'infinity'::timestamptz)
        order by le.server_ts desc
        limit 51
      ) ev), '[]'::jsonb),
    'heartbeat_count', (
      select count(*)::integer from public.learning_events le
      where le.user_id = p_user_id and le.course_id = p_course_id
        and le.event_type = 'session_heartbeat'),

    'flags', coalesce((
      select jsonb_agg(to_jsonb(lf))
      from public.learner_flags lf
      where lf.course_id = p_course_id and lf.user_id = p_user_id), '[]'::jsonb),

    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'subject', m.subject, 'status', m.status,
        'delivery_status', m.delivery_status, 'sent_at', m.sent_at,
        'created_at', m.created_at) order by m.created_at desc)
      from public.learner_messages m
      where m.course_id = p_course_id and m.user_id = p_user_id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.learner_detail_bundle(uuid, uuid, timestamptz) from public, anon;
grant execute on function public.learner_detail_bundle(uuid, uuid, timestamptz) to authenticated;
