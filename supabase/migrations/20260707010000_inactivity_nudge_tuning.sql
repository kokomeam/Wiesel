-- WiseSel — Milestone 8 (Engagement & Retention wave): inactivity-nudge tuning.
--
-- The Task-0 audit found the inactivity signal already exists end-to-end
-- (flag → filed finding → Analyst pickup → stalled_nudge template → approval
-- flow), so M8 is a TUNING pass, not a parallel system:
--
--   1. Threshold 7 → 4 days (dropout concentrates in week one) and the flag
--      RENAMED inactive_7d_incomplete → inactive_incomplete (the old name
--      baked the threshold into the identifier; at 4 days it would lie).
--      Mirrored constants live in lib/analytics/flags.ts (INACTIVE_DAYS = 4,
--      NUDGE_COOLDOWN_DAYS = 14) — verify-analytics.ts drift-guards THIS file.
--   2. Learner-flag computation EXTRACTED into private.recompute_learner_flags
--      so future flag tuning never restates the big rollup function again.
--   3. file_threshold_findings gains the nudge guards where flags become
--      draft-producing findings: skip opted-out learners, skip suppressed
--      learners (M7), and a 14-day cooldown vs learner_messages (one check-in
--      per silence, not a drumbeat — nightly re-filing after a draft flipped
--      the old row to 'proposed' used to re-nudge every run). The dashboard
--      Stuck queue still SHOWS every stuck learner (creator visibility +
--      manual outreach stay unrestricted); only the automatic filing is
--      guarded.
--   4. Learner-risk findings are now filed ONE PER LEARNER with dedupe key
--      'learner_risk:<userId>' — the SAME key lib/ai/maintenanceSchema.ts
--      dedupeKeyForFinding() produces, fixing the audit's key-mismatch bug
--      (Analyst adoption never fired for learner risks; one learner could
--      yield multiple findings/drafts in one run). Both flag flavors merge
--      into one finding; repeated_quiz_failure (high) outranks inactivity.
--      Existing OPEN learner_risk rows are collapsed + re-keyed below.

-- ─────────────── 1. learner_flags: rename + document the tuning ─────────────
alter table public.learner_flags drop constraint learner_flags_flag_type_check;
update public.learner_flags
   set flag_type = 'inactive_incomplete'
 where flag_type = 'inactive_7d_incomplete';
alter table public.learner_flags
  add constraint learner_flags_flag_type_check
  check (flag_type in ('inactive_incomplete','repeated_quiz_failure'));

-- ───────── 2. Learner flags extracted (4-day threshold lives HERE) ──────────
-- Thresholds mirrored in lib/analytics/flags.ts: 4 days / 2 attempts / 60%.
create function private.recompute_learner_flags(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- Course-level, CURRENT state — recomputed whole.
  delete from public.learner_flags where course_id = cid;

  insert into public.learner_flags (course_id, user_id, flag_type, detail)
  select cid, e.user_id, 'inactive_incomplete',
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
    and coalesce(la.last, e.enrolled_at) < now() - interval '4 days';

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

-- ───── 3. recompute_course_analytics: 3a–3d verbatim, flags → the extract ───
create or replace function private.recompute_course_analytics(cid uuid)
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

  -- 3e. Learner flags — extracted to private.recompute_learner_flags (M8) so
  -- flag tuning never restates this function again.
  perform private.recompute_learner_flags(cid);
end;
$$;

-- ────── 4. file_threshold_findings: merged learner key + nudge guards ───────
create or replace function private.file_threshold_findings(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- Content issues from the LIVE publication's question stats (unchanged).
  insert into public.agent_findings
    (course_id, kind, severity, dedupe_key, finding)
  select
    cid,
    'content_issue',
    q.severity,
    'question:' || q.question_id,
    jsonb_build_object(
      'id', gen_random_uuid(),
      'kind', 'content_issue',
      'severity', q.severity,
      'title', 'Quiz question flagged by nightly thresholds',
      'evidence', jsonb_build_object(
        'metrics', jsonb_strip_nulls(jsonb_build_object(
          'pctCorrect', q.pct_correct,
          'n', q.n,
          'topDistractorCount', q.top_wrong,
          'keyCount', q.key_count,
          'discrimination', q.discrimination)),
        'summary', array_to_string(q.reasons, ' · ')
      ),
      'targets', jsonb_build_object(
        'lessonId', q.lesson_id, 'blockId', q.block_id,
        'questionId', q.question_id, 'userId', null),
      'recommendation',
        'Review the question wording, the correct answer, and the distractors.'
    )
  from (
    select
      s.question_id, s.block_id, s.lesson_id, s.n, s.pct_correct,
      s.discrimination,
      (select max(value::integer) from jsonb_each_text(s.answer_distribution)
        where key <> s.key_value) as top_wrong,
      coalesce((s.answer_distribution ->> s.key_value)::integer, 0) as key_count,
      case
        when (s.pct_correct < 25 and s.n >= 20) then 'high'
        else 'medium'
      end as severity,
      array_remove(array[
        case when s.pct_correct < 40 and s.n >= 20 then
          format('Only %s%% of %s learners answer correctly', s.pct_correct, s.n) end,
        case when s.key_value is not null and (
            select max(value::integer) from jsonb_each_text(s.answer_distribution)
            where key <> s.key_value
          ) >= 2 * greatest(coalesce((s.answer_distribution ->> s.key_value)::integer, 0), 1)
          then 'A wrong answer is chosen at least twice as often as the key' end,
        case when s.discrimination is not null and s.discrimination < 0.1 then
          format('Discrimination %s — strong and weak learners miss it alike',
                 s.discrimination) end
      ], null) as reasons
    from public.rollup_question_stats s
    join public.course_publications p
      on p.id = s.publication_id and p.status = 'live'
    where s.course_id = cid
  ) q
  where array_length(q.reasons, 1) >= 1
  on conflict (course_id, dedupe_key) where status = 'open' do nothing;

  -- Learner risks: ONE finding per learner (dedupe key matches the TS
  -- dedupeKeyForFinding — 'learner_risk:<userId>' — so Analyst adoption
  -- works; both flag flavors merge, repeated_quiz_failure outranks).
  -- M8 nudge guards: never target opted-out or suppressed learners, and
  -- respect the 14-day cooldown vs learner_messages (any draft/sent message
  -- for this course counts — one check-in per silence, not a drumbeat).
  insert into public.agent_findings
    (course_id, kind, severity, dedupe_key, finding)
  select
    cid,
    'learner_risk',
    f.severity,
    'learner_risk:' || f.user_id,
    jsonb_build_object(
      'id', gen_random_uuid(),
      'kind', 'learner_risk',
      'severity', f.severity,
      'title', f.title,
      'evidence', jsonb_build_object(
        'metrics', '{}'::jsonb,
        'summary', f.summary
      ),
      'targets', jsonb_build_object(
        'lessonId', null, 'blockId', null, 'questionId', null,
        'userId', f.user_id),
      'recommendation', 'Draft a personal check-in for this learner.'
    )
  from (
    select
      lf.user_id,
      case when bool_or(lf.flag_type = 'repeated_quiz_failure')
           then 'high' else 'medium' end as severity,
      case when bool_or(lf.flag_type = 'repeated_quiz_failure')
           then 'A learner keeps failing the same quiz'
           else 'A learner has gone quiet with the course unfinished' end as title,
      -- FindingSchema caps evidence.summary at 500 chars — clamp, don't risk
      -- an unparseable filed row that adoption would silently skip.
      left(string_agg(lf.flag_type || ': ' || lf.detail::text, ' · '), 480) as summary
    from public.learner_flags lf
    where lf.course_id = cid
      and not exists (
        select 1 from public.enrollments en
        where en.course_id = cid and en.user_id = lf.user_id
          and en.comms_opt_out)
      and not exists (
        select 1 from public.comms_suppressions cs
        where cs.user_id = lf.user_id)
      and not exists (
        select 1 from public.learner_messages lm
        where lm.course_id = cid and lm.user_id = lf.user_id
          and lm.created_at > now() - interval '14 days')
    group by lf.user_id
  ) f
  on conflict (course_id, dedupe_key) where status = 'open' do nothing;
end;
$$;

-- ───── 5. Re-key existing OPEN learner_risk findings to the merged scheme ───
-- Collapse per-learner duplicates first (mixed old-scheme flavors and/or an
-- Analyst-keyed row can coexist open today) — keep the newest, dismiss the
-- rest — then re-key the survivor so tonight's filing dedupes against it.
with ranked as (
  select id,
         row_number() over (
           partition by course_id, (finding->'targets'->>'userId')
           order by created_at desc) as rn
  from public.agent_findings
  where kind = 'learner_risk' and status = 'open'
    and (finding->'targets'->>'userId') is not null
)
update public.agent_findings a
   set status = 'dismissed'
  from ranked r
 where a.id = r.id and r.rn > 1;

update public.agent_findings a
   set dedupe_key = 'learner_risk:' || (a.finding->'targets'->>'userId')
 where a.kind = 'learner_risk' and a.status = 'open'
   and (a.finding->'targets'->>'userId') is not null
   and a.dedupe_key <> 'learner_risk:' || (a.finding->'targets'->>'userId');
