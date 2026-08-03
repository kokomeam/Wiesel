-- PERF-1 C1 — /marketing (hub) bundle RPC.
--
-- Replaces the hub page's 6 sequential waves (~24 DB round trips,
-- docs/perf/PERF-1_diagnosis.md §A2): course → listAuthorCourses (serial) →
-- Promise.all(campaign / pending approvals / questions / activity / autonomy)
-- → listLandingPages (serial) → loadSequencesOverview (4 serial reads that
-- fetched EVERY scheduled_send + sequence_enrollment row to count in JS) —
-- with ONE SECURITY DEFINER round trip. The per-pending-approval LIVE
-- previews are deliberately NOT in the bundle: they re-execute the tool by
-- design (counts must reflect CURRENT state, never persisted) and now STREAM
-- behind the shell (React use() + Suspense in MarketingHub).
--
-- Contract (validated by lib/marketing/hubLoader.ts, zod-first): jsonb {
--   courses:            [{id,title}] — the author's courses, updated_at desc
--                       (the hub's course picker; was listAuthorCourses)
--   campaign:           {id,name,status,goal,config:{blueprintKey,
--                       autoPauseReason}} | null — the most-recent campaign,
--                       narrowed to ONLY the config keys the hub reads
--   pending_approvals:  newest 20 status='pending' marketing_action rows
--                       minus before_snapshot (params KEPT — ApprovalCard's
--                       editableParams + the streamed preview re-run need
--                       them)
--   pending_questions:  newest 20 status='pending' marketing_question rows
--                       (the hub renders id/question/options)
--   activity:           the listRecentActivity predicate (auto_approved OR
--                       policy-executed), LIMIT 15, minus before_snapshot/
--                       params — the hub renders kind/summary/requester +
--                       the revert chip (revert_expires_at, autonomy_decision)
--   autonomy:           {mode,policy,revert_window_hours} | null
--                       (null = no settings row = the defaults, as before)
--   landing_pages:      [{id,title,slug,status,section_count}] for the
--                       campaign, created_at asc — section_count via
--                       jsonb_array_length so the sections jsonb never ships
--   sequences_overview: {sequence_count,queued,sent} — aggregate counts over
--                       scheduled_send joined to the campaign's touches
--                       (kills the fetch-to-count; queued/sent statuses match
--                       loadSequencesOverview exactly)
-- }
--
-- Authorization lives INSIDE the function: auth.uid() is pinned once and the
-- caller must be the course AUTHOR, else the function returns NULL (never
-- trusts a client-supplied user id) and the page falls back to its
-- no-course state.

create function public.marketing_hub_bundle(p_course_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid           uuid := (select auth.uid());
  v_campaign_id   uuid;
  v_campaign_json jsonb;
  v_autonomy      jsonb;
  v_pages         jsonb;
  v_sequences     jsonb;
  v_result        jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  -- Author gate: a missing or non-authored course returns null.
  perform 1 from public.courses c
  where c.id = p_course_id and c.author_id = v_uid;
  if not found then
    return null;
  end if;

  -- Most-recent campaign (MVP = one campaign per course), narrowed to the
  -- exact fields + config keys the hub reads.
  select mc.id,
         jsonb_build_object(
           'id',     mc.id,
           'name',   mc.name,
           'status', mc.status,
           'goal',   mc.goal,
           'config', jsonb_build_object(
             'blueprintKey',    mc.config->'blueprintKey',
             'autoPauseReason', mc.config->'autoPauseReason'))
    into v_campaign_id, v_campaign_json
  from public.marketing_campaign mc
  where mc.course_id = p_course_id
  order by mc.created_at desc
  limit 1;

  -- Autonomy settings — no row is a valid state and means the defaults
  -- (the loader mirrors loadAutonomySettings' parse).
  select jsonb_build_object(
           'mode',                s.mode,
           'policy',              s.policy,
           'revert_window_hours', s.revert_window_hours)
    into v_autonomy
  from public.marketing_autonomy_settings s
  where s.course_id = p_course_id;

  if v_campaign_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id',            lp.id,
             'title',         lp.title,
             'slug',          lp.slug,
             'status',        lp.status,
             'section_count', coalesce(jsonb_array_length(lp.sections), 0))
             order by lp.created_at asc), '[]'::jsonb)
      into v_pages
    from public.landing_page lp
    where lp.campaign_id = v_campaign_id;

    -- The Email card's counts. Semantics mirror loadSequencesOverview: a
    -- send counts only when its touch belongs to one of the campaign's
    -- sequences (broadcasts carry touch_id null and are excluded), queued =
    -- pending|awaiting_approval|approved, sent = sent.
    with seq as (
      select id from public.email_sequence where campaign_id = v_campaign_id
    )
    select jsonb_build_object(
             'sequence_count', (select count(*)::integer from seq),
             'queued', (count(*) filter (where s.status in
                          ('pending','awaiting_approval','approved')))::integer,
             'sent',   (count(*) filter (where s.status = 'sent'))::integer)
      into v_sequences
    from public.scheduled_send s
    join public.email_touch t on t.id = s.touch_id
    where s.sequence_id in (select id from seq)
      and t.sequence_id in (select id from seq);
  else
    v_pages := '[]'::jsonb;
    v_sequences := jsonb_build_object('sequence_count', 0, 'queued', 0, 'sent', 0);
  end if;

  select jsonb_build_object(
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title)
               order by c.updated_at desc)
      from public.courses c where c.author_id = v_uid), '[]'::jsonb),
    'campaign', v_campaign_json,
    'pending_approvals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',           a.id,
               'tool_name',    a.tool_name,
               'action_kind',  a.action_kind,
               'summary',      a.summary,
               'params',       a.params,
               'target_ref',   a.target_ref,
               'requested_by', a.requested_by,
               'campaign_id',  a.campaign_id,
               'created_at',   a.created_at)
               order by a.created_at desc)
      from (
        select * from public.marketing_action
        where course_id = p_course_id and status = 'pending'
        order by created_at desc
        limit 20
      ) a), '[]'::jsonb),
    'pending_questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',         q.id,
               'question',   q.question,
               'options',    q.options,
               'source',     q.source,
               'created_at', q.created_at)
               order by q.created_at desc)
      from (
        select * from public.marketing_question
        where course_id = p_course_id and status = 'pending'
        order by created_at desc
        limit 20
      ) q), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',                a.id,
               'action_kind',       a.action_kind,
               'summary',           a.summary,
               'status',            a.status,
               'requested_by',      a.requested_by,
               'autonomy_decision', a.autonomy_decision,
               'revert_expires_at', a.revert_expires_at,
               'created_at',        a.created_at)
               order by a.created_at desc)
      from (
        select * from public.marketing_action
        where course_id = p_course_id
          and (status = 'auto_approved'
               or (status = 'executed' and autonomy_decision is not null))
        order by created_at desc
        limit 15
      ) a), '[]'::jsonb),
    'autonomy', v_autonomy,
    'landing_pages', v_pages,
    'sequences_overview', v_sequences
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.marketing_hub_bundle(uuid) from public, anon;
grant execute on function public.marketing_hub_bundle(uuid) to authenticated;
