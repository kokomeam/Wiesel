-- ============================================================================
-- ASSESSMENT RUNTIME — Phase 4 SCAFFOLD.  *** NOT APPLIED. DO NOT db push. ***
-- ============================================================================
-- Deliberately lives in supabase/drafts/ (NOT supabase/migrations/) so the
-- Supabase CLI never picks it up. Promote it to a real timestamped migration
-- only AFTER its two prerequisites exist:
--
--   1. Block PERSISTENCE — `public.blocks` rows actually exist (HANDOFF next
--      step #3). Until the editor persists, there are no block ids to attach
--      attempts/submissions to.
--   2. ENROLLMENTS — the learner↔course link (HANDOFF Phase-2 backend). The
--      `is_enrolled()` gate below depends on it; a minimal version is included
--      here so this file is self-consistent, but if the marketplace backend
--      already created `enrollments`, DELETE the enrollments block before
--      promoting this file.
--
-- Mirrors the conventions established in migrations 0001/0002: RLS on every
-- table, secure-by-default, SECURITY DEFINER gate functions in the non-exposed
-- `private` schema, money/scores as exact numerics, split write policies (no
-- `for all` overlap → avoids the multiple_permissive_policies advisor).
--
-- NOTE: question ids and rubric criterion/level ids live INSIDE
-- `blocks.content` jsonb (not their own tables), so responses/grades reference
-- them as plain text ids, validated in-app — there is no FK to enforce them.
-- A `blocks.type` check can't be enforced at the FK level either; the app (or a
-- trigger) must ensure quiz_block_id points at a quiz and homework_block_id at a
-- homework block.
-- ============================================================================

/* ───────────────── prerequisite: enrollments (see note above) ───────────── */
create table if not exists public.enrollments (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(id) on delete cascade,
  learner_id  uuid not null references auth.users(id) on delete cascade,
  enrolled_at timestamptz not null default now(),
  unique (course_id, learner_id)
);
create index if not exists enrollments_learner_idx on public.enrollments(learner_id);

-- Enrolment gate, sibling to private.is_course_author / can_read_course (0002).
create function private.is_enrolled(cid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.enrollments
    where course_id = cid and learner_id = (select auth.uid())
  );
$$;

/* ─────────────────────────────── quiz_attempts ──────────────────────────── */
create table public.quiz_attempts (
  id             uuid primary key default gen_random_uuid(),
  quiz_block_id  uuid not null references public.blocks(id) on delete cascade,
  course_id      uuid not null references public.courses(id) on delete cascade,
  learner_id     uuid not null references auth.users(id) on delete cascade,
  attempt_number integer not null default 1,
  started_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  score          numeric(7,2),
  max_score      numeric(7,2),
  passed         boolean,
  unique (quiz_block_id, learner_id, attempt_number)
);
create index quiz_attempts_block_idx   on public.quiz_attempts(quiz_block_id);
create index quiz_attempts_learner_idx on public.quiz_attempts(learner_id);
create index quiz_attempts_course_idx  on public.quiz_attempts(course_id);

/* ────────────────────────────── quiz_responses ──────────────────────────── */
create table public.quiz_responses (
  id             uuid primary key default gen_random_uuid(),
  attempt_id     uuid not null references public.quiz_attempts(id) on delete cascade,
  -- question id from blocks.content jsonb (no FK — see header note)
  question_id    text not null,
  -- shape depends on kind: {choiceId} | {choiceIds:[]} | {bool} | {text}
  response       jsonb not null default '{}'::jsonb,
  is_correct     boolean,
  points_awarded numeric(7,2),
  graded_at      timestamptz
);
create index quiz_responses_attempt_idx on public.quiz_responses(attempt_id);

/* ─────────────────────────── homework_submissions ───────────────────────── */
create table public.homework_submissions (
  id                uuid primary key default gen_random_uuid(),
  homework_block_id uuid not null references public.blocks(id) on delete cascade,
  course_id         uuid not null references public.courses(id) on delete cascade,
  learner_id        uuid not null references auth.users(id) on delete cascade,
  -- {kind:'text_response', text} | {kind:'file_upload', path} | {kind:'external_link', url}
  deliverable       jsonb not null default '{}'::jsonb,
  status            text not null default 'submitted'
                      check (status in ('draft', 'submitted', 'returned', 'graded')),
  submitted_at      timestamptz not null default now(),
  unique (homework_block_id, learner_id)
);
create index homework_submissions_block_idx   on public.homework_submissions(homework_block_id);
create index homework_submissions_learner_idx on public.homework_submissions(learner_id);
create index homework_submissions_course_idx  on public.homework_submissions(course_id);

/* ───────────────────────────── homework_grades ──────────────────────────── */
create table public.homework_grades (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.homework_submissions(id) on delete cascade,
  grader_id     uuid not null references auth.users(id) on delete cascade,
  -- [{criterionId, levelId, points}] referencing rubric ids in blocks.content
  rubric_scores jsonb not null default '[]'::jsonb,
  total         numeric(7,2),
  feedback      text,
  graded_at     timestamptz not null default now()
);
create index homework_grades_submission_idx on public.homework_grades(submission_id);

/* ─────────────────────────────────── RLS ────────────────────────────────── */
alter table public.enrollments          enable row level security;
alter table public.quiz_attempts        enable row level security;
alter table public.quiz_responses       enable row level security;
alter table public.homework_submissions enable row level security;
alter table public.homework_grades      enable row level security;

-- enrollments: learner sees own; course author sees their course's roster.
-- (insert is permissive here for dev; the real flow gates enrolment on a
--  completed purchase — tighten when Stripe lands.)
create policy "enrollments_select" on public.enrollments for select
  using (learner_id = (select auth.uid()) or private.is_course_author(course_id));
create policy "enrollments_insert" on public.enrollments for insert
  with check (learner_id = (select auth.uid()));
create policy "enrollments_delete" on public.enrollments for delete
  using (learner_id = (select auth.uid()) or private.is_course_author(course_id));

-- quiz_attempts: learner owns their attempts; author reads their course's.
create policy "quiz_attempts_select" on public.quiz_attempts for select
  using (learner_id = (select auth.uid()) or private.is_course_author(course_id));
create policy "quiz_attempts_insert" on public.quiz_attempts for insert
  with check (learner_id = (select auth.uid()) and private.is_enrolled(course_id));
create policy "quiz_attempts_update" on public.quiz_attempts for update
  using (learner_id = (select auth.uid())) with check (learner_id = (select auth.uid()));

-- quiz_responses: gated through the parent attempt.
create policy "quiz_responses_select" on public.quiz_responses for select
  using (exists (
    select 1 from public.quiz_attempts a
    where a.id = attempt_id
      and (a.learner_id = (select auth.uid()) or private.is_course_author(a.course_id))
  ));
create policy "quiz_responses_insert" on public.quiz_responses for insert
  with check (exists (
    select 1 from public.quiz_attempts a
    where a.id = attempt_id and a.learner_id = (select auth.uid())
  ));
create policy "quiz_responses_update" on public.quiz_responses for update
  using (exists (
    select 1 from public.quiz_attempts a
    where a.id = attempt_id and a.learner_id = (select auth.uid())
  ));

-- homework_submissions: learner owns; author reads their course's.
create policy "homework_submissions_select" on public.homework_submissions for select
  using (learner_id = (select auth.uid()) or private.is_course_author(course_id));
create policy "homework_submissions_insert" on public.homework_submissions for insert
  with check (learner_id = (select auth.uid()) and private.is_enrolled(course_id));
create policy "homework_submissions_update" on public.homework_submissions for update
  using (learner_id = (select auth.uid())) with check (learner_id = (select auth.uid()));

-- homework_grades: course author (grader) writes; learner reads grades on own work.
create policy "homework_grades_select" on public.homework_grades for select
  using (exists (
    select 1 from public.homework_submissions s
    where s.id = submission_id
      and (s.learner_id = (select auth.uid()) or private.is_course_author(s.course_id))
  ));
create policy "homework_grades_insert" on public.homework_grades for insert
  with check (
    grader_id = (select auth.uid())
    and exists (
      select 1 from public.homework_submissions s
      where s.id = submission_id and private.is_course_author(s.course_id)
    )
  );
create policy "homework_grades_update" on public.homework_grades for update
  using (exists (
    select 1 from public.homework_submissions s
    where s.id = submission_id and private.is_course_author(s.course_id)
  ));

-- ============================================================================
-- AUTO-GRADING DESIGN (client-first, pure)
-- ----------------------------------------------------------------------------
-- Grading is a pure function over the question schema (lib/course/types.ts),
-- so it runs client-side for instant feedback AND can later move into an edge
-- function for an authoritative server pass. Sketch (to live in
-- lib/course/grading.ts when Phase 4 is built):
--
--   gradeResponse(question, response): { isCorrect: boolean | null; points: number }
--     multiple_choice : response.choiceId === question.correctChoiceId
--     multi_select    : setEqual(response.choiceIds, question.correctChoiceIds)
--     true_false      : response.bool === question.correctAnswer
--     short_answer    : norm(response.text) ∈ norm([expectedAnswer, ...acceptedAnswers])
--                       else isCorrect=null  → needs manual review
--     points = isCorrect ? questionPoints(question) : 0   (null ⇒ ungraded)
--
--   gradeAttempt(quizBlock, responses):
--     score    = Σ points, max_score = quizTotalPoints(questions),
--     passed   = (score/max_score)*100 >= resolveQuizSettings(settings).passingScore,
--     where any null (short-answer) leaves the attempt "needs review".
--
-- Homework is rubric-scored by the author: each homework_grades.rubric_scores
-- entry picks one level per criterion; total = Σ chosen level.points, validated
-- against the block's rubric (criterionMaxPoints / rubricTotalPoints already in
-- lib/course/assessments.ts).
-- ============================================================================
