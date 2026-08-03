-- WiseSel — TUTOR-1 Wave 2 (evidence contract extension). Five new event types
-- carrying the tutor's LEARNING-EVIDENCE signal onto the SAME learning_events
-- table, riding the SAME Zod contract and the SAME server-emit / ingest
-- discipline (never a parallel path). Audit §3.2 recipe: drop + re-add the
-- learning_events CHECKs from the CURRENT bodies (20260803100000, the latest).
--
-- The five new types, and their trust posture:
--   practice_answer   — SERVER-emitted: a learner answered a tutor practice item
--   hint_request      — SERVER-emitted: a learner asked for a hint (rung 0–4)
--   self_report       — SERVER-emitted: a learner self-reported understanding
--   tutor_inference   — SERVER-emitted: the tutor inferred a mastery signal
--                        (direction/strength/turn_ref ride METADATA — the frozen
--                         Wave-3 side-channel contract, typed in TS)
--   content_engagement — the ONE CLIENT member (rewatch/scrub_back/completed).
--                         A browser cannot know concept node ids, so it carries
--                         NONE of the new typed columns — signals ride metadata,
--                         and it passes through the normal client batch path.
--
-- The four tutor_* / self_report / etc. server events are course+publication
-- scoped with the LESSON OPTIONAL (a tutor conversation spans lessons), so they
-- get their own envelope arm. content_engagement deliberately falls under the
-- EXISTING full-envelope arm (pub+version+lesson NOT NULL — it happens inside a
-- lesson). Node ids carry NO FK (a concept node may retire while a learner's
-- evidence history lives on — same reasoning as lesson_id/block_id on the
-- runtime tables). The derived `dwell_over_median` signal is NOT an event: it is
-- computed in the refold from the existing dwell events vs the cohort rollup.

-- ───────────── 1. learning_events: the five new event types ──────────────────
alter table public.learning_events
  drop constraint learning_events_event_type_check;
alter table public.learning_events
  add constraint learning_events_event_type_check check (event_type in (
    'lesson_started','slide_viewed','video_progress','video_completed',
    'quiz_started','quiz_submitted','homework_submitted','lesson_completed',
    'session_heartbeat','slide_feedback','perf_vital',
    'comms_email_delivered','comms_email_open','comms_email_click',
    'comms_email_bounce','comms_email_complaint','tutor_model_call',
    'practice_answer','hint_request','self_report','tutor_inference',
    'content_engagement'));

-- ───────────── 2. New typed evidence columns (all nullable, CHECKed) ──────────
-- node_id / practice_item_ref carry NO FK — a concept node or practice item may
-- retire while the evidence history it produced lives on (mirrors the
-- lesson_id/block_id no-FK reasoning on quiz_attempts).
alter table public.learning_events
  add column node_id uuid,
  add column attempt_ordinal integer
    check (attempt_ordinal is null or attempt_ordinal >= 1),
  add column hint_rung smallint
    check (hint_rung is null or hint_rung between 0 and 4),
  add column evidence_correct boolean,
  add column practice_item_ref uuid;

-- ── 3. Bidirectional column-isolation: each evidence type carries EXACTLY its
--      own columns; every other type carries NONE of the five. ────────────────
alter table public.learning_events
  add constraint learning_events_evidence_check check (
    case event_type
      -- a graded practice answer: node + item + ordinal + correctness; no hint.
      when 'practice_answer' then
        node_id is not null and evidence_correct is not null
        and practice_item_ref is not null and attempt_ordinal is not null
        and hint_rung is null
      -- a hint request at a rung; a hint may reference an item (nullable).
      when 'hint_request' then
        node_id is not null and hint_rung is not null
        and evidence_correct is null and attempt_ordinal is null
      -- a learner self-report of understanding a concept.
      when 'self_report' then
        node_id is not null and evidence_correct is not null
        and hint_rung is null and attempt_ordinal is null
        and practice_item_ref is null
      -- a tutor mastery inference: only the node is columnar; the rest
      -- (direction/strength/turn_ref) rides METADATA (the frozen Wave-3 shape).
      when 'tutor_inference' then
        node_id is not null and evidence_correct is null and hint_rung is null
        and attempt_ordinal is null and practice_item_ref is null
      -- a client engagement signal: NO node ids (the client can't know them);
      -- the signal rides metadata.
      when 'content_engagement' then
        node_id is null and attempt_ordinal is null and hint_rung is null
        and evidence_correct is null and practice_item_ref is null
      -- every other event type: none of the five evidence columns.
      else
        node_id is null and attempt_ordinal is null and hint_rung is null
        and evidence_correct is null and practice_item_ref is null
    end);

-- ── 4. Envelope: the four tutor evidence events are course+publication scoped
--      with the lesson OPTIONAL (a tutor conversation spans lessons).
--      content_engagement keeps the FULL envelope (pub+version+lesson NOT NULL —
--      it happens inside a lesson) via the existing final arm. ────────────────
-- (Current body from 20260803100000 + the new tutor-evidence arm.)
alter table public.learning_events drop constraint learning_events_envelope_check;
alter table public.learning_events
  add constraint learning_events_envelope_check check (
    event_type like 'comms_email_%'
    or event_type = 'perf_vital'
    or event_type = 'tutor_model_call'
    or (event_type in ('practice_answer','hint_request','self_report','tutor_inference')
        and publication_id is not null and version is not null)
    or (publication_id is not null and version is not null and lesson_id is not null));
-- The course CHECK (course_id not null or perf_vital) is unchanged — all five
-- new types carry course_id, so they satisfy it already.

-- ── 5. ingest RPC: body VERBATIM from 20260803100000, with ONE change — the
--      server-only reject guard widens to also refuse the three server-only
--      evidence types a browser might forge. tutor_inference already matches
--      tutor_% (it is rejected by the existing arm); content_engagement is the
--      ONE client member and passes through. The insert column list is
--      UNCHANGED — content_engagement carries none of the new typed columns
--      (its signal rides metadata), so no column is added to the insert. ──────
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

  -- Server-only event types never ride the client batch path: the tutor_* cost
  -- + inference events, PLUS the three server-emitted evidence types.
  -- (content_engagement is the ONE client evidence member and is NOT listed.)
  if exists (
    select 1 from jsonb_to_recordset(p_events) as e(event_type text)
    where e.event_type like 'tutor_%'
       or e.event_type in ('practice_answer','hint_request','self_report')
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

-- ── 6. The refold's read path: the per-(user, course, ts) slice of the five
--      evidence event types. ──────────────────────────────────────────────────
create index learning_events_evidence_idx
  on public.learning_events (user_id, course_id, server_ts)
  where event_type in (
    'practice_answer','hint_request','self_report','tutor_inference',
    'content_engagement');

comment on constraint learning_events_evidence_check on public.learning_events is
  'Wave-2 evidence column isolation: practice_answer/hint_request/self_report/tutor_inference/content_engagement each carry exactly their own of {node_id,attempt_ordinal,hint_rung,evidence_correct,practice_item_ref}; every other type carries none. tutor_inference direction/strength/turn_ref ride metadata (the frozen Wave-3 contract).';
