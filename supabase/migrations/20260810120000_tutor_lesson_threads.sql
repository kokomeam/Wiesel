-- TUTOR-1 — Amendment A4, Wave 1: LESSON-SCOPED tutor threads.
--
-- Re-scopes the tutor conversation from ONE thread per (learner, course) to ONE
-- ACTIVE thread per (learner, LESSON), plus a single ACTIVE general (null-lesson)
-- thread per (learner, course) for tutor turns sent outside a lesson (the course
-- landing). Adds the compaction seam (a rolling summary + a fold cursor) and an
-- archive marker so "Start fresh" ARCHIVES rather than deletes (A4-7).
--
-- ── DECISIONS (Wave 0 audit §Deviations; approved) ───────────────────────────
--  • lesson_id has NO FK. The tutor tables deliberately carry no FK to draft
--    content ("the draft row may be deleted while a turn lives" — the base
--    migration 20260804100000 comment on tutor_turns.lesson_id). lesson_id here
--    is the snapshot/draft node id, matching tutor_turns.lesson_id.
--  • The old UNIQUE(user_id, course_id) is DROPPED (it would otherwise forbid a
--    second lesson's thread AND break ensureThread's onConflict). It is replaced
--    by TWO PARTIAL uniques that exclude archived rows (so archive-then-reopen
--    for the same lesson is legal).
--  • Backfill attributes a legacy thread to a lesson ONLY when its turns name
--    exactly one lesson; every other legacy thread (multi-lesson or lesson-less)
--    stays lesson_id NULL — a readable general thread that is never extended
--    (opening a lesson mints a fresh per-lesson thread beside it).
--
-- ── ROLLBACK (clean immediately post-apply; see note) ────────────────────────
--   drop index if exists public.tutor_threads_user_lesson_idx;
--   drop index if exists public.tutor_threads_user_course_general_active_uidx;
--   drop index if exists public.tutor_threads_user_lesson_active_uidx;
--   drop index if exists public.tutor_threads_user_course_idx;
--   alter table public.tutor_threads
--     add constraint tutor_threads_user_id_course_id_key unique (user_id, course_id);
--   create index tutor_threads_user_course_idx on public.tutor_threads(user_id, course_id);
--   alter table public.tutor_threads
--     drop column compacted_through_turn,
--     drop column compaction_summary,
--     drop column archived_at,
--     drop column lesson_id;
--   NOTE: re-adding UNIQUE(user_id, course_id) is clean right after apply (backfill
--   preserves ≤1 row per (user,course)); once per-lesson threads accumulate,
--   collapsing to one-per-course would first require choosing a survivor per pair.

-- 1. New columns.
alter table public.tutor_threads
  add column lesson_id             uuid,        -- snapshot node id; NO FK (no-FK-to-draft convention)
  add column archived_at           timestamptz, -- A4-7: null = active; set = archived ("Start fresh")
  add column compaction_summary    text,        -- A4-4: rolling summary of folded turns; null until first compaction
  add column compacted_through_turn integer;    -- A4-4: count of oldest turns (created_at asc) folded into the summary

comment on column public.tutor_threads.lesson_id is
  'A4: the lesson this thread is scoped to (snapshot node id, NO FK — the draft row may vanish). NULL = a general course-level thread (a turn sent outside a lesson, or a legacy pre-A4 thread).';
comment on column public.tutor_threads.archived_at is
  'A4-7: when set, the thread is archived (Start fresh) — still queryable, never extended; excluded from the active partial uniques so a fresh thread can open for the same lesson.';
comment on column public.tutor_threads.compaction_summary is
  'A4-4: rolling LLM summary of the turns folded past compacted_through_turn. NULL until the first compaction. The full transcript stays in tutor_turns for display.';
comment on column public.tutor_threads.compacted_through_turn is
  'A4-4: the count of oldest turns (created_at asc) represented by compaction_summary. NULL/0 = nothing folded yet.';

-- 2. Backfill: attribute a legacy thread to a lesson iff its turns name EXACTLY
--    one lesson. (min/max do not exist for uuid; array_agg(distinct)[1] is the
--    single distinct value under the count=1 guard.)
update public.tutor_threads t
set lesson_id = sub.lesson_id
from (
  select thread_id, (array_agg(distinct lesson_id))[1] as lesson_id
  from public.tutor_turns
  where lesson_id is not null
  group by thread_id
  having count(distinct lesson_id) = 1
) sub
where t.id = sub.thread_id
  and t.lesson_id is null;

-- 3. Re-scope: drop the (user, course) unique + its redundant btree.
alter table public.tutor_threads drop constraint tutor_threads_user_id_course_id_key;
drop index if exists public.tutor_threads_user_course_idx;

-- 4. New uniqueness — ONE ACTIVE thread per (user, lesson), and ONE ACTIVE
--    general (null-lesson) thread per (user, course). Both EXCLUDE archived rows.
create unique index tutor_threads_user_lesson_active_uidx
  on public.tutor_threads (user_id, lesson_id)
  where lesson_id is not null and archived_at is null;

create unique index tutor_threads_user_course_general_active_uidx
  on public.tutor_threads (user_id, course_id)
  where lesson_id is null and archived_at is null;

-- 5. Supporting indexes — course-scoped reads (outline/home/resume) + the
--    lesson resolver lookup.
create index tutor_threads_user_course_idx
  on public.tutor_threads (user_id, course_id);

create index tutor_threads_user_lesson_idx
  on public.tutor_threads (user_id, lesson_id)
  where lesson_id is not null;
