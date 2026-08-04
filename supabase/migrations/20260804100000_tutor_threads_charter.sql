-- WiseSel — TUTOR-1 Wave 3 (W3.2): the tutor conversation, charter, and
-- escalation schema (Wave 3 order §2, Amendment R-6 — binding).
--
-- This migration adds the STRICT-REGIME learner-facing conversation surface (one
-- thread + append-only turns per learner per course), the CREATOR-owned course
-- charter (six knobs on tutor_course_settings + an append-only version history),
-- and the escalation-candidate consent surface. It EXTENDS tutor_course_settings
-- from 20260803100100 (concept_graph); it never re-creates it.
--
-- Two regimes coexist here, deliberately:
--   • STRICT (threads / turns / escalation candidates): the LEARNER owns the row.
--     Author policies are DELIBERATELY ABSENT — a creator never reads a named
--     learner's conversation or a pending escalation (creator visibility is
--     Wave 6). Assistant/instructor turns are SERVICE-ROLE-ONLY writes: no client
--     policy can represent them, so the model's replies can never be forged by a
--     learner. Learner turns are append-only + role-restricted at the write path.
--   • LEGACY author-RLS (tutor_charter_versions): the charter is creator-owned
--     config, so its history rides the concept_graph semi-join idiom (author
--     SELECT + INSERT), append-only (a BEFORE UPDATE always-raise trigger).
--
-- APPEND-ONLY is enforced in the DB, not by convention: tutor_turns and
-- tutor_charter_versions each carry a BEFORE UPDATE trigger that ALWAYS raises.
-- The trigger is deliberately NOT on DELETE so a course cascade (courses →
-- on delete cascade) can still clean these rows up.
--
-- Node ids on a turn (lesson_id / block_id / slide_id) are the snapshot node ids
-- (block/lesson are uuids; slide_id is a jsonb SHORT id → text), carried verbatim
-- like the learn-runtime tables so a turn's grounding stays joinable across
-- republishes. They have NO FK — the draft row may be deleted while a turn lives.

create extension if not exists moddatetime schema extensions;

-- ─────────────────────────────── 1. tutor_threads ───────────────────────────
-- One tutor conversation per (learner, course). The learner owns it; there is
-- NO author policy (strict regime — a creator never reads a named learner's
-- thread; creator visibility lands in Wave 6). SELECT/INSERT require BOTH
-- ownership AND an active enrollment (private.is_enrolled) — an un-enrolled user
-- has no tutor thread. NO update/delete policies (a thread is never rewritten;
-- course deletion cascades).
create table public.tutor_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  course_id  uuid not null references public.courses(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, course_id)  -- one thread per learner per course
);
create index tutor_threads_user_course_idx on public.tutor_threads(user_id, course_id);
create trigger tutor_threads_set_updated_at before update on public.tutor_threads
  for each row execute procedure extensions.moddatetime(updated_at);

-- ──────────────────────────────── 2. tutor_turns ────────────────────────────
-- The append-only transcript. user_id/course_id are denormalized (the owner +
-- the course) so RLS authorizes in one hop without joining tutor_threads.
--
-- role is one of learner / assistant / instructor. A learner may INSERT only a
-- role='learner' turn (the with-check pins it); assistant/instructor rows are
-- SERVICE-ROLE-ONLY writes (the model's reply, an instructor answer) — no client
-- policy can create them, so they are unforgeable from a learner session.
--
-- grounding is the Wave-3 OUTPUT CONTRACT: cited anchors + the grounded/
-- supplemental span map the prompt-assembly layer emits. rung is the escalation
-- ladder rung (0–4) the turn resolved at. response_id is the provider response id
-- stored when TUTOR_ENABLE_CHAINING is on (the P-3 chaining seam).
create table public.tutor_turns (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references public.tutor_threads(id) on delete cascade,
  user_id        uuid not null,  -- denormalized owner (RLS in one hop)
  course_id      uuid not null,  -- denormalized course (RLS in one hop)
  role           text not null check (role in ('learner','assistant','instructor')),
  content        text not null check (char_length(content) between 1 and 20000),
  publication_id uuid not null,
  version        integer not null,
  lesson_id      uuid,
  block_id       uuid,
  slide_id       text,           -- jsonb SHORT id → text (not a uuid)
  grounding      jsonb not null default '{}'::jsonb,  -- cited anchors + grounded/supplemental span map — the Wave-3 output contract
  rung           smallint check (rung is null or rung between 0 and 4),
  response_id    text,           -- provider response id when TUTOR_ENABLE_CHAINING stores turns — the P-3 seam
  created_at     timestamptz not null default now()
);
create index tutor_turns_thread_created_idx on public.tutor_turns(thread_id, created_at);

-- APPEND-ONLY: a turn is immutable once written. The trigger ALWAYS raises on
-- UPDATE — deliberately NOT on DELETE so the course cascade can clean turns up.
create function private.enforce_tutor_turns_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'tutor_turns are immutable';
end;
$$;
create trigger tutor_turns_immutable before update on public.tutor_turns
  for each row execute procedure private.enforce_tutor_turns_immutable();

-- ────────────── 3. charter columns on tutor_course_settings ──────────────────
-- The six creator-owned charter knobs (schema now; the UI lands in Wave 5).
-- current_charter_version_id points at the latest tutor_charter_versions row
-- (the FK is added AFTER that table exists, below).
alter table public.tutor_course_settings
  add column guidance_style text not null default 'guided_default'
    check (guidance_style in ('socratic_strict','guided_default','answer_forward')),
  add column course_canon text not null default 'strict'
    check (course_canon in ('strict','open')),
  add column scope text not null default 'course_only'
    check (scope in ('course_only','course_plus_adjacent')),
  add column tone_notes text
    check (tone_notes is null or char_length(tone_notes) <= 500),
  add column assessment_help text not null default 'concept_review_only'
    check (assessment_help in ('block','concept_review_only')),
  add column escalation_sensitivity text not null default 'default'
    check (escalation_sensitivity in ('low','default','high')),
  add column current_charter_version_id uuid;

-- ────────────────────────── 4. tutor_charter_versions ───────────────────────
-- Append-only history of the full charter at each write. LEGACY author-RLS
-- (creator-owned config history): author SELECT + INSERT via the semi-join
-- idiom; NO update/delete policy + a BEFORE UPDATE always-raise trigger. snapshot
-- is the FULL charter as serialized at write time (the version-row payload).
create table public.tutor_charter_versions (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses(id) on delete cascade,
  actor      uuid not null,
  snapshot   jsonb not null,  -- the full charter at write time
  created_at timestamptz not null default now()
);
create index tutor_charter_versions_course_created_idx
  on public.tutor_charter_versions(course_id, created_at desc);

-- APPEND-ONLY: a version row is immutable. Always-raise on UPDATE (not DELETE —
-- the course cascade must still clean it up).
create function private.enforce_tutor_charter_versions_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'tutor_charter_versions are immutable';
end;
$$;
create trigger tutor_charter_versions_immutable before update on public.tutor_charter_versions
  for each row execute procedure private.enforce_tutor_charter_versions_immutable();

-- Now that tutor_charter_versions exists, wire the settings pointer's FK.
alter table public.tutor_course_settings
  add constraint tutor_course_settings_charter_version_fkey
  foreign key (current_charter_version_id)
  references public.tutor_charter_versions(id);

-- ─────────────────────── 5. tutor_escalation_candidates ──────────────────────
-- A learner escalation the tutor raised — the CONSENT surface for handing a
-- question (and the tutor's proposed answer) to a human instructor. The learner
-- owns the row and may flip ONLY its status through the consent ladder
-- (consent_pending → {consented,withdrawn}). Candidates are WRITTEN by the
-- service role (the propose_escalation tool) — there is NO client insert policy.
--
-- STRICT REGIME: there is DELIBERATELY no author policy AT ALL in this wave —
-- while consent_pending a creator must not see the candidate, and creator
-- visibility (only after consent) is a Wave 6 concern. Zero author policy here.
create table public.tutor_escalation_candidates (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  course_id             uuid not null references public.courses(id) on delete cascade,
  node_ids              jsonb not null default '[]'::jsonb,
  anchors               jsonb not null default '[]'::jsonb,
  learner_question      text not null check (char_length(learner_question) <= 4000),
  rung_trail            jsonb not null default '[]'::jsonb,
  tutor_proposed_answer text check (tutor_proposed_answer is null or char_length(tutor_proposed_answer) <= 8000),
  status                text not null default 'consent_pending'
    check (status in ('consent_pending','consented','withdrawn')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index tutor_escalation_candidates_user_course_idx
  on public.tutor_escalation_candidates(user_id, course_id);
create trigger tutor_escalation_candidates_set_updated_at
  before update on public.tutor_escalation_candidates
  for each row execute procedure extensions.moddatetime(updated_at);

-- STATUS-ONLY UPDATE (the homework_submissions pattern, verbatim): once written,
-- ONLY the status column may change — and only through the legal consent
-- transitions consent_pending → {consented,withdrawn}. Any other column change,
-- or an illegal transition (e.g. withdrawn → consented, or leaving a terminal
-- state), raises. updated_at is exempt (the moddatetime trigger sets it).
create function private.enforce_escalation_status_only()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.user_id               is distinct from old.user_id
     or new.course_id             is distinct from old.course_id
     or new.node_ids              is distinct from old.node_ids
     or new.anchors               is distinct from old.anchors
     or new.learner_question      is distinct from old.learner_question
     or new.rung_trail            is distinct from old.rung_trail
     or new.tutor_proposed_answer is distinct from old.tutor_proposed_answer
     or new.created_at            is distinct from old.created_at
  then
    raise exception 'tutor_escalation_candidates: only the status may change';
  end if;
  -- Legal transitions out of consent_pending only; both consented and withdrawn
  -- are terminal (no further status change).
  if new.status is distinct from old.status
     and not (old.status = 'consent_pending' and new.status in ('consented','withdrawn'))
  then
    raise exception 'tutor_escalation_candidates: illegal status transition % → %', old.status, new.status;
  end if;
  return new;
end;
$$;
create trigger tutor_escalation_candidates_status_only
  before update on public.tutor_escalation_candidates
  for each row execute procedure private.enforce_escalation_status_only();

-- ──────────────────────────────────── 6. RLS ────────────────────────────────
alter table public.tutor_threads                enable row level security;
alter table public.tutor_turns                  enable row level security;
alter table public.tutor_charter_versions       enable row level security;
alter table public.tutor_escalation_candidates  enable row level security;

-- tutor_threads — the learner reads/creates their OWN thread, and only while
-- enrolled. NO author policy (strict regime); NO update/delete policy.
create policy "tutor_threads_select" on public.tutor_threads for select
  using (user_id = (select auth.uid()) and private.is_enrolled(course_id));
create policy "tutor_threads_insert" on public.tutor_threads for insert
  with check (user_id = (select auth.uid()) and private.is_enrolled(course_id));

-- tutor_turns — the learner reads their OWN turns (and only while enrolled), and
-- may INSERT ONLY a role='learner' turn. assistant/instructor turns are
-- service-role writes: unrepresentable via any client policy. NO update/delete
-- policy (append-only, enforced by the trigger too); NO author policy.
create policy "tutor_turns_select" on public.tutor_turns for select
  using (user_id = (select auth.uid()) and private.is_enrolled(course_id));
create policy "tutor_turns_insert" on public.tutor_turns for insert
  with check (
    user_id = (select auth.uid())
    and role = 'learner'
    and private.is_enrolled(course_id)
  );

-- tutor_charter_versions — LEGACY author-RLS (creator-owned config history):
-- author SELECT + INSERT via the semi-join idiom. NO update/delete policy
-- (append-only; the trigger raises on UPDATE regardless).
create policy "tutor_charter_versions_select" on public.tutor_charter_versions for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "tutor_charter_versions_insert" on public.tutor_charter_versions for insert
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

-- tutor_escalation_candidates — the learner reads their OWN candidate and may
-- UPDATE it (the status-only trigger constrains that update to legal consent
-- transitions). NO insert policy (service-role writes via propose_escalation).
-- NO author policy at all in this wave (strict; creator visibility is Wave 6).
create policy "tutor_escalation_candidates_select" on public.tutor_escalation_candidates for select
  using (user_id = (select auth.uid()));
create policy "tutor_escalation_candidates_update" on public.tutor_escalation_candidates for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ─────────────────────────────────── comments ───────────────────────────────
comment on table public.tutor_threads is
  'One tutor conversation per (learner, course). Strict regime: learner-owned, enrollment-gated SELECT/INSERT; NO author policy (creator visibility is Wave 6); no update/delete.';
comment on table public.tutor_turns is
  'Append-only tutor transcript. Learner may INSERT only role=learner (with-check); assistant/instructor rows are service-role-only (unforgeable). Immutable via a BEFORE UPDATE always-raise trigger (NOT on DELETE — course cascade cleans up). grounding jsonb is the Wave-3 output contract (cited anchors + grounded/supplemental span map).';
comment on table public.tutor_charter_versions is
  'Append-only history of the full course charter at each write. Legacy author-RLS (creator-owned config): author SELECT+INSERT via the semi-join idiom; immutable via a BEFORE UPDATE always-raise trigger.';
comment on table public.tutor_escalation_candidates is
  'A tutor-raised escalation + its consent ladder. Learner-owned SELECT + status-only UPDATE (homework pattern: only status may change, legal transitions consent_pending→{consented,withdrawn}). Service-role writes the row (propose_escalation); NO author policy while pending — creator visibility is Wave 6.';
comment on column public.tutor_course_settings.current_charter_version_id is
  'Pointer to the latest tutor_charter_versions row (the applied charter). Set by applyCharterChange after the version row is written.';
