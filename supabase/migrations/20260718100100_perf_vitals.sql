-- WiseSel — PERF-1 E1/E2: RUM web-vitals through the EXISTING analytics
-- pipeline (never a parallel path).
--
-- One new event type, `perf_vital` (LCP/INP/CLS/FCP/TTFB), riding the same
-- Zod contract, the same batching client, the same ingest RPC, the same
-- learning_events table. It is the one APP-scoped event: a vital belongs to
-- a route, not a course — course_id/publication_id/lesson_id land NULL, so
-- the enrolled-or-author + publication∈course invariants are skipped for
-- exactly this type (user_id stays PINNED to auth.uid() like everything
-- else; the UNIQUE client_event_id stays the idempotency store).
--
-- Read surface (E2): perf rows have NULL course_id, so the author-select
-- semi-join policy naturally excludes them — vitals are UNREADABLE by every
-- client role by design. The only read surface is public.perf_vitals_daily
-- (SECURITY INVOKER, revoked from anon/authenticated → service-role /
-- internal dashboards only for now).
--
-- Typed extras follow the M3 convention (real CHECKed columns, not jsonb):
-- metric_name/metric_value/metric_rating/route/device_class/navigation_type.
-- The route cap (200) is mirrored as PERF_ROUTE_MAX_CHARS in
-- lib/analytics/events.ts (drift-guarded by verify-vitals.ts).

-- ───────────── 1. learning_events: the perf_vital event type ────────────────
alter table public.learning_events
  drop constraint learning_events_event_type_check;
alter table public.learning_events
  add constraint learning_events_event_type_check check (event_type in (
    'lesson_started','slide_viewed','video_progress','video_completed',
    'quiz_started','quiz_submitted','homework_submitted','lesson_completed',
    'session_heartbeat','slide_feedback','perf_vital',
    'comms_email_delivered','comms_email_open','comms_email_click',
    'comms_email_bounce','comms_email_complaint'));

alter table public.learning_events
  add column metric_name text
    check (metric_name is null or metric_name in ('LCP','INP','CLS','FCP','TTFB')),
  -- ms for timing metrics; CLS is its raw unitless float — never rescaled.
  add column metric_value numeric
    check (metric_value is null or metric_value >= 0),
  add column metric_rating text
    check (metric_rating is null
           or metric_rating in ('good','needs-improvement','poor')),
  -- A normalized route PATTERN (lib/analytics/vitals.ts), never a raw URL.
  add column route text
    check (route is null or char_length(route) <= 200),
  add column device_class text
    check (device_class is null or device_class in ('mobile','desktop')),
  add column navigation_type text
    check (navigation_type is null or char_length(navigation_type) <= 50);

-- App-scoped: a vital carries its metric columns and NOTHING course-shaped;
-- every other type carries none of the metric columns. Both directions
-- CHECKed so the view + rollup assumptions hold at the DB.
alter table public.learning_events alter column course_id drop not null;
alter table public.learning_events
  add constraint learning_events_course_check check (
    course_id is not null or event_type = 'perf_vital');
alter table public.learning_events
  add constraint learning_events_perf_vital_check check (
    case when event_type = 'perf_vital'
      then metric_name is not null and metric_value is not null
           and metric_rating is not null and route is not null
           and device_class is not null
           and course_id is null and publication_id is null
           and lesson_id is null
      else metric_name is null and metric_value is null
           and metric_rating is null and route is null
           and device_class is null and navigation_type is null
    end);

-- The (course-envelope) check must admit the app-scoped type too.
alter table public.learning_events drop constraint learning_events_envelope_check;
alter table public.learning_events
  add constraint learning_events_envelope_check check (
    event_type like 'comms_email_%'
    or event_type = 'perf_vital'
    or (publication_id is not null and version is not null and lesson_id is not null));

-- The daily view scans exactly this slice.
create index learning_events_perf_vital_ts_idx
  on public.learning_events (server_ts)
  where event_type = 'perf_vital';

-- ── 2. ingest RPC: body verbatim except (a) the scope checks skip perf_vital
--       rows, (b) the insert maps the six new columns ────────────────────────
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

-- ─────────────────── 3. E2 read surface: perf_vitals_daily ──────────────────
-- Per (day, route, metric, device): count + p50/p75/p95 of metric_value.
--
-- ALERT THRESHOLDS (PERF-1 directive §2 — alert when the daily p75 crosses
-- the web-vitals "needs-improvement" boundary):
--   LCP p75 > 2500 ms · INP p75 > 200 ms · CLS p75 > 0.1 ·
--   FCP p75 > 1800 ms · TTFB p75 > 800 ms
-- STANDING RULE: production RUM thresholds are MONITORING ALERTS, never
-- quality gates — a threshold crossing pages a human, it never blocks a
-- build/deploy/publish.
create view public.perf_vitals_daily
with (security_invoker = true) as
select
  (date_trunc('day', e.server_ts))::date as day,
  e.route,
  e.metric_name,
  e.device_class,
  count(*)::integer as n,
  percentile_cont(0.5)  within group (order by e.metric_value) as p50,
  percentile_cont(0.75) within group (order by e.metric_value) as p75,
  percentile_cont(0.95) within group (order by e.metric_value) as p95
from public.learning_events e
where e.event_type = 'perf_vital'
group by 1, 2, 3, 4;

-- SECURITY INVOKER + no client grants: only the service role (RLS-bypassing)
-- can read it — the client roles both lack the grant AND would see zero rows
-- through the author-select policy anyway (NULL course_id).
revoke all on public.perf_vitals_daily from public, anon, authenticated;
