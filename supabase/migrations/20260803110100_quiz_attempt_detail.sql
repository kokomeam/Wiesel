-- WiseSel — TUTOR-1 Wave 2 (A): per-question quiz attempt detail for the mastery
-- refold, plus the single-transaction grading write.
--
-- quiz_attempt_detail is the STRICT-REGIME sibling of the legacy quiz_attempts /
-- question_responses tables (which stay UNTOUCHED). It denormalizes
-- (user, course, publication, block, question, correct) so the mastery refold
-- reads a learner's per-question history for a course WITHOUT joins. It carries
-- SELECTED OPTION IDS ONLY in response_summary — never any answer-key material.
--
-- Strict regime (unlike the legacy quiz_attempts author-readable posture):
--   • RLS enabled, ZERO policies. Service-role is the only writer; the learner
--     reads their OWN rows through the my_quiz_detail definer RPC. There is
--     DELIBERATELY no author policy — creators see cohort-floored aggregates
--     only (a later results migration), never a learner's per-question rows.
--
-- The attempt ordinal is NOT stored here — it is DERIVED downstream by
-- (created_at, id) ordering over a learner's rows for a block. Storing it would
-- duplicate quiz_attempts.attempt_number and risk drift.

-- ─────────────────────────── 1. quiz_attempt_detail ─────────────────────────
create table public.quiz_attempt_detail (
  id               uuid primary key default gen_random_uuid(),
  attempt_id       uuid not null references public.quiz_attempts(id) on delete cascade,
  -- Denormalized so the refold reads per (user, course) without joins.
  user_id          uuid not null,
  course_id        uuid not null,
  publication_id   uuid not null,
  block_id         uuid not null,
  -- Question ids are TEXT in this codebase (jsonb short ids, never uuids).
  question_id      text not null,
  correct          boolean not null,
  -- SELECTED OPTION IDS ONLY (mc:{selected} · ms:{selected:[]} · tf:{selected} ·
  -- sa:{text}). NEVER expected/accepted answers or any answer-key material.
  response_summary jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique (attempt_id, block_id, question_id)
);
create index quiz_attempt_detail_user_course_idx
  on public.quiz_attempt_detail(user_id, course_id, created_at);

-- ─────────────────────────────── 2. STRICT RLS ──────────────────────────────
-- Enable RLS with ZERO policies: SERVICE-ROLE WRITES ONLY (the record_quiz_attempt
-- RPC below). Learner-own reads go through the my_quiz_detail definer RPC.
-- There is DELIBERATELY no author SELECT policy — this is the strict regime,
-- unlike the legacy quiz_attempts (untouched) which the author can read. A
-- creator sees only cohort-floored mastery aggregates (a later results
-- migration), never a learner's per-question detail rows.
alter table public.quiz_attempt_detail enable row level security;

-- ─────────────────────── 3. my_quiz_detail (learner-own) ────────────────────
-- The learner's OWN per-question detail for a course (the my_slide_feedback
-- pattern). Authenticated-only; revoked from public + anon.
create function public.my_quiz_detail(p_course_id uuid)
returns table (
  attempt_id       uuid,
  block_id         uuid,
  question_id      text,
  correct          boolean,
  response_summary jsonb,
  created_at       timestamptz
)
language sql security definer stable set search_path = public as $$
  select d.attempt_id, d.block_id, d.question_id, d.correct,
         d.response_summary, d.created_at
  from public.quiz_attempt_detail d
  where d.course_id = p_course_id
    and d.user_id = (select auth.uid())
  order by d.created_at, d.id;
$$;
revoke all on function public.my_quiz_detail(uuid) from public, anon;
grant execute on function public.my_quiz_detail(uuid) to authenticated;

-- ─────────────────── 4. record_quiz_attempt — one transaction ────────────────
-- Today quizService inserts the attempt then the response rows SEPARATELY (not
-- atomic). This RPC folds attempt + responses + detail into ONE transaction,
-- SERVICE-ROLE ONLY (revoked from every request-scoped role). It computes
-- attempt_number IN SQL (coalesce(max)+1 per (user, block)) with a
-- unique-violation retry loop bounded at 2, inserts the response + detail rows,
-- and returns {attempt_id, attempt_number}.
--
-- Idempotent replay: the DETAIL insert uses
-- `on conflict (attempt_id, block_id, question_id) do nothing` — replaying the
-- SAME attempt payload (same p_attempt.id) re-inserts nothing (attempt +
-- responses + detail all keyed to that attempt id already exist). A full
-- re-grade is a DIFFERENT call (no attempt id → a fresh attempt N+1), which is a
-- legitimate new attempt, not a replay.
--
-- Contracts preserved from quizService: author-preview records NOTHING (the RPC
-- is simply not called), only ANSWERED questions get response rows (the caller
-- filters), attempt_number continuity across versions (per (user, block), block
-- ids are stable).
--
-- p_attempt  : { id?, publication_id, version, course_id, block_id, user_id,
--                score, max_score, started_at, submitted_at }
--   `id` optional — when present the attempt is inserted with that id so a
--   replay of the exact payload conflicts on the PK and is idempotent; when
--   absent a fresh id is generated (the normal first-write path).
-- p_responses: [{ question_id, response, correct, time_ms? }]  (ANSWERED only)
-- p_detail   : [{ question_id, correct, response_summary }]    (ANSWERED only)
create function public.record_quiz_attempt(
  p_attempt   jsonb,
  p_responses jsonb,
  p_detail    jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_attempt_id     uuid := coalesce((p_attempt->>'id')::uuid, gen_random_uuid());
  v_user_id        uuid := (p_attempt->>'user_id')::uuid;
  v_course_id      uuid := (p_attempt->>'course_id')::uuid;
  v_publication_id uuid := (p_attempt->>'publication_id')::uuid;
  v_block_id       uuid := (p_attempt->>'block_id')::uuid;
  v_version        integer := (p_attempt->>'version')::integer;
  v_score          integer := (p_attempt->>'score')::integer;
  v_max_score      integer := (p_attempt->>'max_score')::integer;
  v_started_at     timestamptz := coalesce((p_attempt->>'started_at')::timestamptz, now());
  v_submitted_at   timestamptz := coalesce((p_attempt->>'submitted_at')::timestamptz, now());
  v_attempt_number integer;
  v_inserted_id    uuid;
  v_existing       public.quiz_attempts%rowtype;
  v_tries          integer := 0;
begin
  -- Idempotent replay of the EXACT attempt (same id already recorded): return
  -- the existing attempt untouched; the detail insert below is a no-op too.
  if (p_attempt->>'id') is not null then
    select * into v_existing from public.quiz_attempts where id = v_attempt_id;
    if found then
      v_inserted_id := v_existing.id;
      v_attempt_number := v_existing.attempt_number;
    end if;
  end if;

  -- First write: compute attempt_number = max+1 per (user, block) across ALL
  -- versions (block ids are stable), with a bounded unique-violation retry loop.
  while v_inserted_id is null and v_tries < 2 loop
    v_tries := v_tries + 1;
    select coalesce(max(attempt_number), 0) + 1 into v_attempt_number
    from public.quiz_attempts
    where user_id = v_user_id and block_id = v_block_id;
    begin
      insert into public.quiz_attempts
        (id, publication_id, version, course_id, block_id, user_id,
         attempt_number, score, max_score, started_at, submitted_at)
      values
        (v_attempt_id, v_publication_id, v_version, v_course_id, v_block_id,
         v_user_id, v_attempt_number, v_score, v_max_score,
         v_started_at, v_submitted_at)
      returning id into v_inserted_id;
    exception when unique_violation then
      -- Two possible sources: the (user, block, attempt_number) race → re-read
      -- max and retry once; OR a concurrent REPLAY of the same attempt id (PK)
      -- → adopt the existing row instead of burning the retry budget.
      select * into v_existing from public.quiz_attempts where id = v_attempt_id;
      if found then
        v_inserted_id := v_existing.id;
        v_attempt_number := v_existing.attempt_number;
      else
        v_inserted_id := null;
      end if;
    end;
  end loop;

  if v_inserted_id is null then
    raise exception 'record_quiz_attempt: could not record the attempt';
  end if;

  -- Response rows (ANSWERED only — caller filters). Idempotent on replay.
  insert into public.question_responses (attempt_id, question_id, response, correct, time_ms)
  select
    v_inserted_id,
    r->>'question_id',
    r->'response',
    (r->>'correct')::boolean,
    nullif(r->>'time_ms','')::integer
  from jsonb_array_elements(coalesce(p_responses, '[]'::jsonb)) as r
  on conflict (attempt_id, question_id) do nothing;

  -- Detail rows (ANSWERED only). Idempotent replay via the unique triple.
  insert into public.quiz_attempt_detail
    (attempt_id, user_id, course_id, publication_id, block_id, question_id,
     correct, response_summary)
  select
    v_inserted_id, v_user_id, v_course_id, v_publication_id, v_block_id,
    d->>'question_id',
    (d->>'correct')::boolean,
    coalesce(d->'response_summary', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_detail, '[]'::jsonb)) as d
  on conflict (attempt_id, block_id, question_id) do nothing;

  return jsonb_build_object('attempt_id', v_inserted_id, 'attempt_number', v_attempt_number);
end;
$$;
-- Service-role only: the ONLY writer of the strict-regime detail table.
revoke all on function public.record_quiz_attempt(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_quiz_attempt(jsonb, jsonb, jsonb) to service_role;

comment on table public.quiz_attempt_detail is
  'Strict-regime per-question quiz detail for the mastery refold. RLS on, ZERO policies (service-role writes via record_quiz_attempt; learner-own reads via my_quiz_detail). response_summary carries selected option ids ONLY — never answer-key material. Attempt ordinal is DERIVED downstream by (created_at, id), never stored.';
comment on function public.record_quiz_attempt(jsonb, jsonb, jsonb) is
  'The single-transaction grading write (attempt + responses + detail). Service-role only. attempt_number = max+1 per (user, block) with a 2-bounded retry loop; detail/responses insert on-conflict-do-nothing for idempotent replay of the same attempt id.';
