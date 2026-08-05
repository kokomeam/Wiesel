-- WiseSel — TUTOR-1 Wave 5 (P5.3): Creator Tutor Console ANALYTICS — bad-lesson
-- detection + most-missed questions.
--
-- Two author-gated definer READ RPCs + one rollup table + its DETERMINISTIC
-- recompute. Everything a creator reads here is an AGGREGATE; the raw learner
-- tables (quiz_attempt_detail — ZERO-policy; mastery_course_aggregate —
-- ZERO-policy) are read ONLY inside definer functions that emit floored
-- aggregates, never a learner row (Amendment D-4, the cohort floor is 5).
--
-- ── Objects ──
--   1. most_missed_questions(p_course_id)   — author-gated definer, jsonb. Per
--      question with >= 5 DISTINCT learners (below floor → OMITTED): first- vs
--      second-attempt error rate (ordinal DERIVED from quiz_attempt_detail by
--      (created_at, id) per learner+block), distinct_learner_count, per-option
--      selection counts (distractor view), mapped concept node ids, teaching-slide
--      deep link. Ranked by first_attempt_error_rate desc.
--   2. rollup_lesson_health                 — per (publication, lesson) composite
--      rollup. NO learner identity — only per-lesson aggregates → an author-select
--      semi-join policy is SAFE here (see the note on the policy). The 5 raw inputs
--      are themselves derived from already-floored / already-aggregated rollups.
--   3. private.recompute_lesson_health(cid) — DETERMINISTIC weighted composite over
--      the 5 normalized inputs. Weights are NAMED SQL constants (documented in
--      docs/tutor/analytics.md, mirrored + drift-guarded in lib/analytics/
--      lessonHealth.ts). rationale left NULL — a nightly Inngest Terra step fills it.
--   4. lesson_health(p_course_id)           — author-gated definer read of the
--      rollup, ranked by composite_score desc.
--
-- Nightly wiring is a NEW Inngest function (tutorLessonHealthNightly, cron
-- '0 5 * * *') registered in app/api/inngest/route.ts — NOT a pg_cron job — so the
-- Terra rationale step lives beside the deterministic recompute in one durable fn.

-- ─────────────────────────── 1. most_missed_questions ───────────────────────
-- COHORT-FLOORED: a question answered by < 5 DISTINCT learners is suppressed
-- (omitted from the result entirely — no count, no rates). The definer bypasses
-- quiz_attempt_detail's ZERO-policy RLS but emits ONLY per-question aggregates.
--
-- Attempt ordinal is DERIVED here (never stored): per (user, block) the rows are
-- ordered by (created_at, id); ordinal 1 = first attempt, 2 = second. A question's
-- first_attempt_error_rate = share of learners WRONG on their ordinal-1 row;
-- second_attempt_error_rate = share wrong on ordinal-2 (over learners who reached a
-- 2nd attempt). per_option = selection counts over EVERY attempt (the distractor
-- view), read from response_summary's selected ids.
create function public.most_missed_questions(p_course_id uuid)
returns jsonb language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  -- Author gate: a non-author (or a missing course) gets NULL — never a leak.
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.author_id = v_uid
  ) then
    raise exception 'not the course author';
  end if;

  with
  -- The live publication pins the block→lesson map + published question objectives.
  live_pub as (
    select p.id, p.snapshot
    from public.course_publications p
    where p.course_id = p_course_id and p.status = 'live'
    limit 1
  ),
  -- Per (learner, block, question) rows WITH the derived attempt ordinal.
  ordinal_rows as (
    select
      d.user_id, d.block_id, d.question_id, d.correct, d.response_summary,
      row_number() over (
        partition by d.user_id, d.block_id, d.question_id
        order by d.created_at, d.id
      ) as attempt_ordinal
    from public.quiz_attempt_detail d
    join live_pub lp on lp.id = d.publication_id
    where d.course_id = p_course_id
  ),
  -- Cohort floor: distinct learners per question.
  learner_counts as (
    select block_id, question_id, count(distinct user_id)::integer as distinct_learner_count
    from ordinal_rows
    group by block_id, question_id
  ),
  -- First-attempt error rate (share wrong on ordinal 1).
  first_attempt as (
    select block_id, question_id,
      avg(case when correct then 0.0 else 1.0 end)::numeric as first_attempt_error_rate
    from ordinal_rows
    where attempt_ordinal = 1
    group by block_id, question_id
  ),
  -- Second-attempt error rate (share wrong on ordinal 2, over learners who retried).
  second_attempt as (
    select block_id, question_id,
      avg(case when correct then 0.0 else 1.0 end)::numeric as second_attempt_error_rate
    from ordinal_rows
    where attempt_ordinal = 2
    group by block_id, question_id
  ),
  -- Per-option selection counts (the distractor view) over EVERY attempt. The
  -- selected ids live in response_summary as {selected} (mc/tf) or {selected:[…]}
  -- (ms) or {text} (sa). We expand mc/tf/ms selections; sa is text (no options).
  option_selections as (
    select block_id, question_id, opt, count(*)::integer as n
    from (
      -- mc / tf: a single scalar `selected`.
      select block_id, question_id, (response_summary->>'selected') as opt
      from ordinal_rows
      where response_summary ? 'selected'
        and jsonb_typeof(response_summary->'selected') <> 'array'
        and (response_summary->>'selected') is not null
      union all
      -- ms: an array `selected`.
      select r.block_id, r.question_id, sel.value as opt
      from ordinal_rows r,
           lateral jsonb_array_elements_text(
             case when jsonb_typeof(r.response_summary->'selected') = 'array'
                  then r.response_summary->'selected' else '[]'::jsonb end
           ) sel(value)
    ) x
    group by block_id, question_id, opt
  ),
  per_option as (
    select block_id, question_id,
      jsonb_agg(jsonb_build_object('option', opt, 'count', n) order by n desc) as per_option
    from option_selections
    group by block_id, question_id
  ),
  -- Map each block → its lesson + published question objectives + slide anchors,
  -- from the live snapshot. The block→lesson map + a question's objectiveId (the
  -- R-13 concept anchor) come from the published snapshot.
  snapshot_blocks as (
    select
      (b.value->>'id')::uuid              as block_id,
      (l.value->>'id')::uuid              as lesson_id,
      q.value->>'id'                      as question_id,
      q.value->>'objectiveId'             as objective_id
    from live_pub lp,
         jsonb_array_elements(lp.snapshot->'modules')      m(value),
         jsonb_array_elements(m.value->'lessons')          l(value),
         jsonb_array_elements(l.value->'blocks')           b(value),
         jsonb_array_elements(coalesce(b.value->'questions', '[]'::jsonb)) q(value)
    where b.value->>'type' = 'quiz'
  ),
  -- Map a question's objectiveId → concept node ids (a node whose anchors reference
  -- this block, OR whose id/alias matches the objectiveId). We anchor by block:
  -- concept nodes whose anchors[].blockId = the question's block.
  block_nodes as (
    select sb.block_id, jsonb_agg(distinct n.id) as node_ids
    from snapshot_blocks sb
    join public.concept_nodes n
      on n.course_id = p_course_id
     and n.status = 'active'
     and exists (
       select 1 from jsonb_array_elements(n.anchors) a(value)
       where (a.value->>'blockId')::uuid = sb.block_id
     )
    group by sb.block_id
  ),
  -- One row per surviving question (>= 5 distinct learners), joined to everything.
  ranked as (
    select
      lc.block_id,
      lc.question_id,
      lc.distinct_learner_count,
      coalesce(fa.first_attempt_error_rate, 0)::numeric  as first_attempt_error_rate,
      sa.second_attempt_error_rate,  -- null when no learner reached a 2nd attempt
      coalesce(po.per_option, '[]'::jsonb)               as per_option,
      sb.lesson_id,
      sb.objective_id,
      coalesce(bn.node_ids, '[]'::jsonb)                 as concept_node_ids
    from learner_counts lc
    left join first_attempt  fa on fa.block_id = lc.block_id and fa.question_id = lc.question_id
    left join second_attempt sa on sa.block_id = lc.block_id and sa.question_id = lc.question_id
    left join per_option     po on po.block_id = lc.block_id and po.question_id = lc.question_id
    left join snapshot_blocks sb on sb.block_id = lc.block_id and sb.question_id = lc.question_id
    left join block_nodes    bn on bn.block_id = lc.block_id
    where lc.distinct_learner_count >= 5  -- cohort floor (Amendment D-4)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'blockId',                 r.block_id,
    'questionId',              r.question_id,
    'lessonId',                r.lesson_id,
    'objectiveId',             r.objective_id,
    'distinctLearnerCount',    r.distinct_learner_count,
    'firstAttemptErrorRate',   r.first_attempt_error_rate,
    'secondAttemptErrorRate',  r.second_attempt_error_rate,
    'perOption',               r.per_option,
    'conceptNodeIds',          r.concept_node_ids,
    -- teaching-slide deep link: lesson + block are enough for DeepLinkFocus.
    'deepLink', jsonb_build_object('lessonId', r.lesson_id, 'blockId', r.block_id)
  ) order by r.first_attempt_error_rate desc, r.question_id)
  , '[]'::jsonb)
  into v_result
  from ranked r;

  return v_result;
end;
$$;
revoke all on function public.most_missed_questions(uuid) from public, anon;
grant execute on function public.most_missed_questions(uuid) to authenticated;

comment on function public.most_missed_questions(uuid) is
  'Author-gated (Wave 5 P5.3). COHORT-FLOORED >= 5 distinct learners per question (sub-floor omitted). Derives first/second attempt error rate from quiz_attempt_detail by (created_at,id) ordinal, per-option distractor counts, concept node ids (via anchors), teaching-slide deep link. Ranked by first_attempt_error_rate desc. Reads ZERO-policy quiz_attempt_detail as definer but emits only aggregates.';

-- ─────────────────────────── 2. rollup_lesson_health ────────────────────────
-- Per (publication, lesson) composite health rollup. Keyed like the analytics
-- rollups. Holds ONLY per-lesson aggregates + a Terra-written rationale — no
-- learner identity — so an author-select semi-join policy is acceptable here (it
-- exposes no individual). We ALSO expose it through the lesson_health definer RPC
-- (below) for consistency with D-4; the loader uses the RPC.
create table public.rollup_lesson_health (
  course_id                uuid not null references public.courses(id) on delete cascade,
  publication_id           uuid not null references public.course_publications(id) on delete cascade,
  version                  integer not null,
  lesson_id                uuid not null,
  -- The 5 normalized inputs (each 0..1, higher = worse), for transparency/UI.
  mastery_shortfall        numeric,
  confusion_density        numeric,
  first_attempt_error_rate numeric,
  rewatch_scrub_density    numeric,
  dropout_after_rate       numeric,
  -- The deterministic weighted composite (0..1, higher = needs more attention).
  composite_score          numeric not null default 0,
  -- Human-readable case, written by the nightly Terra step over the COMPUTED
  -- evidence (never computed/ranked by the model). Nullable — recompute leaves it
  -- null; the Inngest rationale step fills it for the top-N flagged lessons.
  rationale                text,
  computed_at              timestamptz not null default now(),
  primary key (publication_id, lesson_id)
);
create index rollup_lesson_health_course_idx on public.rollup_lesson_health(course_id);

alter table public.rollup_lesson_health enable row level security;
-- Author-select semi-join: the row holds only per-lesson aggregates (no learner
-- identity), so this discloses nothing individual. The lesson_health definer RPC
-- is the loader's path; this policy is the defense-in-depth backstop.
create policy "rollup_lesson_health_select" on public.rollup_lesson_health
  for select using (private.is_course_author(course_id));

-- ─────────────────────── 3. private.recompute_lesson_health ─────────────────
-- DETERMINISTIC composite. The 5 inputs are normalized to 0..1 (higher = worse)
-- and combined by a fixed weighted sum. The WEIGHTS are named constants declared
-- once here (v_w_*) and MIRRORED in lib/analytics/lessonHealth.ts (drift-guarded
-- by scripts/verify-tutor-analytics-console.ts). The model never computes or ranks
-- — it only writes `rationale` later.
--
-- Input derivations (all from already-aggregated / already-floored rollups):
--   • first_attempt_error_rate — mean over the lesson's questions of
--     (1 - pct_correct/100) from rollup_question_stats (n>0).
--   • confusion_density        — the lesson-level rollup_content_feedback
--     confusing_pct/100 (slide_id null row = lesson aggregate).
--   • dropout_after_rate       — rollup_lesson_funnel.dropoff_pct (already 0..1;
--     the drop entering THIS lesson vs the previous).
--   • rewatch_scrub_density    — a dwell/retention skim-or-stall proxy: for a
--     lesson with video, the share of viewers who did NOT reach q4
--     (1 - q4/viewers) from rollup_video_retention (mean over the lesson's videos);
--     0 when the lesson has no video (no signal).
--   • mastery_shortfall        — mean over the lesson's ANCHORED concept nodes of
--     (below_threshold_count / learner_count) from mastery_course_aggregate,
--     COHORT-FLOORED to nodes with learner_count >= 5 (sub-floor nodes contribute
--     nothing — the floor is applied INSIDE this definer, the table is ZERO-policy).
create function private.recompute_lesson_health(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  pub record;
  -- ── COMPOSITE WEIGHTS (single source of truth; mirrored in TS + drift-guarded).
  -- Sum = 1.0. Ordered by the product signal each input carries.
  v_w_mastery_shortfall        constant numeric := 0.30;
  v_w_first_attempt_error_rate constant numeric := 0.25;
  v_w_confusion_density        constant numeric := 0.20;
  v_w_dropout_after_rate       constant numeric := 0.15;
  v_w_rewatch_scrub_density    constant numeric := 0.10;
begin
  for pub in
    select id, version from public.course_publications where course_id = cid
  loop
    delete from public.rollup_lesson_health where publication_id = pub.id;

    insert into public.rollup_lesson_health (
      course_id, publication_id, version, lesson_id,
      mastery_shortfall, confusion_density, first_attempt_error_rate,
      rewatch_scrub_density, dropout_after_rate, composite_score
    )
    with
    -- Every lesson that has ANY rollup signal for this publication.
    lessons as (
      select distinct lesson_id from public.rollup_lesson_funnel where publication_id = pub.id
      union
      select distinct lesson_id from public.rollup_question_stats where publication_id = pub.id
      union
      select distinct lesson_id from public.rollup_content_feedback where publication_id = pub.id
      union
      select distinct lesson_id from public.rollup_video_retention where publication_id = pub.id
    ),
    fa as (
      select lesson_id, avg(1 - coalesce(pct_correct, 0) / 100.0)::numeric as v
      from public.rollup_question_stats
      where publication_id = pub.id and n > 0
      group by lesson_id
    ),
    conf as (
      -- lesson-level row = slide_id null.
      select lesson_id, (coalesce(confusing_pct, 0) / 100.0)::numeric as v
      from public.rollup_content_feedback
      where publication_id = pub.id and slide_id is null
    ),
    drop_after as (
      select lesson_id, coalesce(dropoff_pct, 0)::numeric as v
      from public.rollup_lesson_funnel
      where publication_id = pub.id
    ),
    rewatch as (
      select lesson_id,
        avg(case when viewers > 0 then (1 - q4_count::numeric / viewers) else 0 end)::numeric as v
      from public.rollup_video_retention
      where publication_id = pub.id
      group by lesson_id
    ),
    -- mastery shortfall per lesson: mean over the lesson's anchored concept nodes
    -- of below_threshold_count / learner_count, COHORT-FLOORED to nodes >= 5.
    lesson_nodes as (
      select distinct
        (a.value->>'lessonId')::uuid as lesson_id,
        n.id                         as node_id
      from public.concept_nodes n,
           lateral jsonb_array_elements(n.anchors) a(value)
      where n.course_id = cid and n.status = 'active'
        and a.value ? 'lessonId'
    ),
    mastery as (
      select ln.lesson_id,
        avg(ma.below_threshold_count::numeric / nullif(ma.learner_count, 0))::numeric as v
      from lesson_nodes ln
      join public.mastery_course_aggregate ma
        on ma.course_id = cid and ma.node_id = ln.node_id
       and ma.learner_count >= 5  -- cohort floor (Amendment D-4)
      group by ln.lesson_id
    )
    select
      cid, pub.id, pub.version, le.lesson_id,
      coalesce(mastery.v, 0),
      coalesce(conf.v, 0),
      coalesce(fa.v, 0),
      coalesce(rewatch.v, 0),
      coalesce(drop_after.v, 0),
      round((
        v_w_mastery_shortfall        * coalesce(mastery.v, 0) +
        v_w_first_attempt_error_rate * coalesce(fa.v, 0) +
        v_w_confusion_density        * coalesce(conf.v, 0) +
        v_w_dropout_after_rate       * coalesce(drop_after.v, 0) +
        v_w_rewatch_scrub_density    * coalesce(rewatch.v, 0)
      )::numeric, 6)
    from lessons le
    left join fa         on fa.lesson_id = le.lesson_id
    left join conf       on conf.lesson_id = le.lesson_id
    left join drop_after on drop_after.lesson_id = le.lesson_id
    left join rewatch    on rewatch.lesson_id = le.lesson_id
    left join mastery    on mastery.lesson_id = le.lesson_id;
  end loop;
end;
$$;

comment on function private.recompute_lesson_health(uuid) is
  'DETERMINISTIC per-lesson composite (Wave 5 P5.3). Weighted sum of 5 normalized inputs (weights = named constants, mirrored + drift-guarded in lib/analytics/lessonHealth.ts). rationale left null — a nightly Terra step fills it. Mastery input cohort-floored >= 5 inside this definer.';

-- ─────────── 3b. recompute_lesson_health_admin (service-role entry point) ────
-- private.recompute_lesson_health is not on the PostgREST rpc surface (private
-- schema). The nightly Inngest function runs as SERVICE ROLE and needs one entry
-- point; this thin definer wrapper is granted to service_role ONLY (revoked from
-- public/anon/authenticated) — a creator refreshes through the analytics
-- refresh_course_analytics flow, never this. Mirrors refresh_all_course_analytics.
create function public.recompute_lesson_health_admin(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform private.recompute_lesson_health(cid);
end;
$$;
revoke all on function public.recompute_lesson_health_admin(uuid) from public, anon, authenticated;
grant execute on function public.recompute_lesson_health_admin(uuid) to service_role;

comment on function public.recompute_lesson_health_admin(uuid) is
  'Service-role-only entry point to private.recompute_lesson_health (Wave 5 P5.3 nightly Inngest). Revoked from public/anon/authenticated.';

-- ─────────────────────── 4. lesson_health (author read RPC) ─────────────────
-- Author-gated definer read of the rollup, ranked by composite_score desc.
create function public.lesson_health(p_course_id uuid)
returns jsonb language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.author_id = v_uid
  ) then
    raise exception 'not the course author';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'lessonId',               h.lesson_id,
    'compositeScore',         h.composite_score,
    'masteryShortfall',       h.mastery_shortfall,
    'confusionDensity',       h.confusion_density,
    'firstAttemptErrorRate',  h.first_attempt_error_rate,
    'rewatchScrubDensity',    h.rewatch_scrub_density,
    'dropoutAfterRate',       h.dropout_after_rate,
    'rationale',              h.rationale,
    'computedAt',             h.computed_at
  ) order by h.composite_score desc, h.lesson_id), '[]'::jsonb)
  into v_result
  from public.rollup_lesson_health h
  join public.course_publications p
    on p.id = h.publication_id and p.status = 'live'
  where h.course_id = p_course_id;

  return v_result;
end;
$$;
revoke all on function public.lesson_health(uuid) from public, anon;
grant execute on function public.lesson_health(uuid) to authenticated;

comment on function public.lesson_health(uuid) is
  'Author-gated (Wave 5 P5.3) read of rollup_lesson_health for the LIVE publication, ranked by composite_score desc. Per-lesson aggregates + Terra rationale only — no learner identity.';
