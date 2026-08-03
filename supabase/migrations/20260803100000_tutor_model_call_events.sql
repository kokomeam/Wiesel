-- WiseSel — TUTOR-1 Wave 1.1B: tutor_model_call cost telemetry through the
-- EXISTING analytics pipeline (never a parallel path).
--
-- One new event type, `tutor_model_call`: every AI-tutor model call (graph
-- extraction, reconciliation, embedding, tutor turn) records its token usage,
-- computed USD cost, and latency onto the SAME learning_events table, riding
-- the SAME Zod contract and the SAME server-emit discipline. It is a
-- COURSE-scoped event (course_id NOT NULL) but learner-OPTIONAL (learner_user_id
-- may be null — e.g. an extraction run has no learner). Like the M3
-- authoritative events it is SERVER-emitted ONLY (admin client): the client
-- batch schema excludes it and the ingest RPC rejects any tutor_% row a browser
-- might forge.
--
-- R-9 — AUTHOR-INVISIBLE by policy: per-call rows are UNREADABLE by every client
-- role. Learners already read none; course_id is NOT NULL so the author
-- semi-join would otherwise expose the rows to creators — the SELECT policy is
-- re-created with an `event_type not like 'tutor_%'` exclusion. Creators see
-- their AGGREGATE tutor spend via the service-role-only
-- public.tutor_model_costs_daily view, never per-call rows.
--
-- Typed extras follow the M3 convention (real CHECKed columns, not jsonb):
-- job_type/model/input_tokens/cached_input_tokens/output_tokens/
-- computed_cost_usd/latency_ms/learner_user_id. Cost is computed in TS
-- (lib/ai/modelConfig.ts computeCostUsd) and stamped at emit time; the column is
-- numeric — a null cost means the model was absent from the pricing table.

-- ───────────── 1. learning_events: the tutor_model_call event type ───────────
alter table public.learning_events
  drop constraint learning_events_event_type_check;
alter table public.learning_events
  add constraint learning_events_event_type_check check (event_type in (
    'lesson_started','slide_viewed','video_progress','video_completed',
    'quiz_started','quiz_submitted','homework_submitted','lesson_completed',
    'session_heartbeat','slide_feedback','perf_vital',
    'comms_email_delivered','comms_email_open','comms_email_click',
    'comms_email_bounce','comms_email_complaint','tutor_model_call'));

alter table public.learning_events
  add column job_type text
    check (job_type is null
           or job_type in ('graph_extraction','reconciliation','embedding','tutor_turn')),
  add column model text,
  add column input_tokens integer
    check (input_tokens is null or input_tokens >= 0),
  add column cached_input_tokens integer
    check (cached_input_tokens is null or cached_input_tokens >= 0),
  add column output_tokens integer
    check (output_tokens is null or output_tokens >= 0),
  -- null = the model was absent from the pricing table (unknown cost).
  add column computed_cost_usd numeric
    check (computed_cost_usd is null or computed_cost_usd >= 0),
  add column latency_ms integer
    check (latency_ms is null or latency_ms >= 0),
  -- Learner-OPTIONAL: an extraction/reconciliation run has no learner.
  add column learner_user_id uuid;

-- Course-scoped cost telemetry: a tutor_model_call carries its tutor columns
-- and NO course-position/perf columns (mutual exclusion with perf metrics);
-- every other type carries NONE of the tutor columns. Both directions CHECKed.
-- (The existing learning_events_perf_vital_check else-branch constrains ONLY
-- the metric columns, so a tutor row — which leaves them null — satisfies it.)
alter table public.learning_events
  add constraint learning_events_tutor_call_check check (
    case when event_type = 'tutor_model_call'
      then job_type is not null and model is not null
           and input_tokens is not null and output_tokens is not null
           and latency_ms is not null
           and course_id is not null
           and publication_id is null and version is null and lesson_id is null
           and metric_name is null
      else job_type is null and model is null
           and input_tokens is null and cached_input_tokens is null
           and output_tokens is null and computed_cost_usd is null
           and latency_ms is null and learner_user_id is null
    end);

-- The (course-envelope) check must admit the course-scoped type too — a
-- tutor_model_call has course_id but no publication/version/lesson.
alter table public.learning_events drop constraint learning_events_envelope_check;
alter table public.learning_events
  add constraint learning_events_envelope_check check (
    event_type like 'comms_email_%'
    or event_type = 'perf_vital'
    or event_type = 'tutor_model_call'
    or (publication_id is not null and version is not null and lesson_id is not null));

-- The daily cost view scans exactly this slice.
create index learning_events_tutor_call_ts_idx
  on public.learning_events (course_id, server_ts)
  where event_type = 'tutor_model_call';

-- R-9: per-call tutor rows are invisible to every client role. Learners read
-- none already; course_id is NOT NULL here, so without this exclusion the
-- author semi-join would expose them to creators. Re-create the current
-- semi-join SELECT policy (from 20260717100100) with a tutor_% exclusion.
drop policy if exists "learning_events_select" on public.learning_events;
create policy "learning_events_select" on public.learning_events for select
  using (course_id in (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  ) and event_type not like 'tutor_%');

-- ── 2. ingest RPC: body verbatim (from 20260718100100) except one addition —
--       an early guard rejecting any server-only tutor_% row a client forges.
--       (The tutor columns are NEVER in the client insert list.) ─────────────
create or replace function public.ingest_learning_events(p_events jsonb)
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

  -- Server-only event types (tutor_*) never ride the client batch path.
  if exists (
    select 1 from jsonb_to_recordset(p_events) as e(event_type text)
    where e.event_type like 'tutor_%'
  ) then
    raise exception 'server-only event type';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_events) as e(event_type text, course_id uuid)
    where e.event_type <> 'perf_vital'
      and not exists (
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
    from jsonb_to_recordset(p_events)
      as e(event_type text, course_id uuid, publication_id uuid)
    where e.event_type <> 'perf_vital'
      and not exists (
        select 1 from public.course_publications p
        where p.id = e.publication_id and p.course_id = e.course_id)
  ) then
    raise exception 'publication does not belong to the course';
  end if;

  insert into public.learning_events
    (client_event_id, user_id, event_type, publication_id, version, course_id,
     lesson_id, block_id, slide_id, dwell_ms, quartile, attempt_id, reaction,
     feedback_comment, metric_name, metric_value, metric_rating, route,
     device_class, navigation_type, metadata, client_ts)
  select
    e.client_event_id, v_uid, e.event_type, e.publication_id, e.version,
    e.course_id, e.lesson_id, e.block_id, e.slide_id, e.dwell_ms, e.quartile,
    e.attempt_id, e.reaction, e.feedback_comment, e.metric_name,
    e.metric_value, e.metric_rating, e.route, e.device_class,
    e.navigation_type, coalesce(e.metadata, '{}'::jsonb), e.client_ts
  from jsonb_to_recordset(p_events) as e(
    client_event_id uuid, event_type text, publication_id uuid, version integer,
    course_id uuid, lesson_id uuid, block_id uuid, slide_id text,
    dwell_ms integer, quartile smallint, attempt_id uuid, reaction text,
    feedback_comment text, metric_name text, metric_value numeric,
    metric_rating text, route text, device_class text, navigation_type text,
    metadata jsonb, client_ts timestamptz)
  on conflict (client_event_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─────────────── 3. R-9 read surface: tutor_model_costs_daily ────────────────
-- Per (day, course, job_type, model): call count + token sums + total USD cost
-- + avg latency. This is the ONLY read surface for tutor cost — creators get
-- AGGREGATE spend, never per-call rows.
create view public.tutor_model_costs_daily
with (security_invoker = true) as
select
  (date_trunc('day', e.server_ts))::date as day,
  e.course_id,
  e.job_type,
  e.model,
  count(*)::integer as calls,
  sum(e.input_tokens)::bigint as input_tokens,
  sum(e.cached_input_tokens)::bigint as cached_input_tokens,
  sum(e.output_tokens)::bigint as output_tokens,
  sum(e.computed_cost_usd) as computed_cost_usd,
  avg(e.latency_ms) as avg_latency_ms
from public.learning_events e
where e.event_type = 'tutor_model_call'
group by 1, 2, 3, 4;

-- SECURITY INVOKER + no client grants: only the service role (RLS-bypassing)
-- can read it — the client roles both lack the grant AND would see zero rows
-- through the author-select policy anyway (tutor_% excluded).
revoke all on public.tutor_model_costs_daily from public, anon, authenticated;
