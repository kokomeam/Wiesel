-- TUTOR-1 follow-up (2026-08-06) — TUTOR ON BY DEFAULT.
--
-- Product decision (creator directive): a published course's tutor should be
-- ON by default, not gated behind a per-course console toggle + an accepted
-- concept graph. The tutor answers lesson-grounded from the published snapshot
-- even before its concept graph exists (the runtime tolerates an empty graph);
-- the graph adds mastery scaffolding and still extracts automatically on
-- publish, but never gates the tutor's PRESENCE.
--
-- Semantics everywhere (code mirrors this): a course's tutor is ENABLED unless
-- the creator explicitly turned it OFF —
--     effectiveEnabled = (no tutor_course_settings row) OR (row.enabled <> false)
-- Only an explicit enabled=false disables. Evidence/enrollment/cohort-floor/
-- consent invariants are UNCHANGED (they never depended on `enabled`).
--
-- This migration re-creates tutor_console_bundle with ONE change: the
-- enablement default when no settings row exists flips false → true
-- (`v_enabled boolean := true;`), so the creator console reflects default-on
-- consistently with resolveTutorAccess. The rest of the function is byte-for-
-- byte identical to 20260806160000's version.

create or replace function public.tutor_console_bundle(p_course_id uuid, p_tab text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_uid       uuid := (select auth.uid());
  v_title     text;
  v_settings  record;
  v_enabled   boolean := true;   -- ON BY DEFAULT: no settings row ⇒ enabled.
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
    -- No settings row → ON BY DEFAULT (v_enabled stays true) + the migration
    -- DEFAULTS for the charter (mirrors charter.ts CHARTER_DEFAULTS).
    v_charter := jsonb_build_object(
      'guidanceStyle',          'guided_default',
      'courseCanon',            'strict',
      'scope',                  'course_only',
      'toneNotes',              null,
      'assessmentHelp',         'concept_review_only',
      'escalationSensitivity',  'default'
    );
  end if;

  -- Active concept nodes = a graph exists (adds mastery scaffolding; NOT a gate).
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

  -- hasAcceptedGraph is now a STATUS signal (does mastery scaffolding exist?),
  -- no longer an enable gate: active nodes AND no pending graph change-set.
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
$function$;
