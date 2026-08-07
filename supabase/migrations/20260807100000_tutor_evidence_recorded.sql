-- WiseSel — TUTOR-1 Amendment A3 Wave 2: the tool-evidence spine.
--
-- ONE new event type, `tutor_evidence_recorded` (audit ruling R-4 — snake_case,
-- tutor_%-prefixed like every server tutor event): a structured learning-evidence
-- observation emitted when a tutor TOOL COMPLETION settles (checkUnderstanding
-- et al.), landing on the SAME learning_events table, riding the SAME Zod
-- contract and the SAME server-emit discipline (never a parallel path). It is
-- SERVER-emitted ONLY, through the single repository function
-- `recordToolEvidence` (lib/tutor/runtime/evidenceRecord.ts — ruling R-3: the
-- append-only deterministic-id upsert idiom; learning_events stays append-only,
-- no versioned UPDATE).
--
-- Ruling R-1: `node_id` is the concept node's uuid (concepts have NO slug);
-- misconception ids are model-proposed HUMAN-READABLE slugs, scoped per
-- (course, node) in the NEW `tutor_misconceptions` registry below.
--
-- THE CLIENT-BATCH INGEST RPC NEEDS NO CHANGE: `tutor_evidence_recorded`
-- matches the existing `event_type like 'tutor_%'` server-only reject guard in
-- ingest_learning_events (20260803110000 §5), so a browser-forged row is
-- already refused by name. Likewise the author-select policy's
-- `event_type not like 'tutor_%'` exclusion (20260803100000, R-9) already makes
-- per-row tool evidence invisible to creators — the ONLY creator read surface
-- is the cohort-floored `tutor_misconception_rollup` definer RPC below.
--
-- ⚠ latency_ms ALREADY EXISTS on learning_events (added 20260803100000 with its
-- own `>= 0` CHECK) — it is NOT re-added here. The two-sided
-- learning_events_tutor_call_check pinned it to tutor_model_call rows only, so
-- that constraint is re-created below with a tutor_evidence_recorded arm that
-- frees latency_ms (nullable tool latency) while keeping every other column of
-- the model-call family pinned.

-- ───────────── 1. learning_events: the 23rd event type ───────────────────────
-- Audit §3.2 recipe: drop + re-add the CHECK from the CURRENT body
-- (20260803110000, the latest — 22 types) with the new member appended.
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
    'content_engagement','tutor_evidence_recorded'));

-- ───────────── 2. New typed tool-evidence columns (all nullable, CHECKed) ────
-- node_id already exists (20260803110000). latency_ms already exists
-- (20260803100000, CHECK >= 0). reviewed_item_id is [FWD] — always null in A3
-- (the reviewed-item bank does not exist yet); the column lands now so the
-- contract is stable when it ships.
alter table public.learning_events
  add column tool_name text,
  add column outcome text
    check (outcome is null
           or outcome in ('demonstrated','partial','not_demonstrated')),
  add column misconception_slug text
    check (misconception_slug is null
           or char_length(misconception_slug) between 1 and 80),
  add column confidence text
    check (confidence is null or confidence in ('sure','unsure')),
  add column fade_level smallint
    check (fade_level is null or fade_level between 0 and 3),
  add column initiation text
    check (initiation is null
           or initiation in ('question','practice_request','invitation_accepted')),
  add column item_source text
    check (item_source is null or item_source in ('generated','reviewed')),
  add column reviewed_item_id uuid;  -- [FWD] always null in A3

-- ── 3a. OLD-column isolation, extended (re-created from the 20260803110000
--        body + ONE new arm): tutor_evidence_recorded carries node_id and NONE
--        of the OLD evidence columns (evidence_correct / hint_rung /
--        practice_item_ref / attempt_ordinal all null). ──────────────────────
alter table public.learning_events
  drop constraint learning_events_evidence_check;
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
      -- A3: a tool-completion evidence row carries the node and NONE of the
      -- old evidence columns (its own family is CHECKed in 3b below).
      when 'tutor_evidence_recorded' then
        node_id is not null and attempt_ordinal is null and hint_rung is null
        and evidence_correct is null and practice_item_ref is null
      -- every other event type: none of the five evidence columns.
      else
        node_id is null and attempt_ordinal is null and hint_rung is null
        and evidence_correct is null and practice_item_ref is null
    end);

-- ── 3b. NEW-column isolation (bidirectional): tutor_evidence_recorded carries
--        tool_name + outcome + initiation + item_source NOT NULL (node_id
--        NOT NULL rides 3a; misconception_slug / confidence / fade_level /
--        reviewed_item_id / latency_ms nullable), and NO other type carries any
--        of the new columns. latency_ms is governed by the re-created
--        tutor_call_check (3c) — it is legitimately shared with
--        tutor_model_call. ───────────────────────────────────────────────────
alter table public.learning_events
  add constraint learning_events_tool_evidence_check check (
    case when event_type = 'tutor_evidence_recorded'
      then tool_name is not null and outcome is not null
           and initiation is not null and item_source is not null
      else tool_name is null and outcome is null
           and misconception_slug is null and confidence is null
           and fade_level is null and initiation is null
           and item_source is null and reviewed_item_id is null
    end);

-- ── 3c. tutor_call_check re-created (body from 20260803100000): the else-arm
--        pinned latency_ms to tutor_model_call rows only, which would refuse a
--        tool-evidence row's optional latency. New arm: tutor_evidence_recorded
--        may carry latency_ms (nullable; its `>= 0` column CHECK from
--        20260803100000 still applies) but NONE of the model-call columns.
--        Every other type still carries none of the family, latency included. ─
alter table public.learning_events
  drop constraint learning_events_tutor_call_check;
alter table public.learning_events
  add constraint learning_events_tutor_call_check check (
    case event_type
      when 'tutor_model_call' then
        job_type is not null and model is not null
        and input_tokens is not null and output_tokens is not null
        and latency_ms is not null
        and course_id is not null
        and publication_id is null and version is null and lesson_id is null
        and metric_name is null
      when 'tutor_evidence_recorded' then
        job_type is null and model is null
        and input_tokens is null and cached_input_tokens is null
        and output_tokens is null and computed_cost_usd is null
        and learner_user_id is null
        -- latency_ms deliberately unconstrained here: nullable tool latency.
      else
        job_type is null and model is null
        and input_tokens is null and cached_input_tokens is null
        and output_tokens is null and computed_cost_usd is null
        and latency_ms is null and learner_user_id is null
    end);

-- ── 4. Envelope: tutor_evidence_recorded joins the tutor-evidence arm —
--       course+publication scoped with the lesson OPTIONAL (the tutor spans
--       lessons). Body from 20260803110000 with the one member appended. ──────
alter table public.learning_events drop constraint learning_events_envelope_check;
alter table public.learning_events
  add constraint learning_events_envelope_check check (
    event_type like 'comms_email_%'
    or event_type = 'perf_vital'
    or event_type = 'tutor_model_call'
    or (event_type in ('practice_answer','hint_request','self_report','tutor_inference',
                       'tutor_evidence_recorded')
        and publication_id is not null and version is not null)
    or (publication_id is not null and version is not null and lesson_id is not null));
-- The course CHECK (course_id not null or perf_vital) is unchanged — the new
-- type carries course_id, so it satisfies it already.

-- ── 5. The refold's read path: extend the partial evidence index with the new
--       type (same name, re-created — the loader's `.in()` list gains it too). ─
drop index if exists public.learning_events_evidence_idx;
create index learning_events_evidence_idx
  on public.learning_events (user_id, course_id, server_ts)
  where event_type in (
    'practice_answer','hint_request','self_report','tutor_inference',
    'content_engagement','tutor_evidence_recorded');

comment on constraint learning_events_evidence_check on public.learning_events is
  'Wave-2 evidence column isolation (+A3 tutor_evidence_recorded): each evidence type carries exactly its own of {node_id,attempt_ordinal,hint_rung,evidence_correct,practice_item_ref}; every other type carries none. tutor_evidence_recorded carries node_id only — its own family is learning_events_tool_evidence_check.';
comment on constraint learning_events_tool_evidence_check on public.learning_events is
  'A3 tool-evidence column isolation, bidirectional: tutor_evidence_recorded requires tool_name/outcome/initiation/item_source (misconception_slug/confidence/fade_level/reviewed_item_id/latency_ms nullable); no other type carries any of the new columns. reviewed_item_id is [FWD] — always null in A3.';

/* ─────────────────────────── tutor_misconceptions ────────────────────────────
 * The misconception REGISTRY (ruling R-1): one row per (course, concept node,
 * human-readable slug). Slugs are model-proposed and normalized in TS
 * (normalizeMisconceptionSlug — lowercase, hyphenated, [a-z0-9-], ≤80);
 * get-or-create is race-safe (`on conflict do nothing` + re-select) through the
 * service role — the version column carries the row's optimistic-write
 * discipline for later curation waves (A3-21: the registry is where REAL
 * version conflicts live; learning_events stays append-only).
 *
 * RLS: author SELECT via the per-statement semi-join idiom (20260717100100 /
 * 20260803100100 convention); ZERO client write policies — the service role
 * (recordToolEvidence) is the only writer. */
create extension if not exists moddatetime schema extensions;

create table public.tutor_misconceptions (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses(id) on delete cascade,
  node_id    uuid not null references public.concept_nodes(id) on delete cascade,
  slug       text not null check (char_length(slug) between 1 and 80),
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, node_id, slug)
);
create index tutor_misconceptions_course_node_idx
  on public.tutor_misconceptions(course_id, node_id);
create trigger tutor_misconceptions_set_updated_at before update on public.tutor_misconceptions
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.tutor_misconceptions enable row level security;
create policy "tutor_misconceptions_select" on public.tutor_misconceptions for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
-- NO insert/update/delete policy — the service role is the only writer. Intentional.

comment on table public.tutor_misconceptions is
  'Misconception registry (A3 Wave 2, ruling R-1): model-proposed human-readable slugs scoped per (course, concept node). Author SELECT only; ZERO client write policies — recordToolEvidence (service role) is the sole writer, get-or-create race-safe via on-conflict-do-nothing + re-select.';

/* ───────────────────── tutor_misconception_rollup ────────────────────────────
 * The creator read surface for misconceptions (A3-23). SECURITY DEFINER,
 * author-gated exactly like the existing console RPCs (raises for a non-author;
 * a null auth.uid() = service_role caller is allowed — the cron/console-server
 * convention); PUBLIC/anon revoked below.
 *
 * Grouping: tutor_evidence_recorded rows per (node_id, misconception_slug),
 * misconception_slug NOT NULL. V1 SEMANTICS (kept simple, documented):
 *   learner_count  = distinct users who EVER emitted that (node, slug) with
 *                    outcome != 'demonstrated' — no latest-wins fold in v1.
 *   evidence_count = ALL tutor_evidence_recorded rows in the (node, slug)
 *                    group, any outcome.
 *   cohort_size    = distinct users with ANY tutor_evidence_recorded row on
 *                    the course (same value on every returned row).
 *
 * FLOOR SEMANTICS (Amendment D-4 + A3 §6): rows with learner_count < 5 are
 * OMITTED entirely, and when cohort_size < 5 the function returns NOTHING AT
 * ALL (not even the cohort size). The A3 §6 "< 20 ⇒ raw counts only" rule is a
 * DISPLAY rule — this RPC always returns raw counts + cohort_size and the UI
 * decides (lib/analytics/misconceptions.ts misconceptionCountDisplay). */
create function public.tutor_misconception_rollup(p_course_id uuid)
returns table (
  node_id            uuid,
  node_title         text,
  misconception_slug text,
  learner_count      integer,
  evidence_count     integer,
  cohort_size        integer
)
language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid    uuid := (select auth.uid());
  v_cohort integer;
begin
  -- Author gate (console-RPC convention): an authenticated non-author raises;
  -- a null uid (service_role) is allowed.
  if v_uid is not null then
    if not exists (
      select 1 from public.courses c
      where c.id = p_course_id and c.author_id = v_uid
    ) then
      raise exception 'not the course author';
    end if;
  end if;

  select count(distinct e.user_id)::integer into v_cohort
  from public.learning_events e
  where e.course_id = p_course_id
    and e.event_type = 'tutor_evidence_recorded';

  -- D-4: below the disclosure floor the function reveals NOTHING — not even
  -- the cohort size.
  if v_cohort is null or v_cohort < 5 then
    return;
  end if;

  return query
  select
    e.node_id,
    n.title,
    e.misconception_slug,
    (count(distinct e.user_id) filter (where e.outcome <> 'demonstrated'))::integer,
    count(*)::integer,
    v_cohort
  from public.learning_events e
  join public.concept_nodes n on n.id = e.node_id
  where e.course_id = p_course_id
    and e.event_type = 'tutor_evidence_recorded'
    and e.misconception_slug is not null
  group by e.node_id, n.title, e.misconception_slug
  -- Per-row disclosure floor: a (node, slug) held by < 5 learners is OMITTED.
  having (count(distinct e.user_id) filter (where e.outcome <> 'demonstrated')) >= 5
  order by 4 desc, 5 desc, 3 asc;
end;
$$;

revoke all on function public.tutor_misconception_rollup(uuid) from public, anon;
grant execute on function public.tutor_misconception_rollup(uuid) to authenticated, service_role;

comment on function public.tutor_misconception_rollup(uuid) is
  'Author-gated misconception rollup (A3-23). Cohort-floored >= 5 BOTH ways: sub-floor (node,slug) rows omitted; sub-floor course returns nothing. Raw counts + cohort_size always returned — the "<20 => raw counts only" rule is display-side. learner_count = distinct users ever holding the (node,slug) with outcome != demonstrated (v1, documented).';
