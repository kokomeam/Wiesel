-- WiseSel — Milestone 10 (Engagement & Retention wave): in-slide feedback.
--
-- A 10th LEARNER event type, `slide_feedback` (reaction helpful|confusing +
-- optional capped comment), riding the EXISTING pipeline end to end: the same
-- Zod contract, the same batching client SDK, the same ingest RPC with
-- server-pinned user_id, the same learning_events table. Zero new pipeline.
--
-- Idempotency contract: the stream is APPEND-ONLY — a learner toggling their
-- reaction produces multiple events, and "latest reaction wins per
-- (user, slide)" is enforced IN THE ROLLUP (distinct on … order by server_ts
-- desc), never by mutating the log.
--
-- Typed extras follow the M3 convention (real columns, not jsonb, so the
-- rollup SQL stays simple): `reaction` + `feedback_comment`, both CHECKed —
-- the comment cap (500) is mirrored as FEEDBACK_COMMENT_MAX_CHARS in
-- lib/analytics/events.ts (drift-guarded by verify-analytics.ts).

-- ───────────── 1. learning_events: the 10th learner event type ──────────────
alter table public.learning_events
  drop constraint learning_events_event_type_check;
alter table public.learning_events
  add constraint learning_events_event_type_check check (event_type in (
    'lesson_started','slide_viewed','video_progress','video_completed',
    'quiz_started','quiz_submitted','homework_submitted','lesson_completed',
    'session_heartbeat','slide_feedback',
    'comms_email_delivered','comms_email_open','comms_email_click',
    'comms_email_bounce','comms_email_complaint'));

alter table public.learning_events
  add column reaction text
    check (reaction is null or reaction in ('helpful','confusing')),
  add column feedback_comment text
    check (feedback_comment is null or char_length(feedback_comment) <= 500);

-- ───── 2. ingest RPC: body verbatim + the two new columns in the mapping ────
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
     lesson_id, block_id, slide_id, dwell_ms, quartile, attempt_id, reaction,
     feedback_comment, metadata, client_ts)
  select
    e.client_event_id, v_uid, e.event_type, e.publication_id, e.version,
    e.course_id, e.lesson_id, e.block_id, e.slide_id, e.dwell_ms, e.quartile,
    e.attempt_id, e.reaction, e.feedback_comment,
    coalesce(e.metadata, '{}'::jsonb), e.client_ts
  from jsonb_to_recordset(p_events) as e(
    client_event_id uuid, event_type text, publication_id uuid, version integer,
    course_id uuid, lesson_id uuid, block_id uuid, slide_id text,
    dwell_ms integer, quartile smallint, attempt_id uuid, reaction text,
    feedback_comment text, metadata jsonb, client_ts timestamptz)
  on conflict (client_event_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ────── 3. my_slide_feedback: the learner's OWN latest reactions ────────────
-- Students read no learning_events rows by design — but their own reactions
-- are their own input, and the toggle UI must reflect current state. This
-- narrow definer RPC returns ONLY the caller's latest reaction per slide.
create function public.my_slide_feedback(p_course_id uuid)
returns jsonb language sql security definer stable
set search_path = public as $$
  select coalesce(
    jsonb_object_agg(
      t.slide_id,
      jsonb_build_object('reaction', t.reaction, 'comment', t.feedback_comment)),
    '{}'::jsonb)
  from (
    select distinct on (e.slide_id) e.slide_id, e.reaction, e.feedback_comment
    from public.learning_events e
    where e.user_id = (select auth.uid())
      and e.course_id = p_course_id
      and e.event_type = 'slide_feedback'
      and e.slide_id is not null and e.reaction is not null
    order by e.slide_id, e.server_ts desc
  ) t;
$$;
revoke all on function public.my_slide_feedback(uuid) from public, anon;
grant execute on function public.my_slide_feedback(uuid) to authenticated;

-- ─────────────────────── 4. rollup_content_feedback ─────────────────────────
-- Per slide AND per lesson (slide_id null = the lesson-level aggregate, i.e.
-- the sum over that lesson's per-(user,slide) latest reactions). Standard
-- rollup posture: (course, publication, version) keys, author-select RLS,
-- zero client writes, idempotent delete+insert.
create table public.rollup_content_feedback (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  publication_id  uuid not null references public.course_publications(id) on delete cascade,
  version         integer not null,
  lesson_id       uuid not null,
  block_id        uuid,
  slide_id        text,
  helpful_count   integer not null,
  confusing_count integer not null,
  -- 0..100 — raw stat lives in SQL; the FLAG threshold lives in TS
  -- (lib/analytics/flags.ts feedbackOutlier), per the single-source rule.
  confusing_pct   numeric,
  -- Newest-first sample of non-null comments from the LATEST-reaction set
  -- (a superseded toggle's comment drops out — latest wins uniformly):
  -- [{userId, reaction, comment, at}], capped (5 per slide, 8 per lesson).
  recent_comments jsonb not null default '[]'::jsonb,
  computed_at     timestamptz not null default now()
);
create unique index rollup_content_feedback_key
  on public.rollup_content_feedback(publication_id, lesson_id, coalesce(slide_id, ''));
alter table public.rollup_content_feedback enable row level security;
create policy "rollup_content_feedback_select" on public.rollup_content_feedback
  for select using (private.is_course_author(course_id));

create function private.recompute_content_feedback(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  pub record;
begin
  for pub in
    select id, version from public.course_publications where course_id = cid
  loop
    delete from public.rollup_content_feedback where publication_id = pub.id;

    -- Per-slide rows (latest reaction per (user, slide) — the dedupe).
    with latest as (
      select distinct on (e.user_id, e.slide_id)
        e.user_id, e.slide_id, e.lesson_id, e.block_id,
        e.reaction, e.feedback_comment, e.server_ts
      from public.learning_events e
      where e.publication_id = pub.id
        and e.event_type = 'slide_feedback'
        and e.slide_id is not null and e.reaction is not null
      order by e.user_id, e.slide_id, e.server_ts desc
    ),
    ranked as (
      select l.*, row_number() over
        (partition by l.slide_id order by l.server_ts desc) as rn
      from latest l
      where l.feedback_comment is not null
    )
    insert into public.rollup_content_feedback
      (course_id, publication_id, version, lesson_id, block_id, slide_id,
       helpful_count, confusing_count, confusing_pct, recent_comments)
    select
      cid, pub.id, pub.version,
      mode() within group (order by l.lesson_id),
      mode() within group (order by l.block_id),
      l.slide_id,
      (count(*) filter (where l.reaction = 'helpful'))::integer,
      (count(*) filter (where l.reaction = 'confusing'))::integer,
      round(100.0 * (count(*) filter (where l.reaction = 'confusing')) / count(*), 1),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'userId', r.user_id, 'reaction', r.reaction,
          'comment', r.feedback_comment, 'at', r.server_ts)
          order by r.server_ts desc)
        from ranked r
        where r.slide_id = l.slide_id and r.rn <= 5
      ), '[]'::jsonb)
    from latest l
    group by l.slide_id;

    -- Per-lesson rows (slide_id null): the same latest set, summed by lesson.
    with latest as (
      select distinct on (e.user_id, e.slide_id)
        e.user_id, e.slide_id, e.lesson_id,
        e.reaction, e.feedback_comment, e.server_ts
      from public.learning_events e
      where e.publication_id = pub.id
        and e.event_type = 'slide_feedback'
        and e.slide_id is not null and e.reaction is not null
      order by e.user_id, e.slide_id, e.server_ts desc
    ),
    ranked as (
      select l.*, row_number() over
        (partition by l.lesson_id order by l.server_ts desc) as rn
      from latest l
      where l.feedback_comment is not null
    )
    insert into public.rollup_content_feedback
      (course_id, publication_id, version, lesson_id, block_id, slide_id,
       helpful_count, confusing_count, confusing_pct, recent_comments)
    select
      cid, pub.id, pub.version,
      l.lesson_id, null, null,
      (count(*) filter (where l.reaction = 'helpful'))::integer,
      (count(*) filter (where l.reaction = 'confusing'))::integer,
      round(100.0 * (count(*) filter (where l.reaction = 'confusing')) / count(*), 1),
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'userId', r.user_id, 'reaction', r.reaction,
          'comment', r.feedback_comment, 'at', r.server_ts)
          order by r.server_ts desc)
        from ranked r
        where r.lesson_id = l.lesson_id and r.rn <= 8
      ), '[]'::jsonb)
    from latest l
    group by l.lesson_id;
  end loop;
end;
$$;

-- ───── 5. Wire into the two SMALL refresh callers (bodies verbatim + one
-- perform each — the big recompute is never restated) ────────────────────────
create or replace function public.refresh_course_analytics(cid uuid)
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
  perform private.file_threshold_findings(cid);
  perform private.recompute_course_reviews(cid);
  perform private.recompute_content_feedback(cid);
end;
$$;

create or replace function private.refresh_all_course_analytics()
returns void language plpgsql security definer set search_path = public as $$
declare
  c record;
begin
  for c in
    select distinct course_id from public.course_publications
  loop
    perform private.recompute_course_analytics(c.course_id);
    perform private.file_threshold_findings(c.course_id);
    perform private.recompute_course_reviews(c.course_id);
    perform private.recompute_content_feedback(c.course_id);
  end loop;
end;
$$;
