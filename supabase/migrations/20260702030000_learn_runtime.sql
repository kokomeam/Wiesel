-- CourseGen Pro — Student learning runtime (Milestone 2 of the publishing phase).
--
-- Adds the tables the /learn/* runtime writes: per-lesson progress, graded quiz
-- attempts (+ per-question responses), and homework submissions. Attempt/response
-- tables follow the Milestone 3 analytics column spec so instrumentation later
-- only ADDS events, never reshapes these.
--
-- Trust model:
--   • Grading is SERVER-SIDE ONLY. quiz_answer_keys stays invisible to every
--     client role; the grading route reads it with the service-role client and
--     inserts attempts/responses itself. There are therefore NO client
--     insert/update policies on quiz_attempts / question_responses — a client
--     can never write a score.
--   • learn_progress is likewise server-written only ("updated server-side on
--     meaningful actions"): clients report actions to /api/learn/progress, the
--     server recomputes status/pct from the completion rule and persists.
--     Clients (student + course author) may only SELECT.
--   • homework_submissions ARE client-inserted (a student submitting their own
--     work is not a trust issue) — RLS pins user_id to auth.uid() and requires
--     an active enrollment. After insert, a trigger makes review status the
--     ONLY mutable thing (the author can mark reviewed; nobody can rewrite a
--     student's submitted content, and a student can't mark themselves reviewed).
--   • Homework files ride in the existing PUBLIC `course-assets` bucket under
--     the student's own {uid}/homework/… folder — the existing
--     course_assets_owner_insert/update/delete policies already enforce the
--     per-user path, and bucket listing is disabled (unguessable direct URLs).
--
-- Node ids (lesson_id / block_id / question_id) are the draft row ids preserved
-- verbatim in snapshots, so progress and attempts stay joinable across
-- republishes. lesson_id/block_id have NO FK: the draft row may be deleted later
-- while the publication (and the student's history) lives on.

-- ─────────────────────────── 1. learn_progress ─────────────────────────────
create table public.learn_progress (
  id               uuid primary key default gen_random_uuid(),
  course_id        uuid not null references public.courses(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  lesson_id        uuid not null,
  status           text not null default 'not_started'
                     check (status in ('not_started','in_progress','completed')),
  -- 0–100, server-computed from the completion rule (never client-supplied).
  pct              numeric not null default 0 check (pct >= 0 and pct <= 100),
  -- Server-merged trackable state the completion rule reads:
  --   { "viewedSlides": { "<deckBlockId>": ["<slideId>", …] },
  --     "videoPct":     { "<videoBlockId>": 0–100 },
  --     "viewedBlocks": ["<blockId>", …],           -- decks/imported decks paged to the end
  --     "markedComplete": true }                    -- explicit control for untrackable lessons
  progress_state   jsonb not null default '{}'::jsonb,
  last_activity_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, course_id, lesson_id)
);
create index learn_progress_course_idx on public.learn_progress(course_id);
create index learn_progress_user_course_idx on public.learn_progress(user_id, course_id);
create trigger learn_progress_set_updated_at before update on public.learn_progress
  for each row execute procedure extensions.moddatetime(updated_at);

-- ─────────────────────────── 2. quiz_attempts ──────────────────────────────
create table public.quiz_attempts (
  id             uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.course_publications(id) on delete cascade,
  version        integer not null,
  -- Denormalized for RLS/indexes (derivable via publication_id; kept in sync by
  -- the server route, which is the only writer).
  course_id      uuid not null references public.courses(id) on delete cascade,
  block_id       uuid not null,
  user_id        uuid not null references auth.users(id) on delete cascade,
  -- 1-based per (user, block) across ALL versions — block ids are stable, so a
  -- retake after a republish is attempt N+1, not a fresh attempt 1.
  attempt_number integer not null check (attempt_number >= 1),
  score          integer not null check (score >= 0),
  max_score      integer not null check (max_score >= 1),
  started_at     timestamptz not null default now(),
  submitted_at   timestamptz not null default now(),
  unique (user_id, block_id, attempt_number)
);
create index quiz_attempts_course_idx on public.quiz_attempts(course_id);
create index quiz_attempts_user_block_idx on public.quiz_attempts(user_id, block_id);
create index quiz_attempts_publication_idx on public.quiz_attempts(publication_id);

create table public.question_responses (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid not null references public.quiz_attempts(id) on delete cascade,
  question_id uuid not null,
  -- The learner's raw answer, shaped per question kind (see lib/learn/schemas.ts).
  response    jsonb not null,
  correct     boolean not null,
  -- Client-reported think time; nullable until Milestone 3 instruments it.
  time_ms     integer check (time_ms is null or time_ms >= 0),
  unique (attempt_id, question_id)
);
create index question_responses_attempt_idx on public.question_responses(attempt_id);

-- ──────────────────────── 3. homework_submissions ──────────────────────────
create table public.homework_submissions (
  id             uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.course_publications(id) on delete cascade,
  course_id      uuid not null references public.courses(id) on delete cascade,
  block_id       uuid not null,
  user_id        uuid not null references auth.users(id) on delete cascade,
  -- { "text": "…", "exerciseId": "…"? } — Zod-validated server shape.
  content        jsonb not null,
  -- Storage object paths in course-assets under the student's {uid}/homework/… folder.
  file_paths     text[] not null default '{}',
  status         text not null default 'submitted'
                   check (status in ('submitted','reviewed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index homework_submissions_course_idx on public.homework_submissions(course_id, status);
create index homework_submissions_user_idx on public.homework_submissions(user_id, course_id);
create index homework_submissions_block_idx on public.homework_submissions(block_id);
create trigger homework_submissions_set_updated_at before update on public.homework_submissions
  for each row execute procedure extensions.moddatetime(updated_at);

-- A submission is immutable once made, EXCEPT the review status (+ updated_at
-- via the moddatetime trigger). Enforced in the DB so no policy mistake can
-- ever let content be rewritten after submission.
create function private.enforce_submission_review_only()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.publication_id is distinct from old.publication_id
     or new.course_id   is distinct from old.course_id
     or new.block_id    is distinct from old.block_id
     or new.user_id     is distinct from old.user_id
     or new.content     is distinct from old.content
     or new.file_paths  is distinct from old.file_paths
     or new.created_at  is distinct from old.created_at
  then
    raise exception 'homework_submissions: only the review status may change after submission';
  end if;
  return new;
end;
$$;
create trigger homework_submissions_review_only before update on public.homework_submissions
  for each row execute procedure private.enforce_submission_review_only();

-- ─────────────────────── 4. RLS helper: is_enrolled ────────────────────────
-- SECURITY DEFINER so policies can check enrollment without recursing through
-- enrollments RLS. Completed learners keep access (Teachable convention).
create function private.is_enrolled(cid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.enrollments
    where course_id = cid
      and user_id = (select auth.uid())
      and status in ('active','completed')
  );
$$;

-- ──────────────────────────────── 5. RLS ───────────────────────────────────
alter table public.learn_progress       enable row level security;
alter table public.quiz_attempts        enable row level security;
alter table public.question_responses   enable row level security;
alter table public.homework_submissions enable row level security;

-- learn_progress: read own; the course author reads their learners' progress.
-- NO client insert/update/delete — the progress route (service role) is the
-- only writer, because status/pct come from the server-side completion rule.
create policy "learn_progress_select" on public.learn_progress for select
  using (user_id = (select auth.uid()) or private.is_course_author(course_id));

-- quiz_attempts / question_responses: read own; author reads their courses'.
-- NO client writes — grading is server-side (service role) only.
create policy "quiz_attempts_select" on public.quiz_attempts for select
  using (user_id = (select auth.uid()) or private.is_course_author(course_id));
create policy "question_responses_select" on public.question_responses for select
  using (exists (
    select 1 from public.quiz_attempts a
    where a.id = attempt_id
      and (a.user_id = (select auth.uid()) or private.is_course_author(a.course_id))
  ));

-- homework_submissions: a student inserts their own (must be enrolled and the
-- publication must belong to the course), reads their own; the author reads
-- and may update (the trigger restricts that update to the review status).
create policy "homework_submissions_select" on public.homework_submissions for select
  using (user_id = (select auth.uid()) or private.is_course_author(course_id));
create policy "homework_submissions_insert" on public.homework_submissions for insert
  with check (
    user_id = (select auth.uid())
    and private.is_enrolled(course_id)
    and exists (
      select 1 from public.course_publications p
      where p.id = publication_id and p.course_id = homework_submissions.course_id
    )
  );
create policy "homework_submissions_update" on public.homework_submissions for update
  using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));
-- No delete: submissions are a permanent record (course deletion cascades).

-- ───────────────────── 6. marketplace_listings RPC ─────────────────────────
-- Card metadata for every LIVE + PUBLIC publication. SECURITY DEFINER because
-- the pieces PostgREST can't compose in one query live behind different
-- policies: module/lesson counts require aggregating the snapshot jsonb, and
-- the creator's display name lives in profiles (self-readable only). Exposes
-- ONLY safe, public-by-design fields — never the snapshot body.
create function public.marketplace_listings()
returns table (
  publication_id uuid,
  course_id      uuid,
  slug           text,
  version        integer,
  title          text,
  description    text,
  level          text,
  audience       text,
  creator_name   text,
  module_count   integer,
  lesson_count   integer,
  published_at   timestamptz
)
language sql security definer stable set search_path = public as $$
  select
    p.id,
    p.course_id,
    p.slug,
    p.version,
    p.snapshot->'course'->>'title',
    p.snapshot->'course'->>'description',
    p.snapshot->'course'->>'level',
    p.snapshot->'course'->>'audience',
    coalesce(pr.display_name, 'A CourseGen educator'),
    coalesce(jsonb_array_length(p.snapshot->'modules'), 0),
    coalesce((
      select sum(jsonb_array_length(m->'lessons'))::integer
      from jsonb_array_elements(p.snapshot->'modules') as m
    ), 0),
    p.published_at
  from public.course_publications p
  left join public.profiles pr on pr.id = p.created_by
  where p.status = 'live' and p.visibility = 'public'
  order by p.published_at desc;
$$;
revoke all on function public.marketplace_listings() from public, anon;
grant execute on function public.marketplace_listings() to authenticated;
