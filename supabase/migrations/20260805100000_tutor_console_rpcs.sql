-- WiseSel — TUTOR-1 Wave 5 (P5.1): the Creator Tutor Console read RPC.
--
-- `tutor_console_bundle(p_course_id, p_tab)` is the ONE author-gated definer
-- round trip the console's Overview + Enablement & charter tabs load. It mirrors
-- course_analytics_bundle (20260717100700): SECURITY DEFINER, author-gated (a
-- non-author gets NULL, never an exception → the page 404s), and returns exactly
-- the requested tab's data plus the always-present enablement block the shell +
-- Enablement card need.
--
-- PRIVACY (Amendment D-4, load-bearing): every LEARNER-derived number is
-- cohort-floored ≥5. Here that is the `overview.usage` block — sessions / turns /
-- unique_learners over tutor_threads + tutor_turns (both learner-RLS'd; this
-- definer function bypasses RLS but emits ONLY floored aggregates, never a row).
-- Below the floor the whole usage block is NULL and `usage_suppressed` is true —
-- no count is disclosed. The `>= 5` literal appears verbatim (a verify-script
-- drift guard pins against it). The tutor_turns / tutor_threads tables keep their
-- learner-only policies untouched — authors read them ONLY through this RPC.
--
-- COST is the AUTHOR'S OWN spend (tutor_model_call telemetry), not learner data,
-- so it is author-gated but NOT floored — and it carries NO learner attribution
-- (grouped by job_type only). Per-call rows are R-9-invisible to every client
-- role; the definer function aggregates them directly.

create function public.tutor_console_bundle(p_course_id uuid, p_tab text)
returns jsonb language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid       uuid := (select auth.uid());
  v_title     text;
  v_settings  record;
  v_enabled   boolean := false;
  v_charter   jsonb;
  v_node_count            integer := 0;
  v_pending_change_set_id uuid;
  v_has_accepted_graph    boolean;
  v_current_version_id    uuid;
  -- overview scratch
  v_usage_learners integer := 0;
  v_usage_sessions integer := 0;
  v_usage_turns    integer := 0;
  v_usage          jsonb;
  v_usage_suppressed boolean;
  v_cost_by_job    jsonb;
  v_cost_total     numeric;
  v_charter_versions jsonb;
begin
  if v_uid is null then
    return null;
  end if;
  if p_tab not in ('overview', 'charter') then
    raise exception 'unknown tab %', p_tab;
  end if;

  -- Author gate: a non-author (or a missing course) returns NULL — the page 404s.
  select c.title into v_title
  from public.courses c
  where c.id = p_course_id and c.author_id = v_uid;
  if not found then
    return null;
  end if;

  -- ── enablement (ALWAYS present) ───────────────────────────────────────────
  select s.* into v_settings
  from public.tutor_course_settings s
  where s.course_id = p_course_id;
  if found then
    v_enabled            := v_settings.enabled;
    v_current_version_id := v_settings.current_charter_version_id;
    v_charter := jsonb_build_object(
      'guidanceStyle',          v_settings.guidance_style,
      'courseCanon',            v_settings.course_canon,
      'scope',                  v_settings.scope,
      'toneNotes',              v_settings.tone_notes,
      'assessmentHelp',         v_settings.assessment_help,
      'escalationSensitivity',  v_settings.escalation_sensitivity
    );
  else
    -- No settings row → the migration DEFAULTS (mirrors charter.ts CHARTER_DEFAULTS).
    v_charter := jsonb_build_object(
      'guidanceStyle',          'guided_default',
      'courseCanon',            'strict',
      'scope',                  'course_only',
      'toneNotes',              null,
      'assessmentHelp',         'concept_review_only',
      'escalationSensitivity',  'default'
    );
  end if;

  -- Active concept nodes = a graph exists to gate enablement on.
  select count(*)::integer into v_node_count
  from public.concept_nodes n
  where n.course_id = p_course_id and n.status = 'active';

  -- A pending concept_graph change-set means a staged run awaits Accept/Reject.
  select ci.change_set_id into v_pending_change_set_id
  from public.change_set_items ci
  join public.change_sets cs on cs.id = ci.change_set_id
  where ci.node_type = 'concept_graph'
    and cs.course_id = p_course_id
    and cs.status = 'pending'
  limit 1;

  -- The enable gate (AC-T5.1 data half): an accepted graph = active nodes AND no
  -- pending graph change-set awaiting review.
  v_has_accepted_graph := (v_node_count > 0 and v_pending_change_set_id is null);

  -- charter version history (creator-owned config, NOT learner data → unfloored;
  -- needed by BOTH the Overview timeline AND the Charter tab's history list, so
  -- it rides the always-present enablement block). actor email via auth.users
  -- (definer join). The author can read tutor_charter_versions directly too, but
  -- bundling it keeps each tab to ONE round trip.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',        v.id,
    'actorEmail', u.email,
    'createdAt', v.created_at,
    'snapshot',  v.snapshot
  ) order by v.created_at desc), '[]'::jsonb)
  into v_charter_versions
  from public.tutor_charter_versions v
  left join auth.users u on u.id = v.actor
  where v.course_id = p_course_id;

  -- ── overview (only when the Overview tab asks) ────────────────────────────
  if p_tab = 'overview' then
    -- usage: sessions (threads with any turn in the window), turns, and distinct
    -- learners over the last 30 days. COHORT-FLOORED ≥5 on distinct learners.
    select
      count(distinct t.user_id)::integer,
      count(distinct t.id)::integer,
      count(tt.id)::integer
    into v_usage_learners, v_usage_sessions, v_usage_turns
    from public.tutor_threads t
    join public.tutor_turns tt
      on tt.thread_id = t.id
     and tt.created_at > now() - interval '30 days'
    where t.course_id = p_course_id;

    v_usage_suppressed := (v_usage_learners < 5);
    if v_usage_learners >= 5 then
      v_usage := jsonb_build_object(
        'uniqueLearners', v_usage_learners,
        'sessions',       v_usage_sessions,
        'turns',          v_usage_turns
      );
    else
      v_usage := null;  -- below floor: disclose nothing (not even the count)
    end if;

    -- cost: the author's own tutor spend, grouped by job_type. NOT floored (no
    -- learner data), NO learner attribution. Per-call rows are R-9-invisible to
    -- clients; this definer function aggregates them directly.
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'jobType',      g.job_type,
        'calls',        g.calls,
        'inputTokens',  g.input_tokens,
        'outputTokens', g.output_tokens,
        'costUsd',      g.cost_usd
      ) order by g.job_type), '[]'::jsonb),
      coalesce(sum(g.cost_usd), 0)
    into v_cost_by_job, v_cost_total
    from (
      select
        e.job_type,
        count(*)::integer                 as calls,
        sum(e.input_tokens)::bigint       as input_tokens,
        sum(e.output_tokens)::bigint      as output_tokens,
        sum(e.computed_cost_usd)          as cost_usd
      from public.learning_events e
      where e.course_id = p_course_id
        and e.event_type = 'tutor_model_call'
      group by e.job_type
    ) g;
  end if;

  return jsonb_build_object(
    'course', jsonb_build_object('id', p_course_id, 'title', v_title),
    'enablement', jsonb_build_object(
      'enabled',                 v_enabled,
      'hasAcceptedGraph',        v_has_accepted_graph,
      'nodeCount',               v_node_count,
      'pendingGraphChangeSetId', v_pending_change_set_id,
      'currentVersionId',        v_current_version_id,
      'charter',                 v_charter,
      'charterVersions',         v_charter_versions
    ),
    'overview', case when p_tab = 'overview' then jsonb_build_object(
      'usage',           v_usage,
      'usageSuppressed', v_usage_suppressed,
      'cost', jsonb_build_object(
        'byJobType', v_cost_by_job,
        'totalUsd',  v_cost_total
      )
    ) else null end
  );
end;
$$;
revoke all on function public.tutor_console_bundle(uuid, text) from public, anon;
grant execute on function public.tutor_console_bundle(uuid, text) to authenticated;

comment on function public.tutor_console_bundle(uuid, text) is
  'Author-gated Creator Tutor Console read RPC (Wave 5 P5.1). NULL for non-authors (page 404s). enablement block always; overview block (usage COHORT-FLOORED >= 5, cost by job_type unfloored/no-attribution, charter version history) when p_tab=overview. Unknown tab raises. Reads learner-RLS tutor_threads/tutor_turns as definer but emits only floored aggregates.';
