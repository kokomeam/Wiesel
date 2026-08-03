-- PERF-1 C3 (2/4) — hot SELECT policies: per-row helper → per-statement
-- semi-join (docs/perf/PERF-1_diagnosis.md §A3).
--
-- private.is_course_author(course_id) / private.can_read_course(course_id)
-- are STABLE SECURITY DEFINER functions taking a ROW column, so the planner
-- cannot inline them — they execute once per candidate row (EXPLAIN-confirmed:
-- 1.58 M index probes against 74 courses rows). The uncorrelated semi-join
-- form below is hashed ONCE per statement instead.
--
-- Scope: SELECT policies ONLY, on the tables where a statement routinely
-- touches many rows (studio reads every block of a course; marketing
-- dashboards aggregate thousands of analytics_event rows; realtime evaluates
-- change_set_items' policy per replicated row). Every INSERT/UPDATE/DELETE
-- policy — and every other table — keeps the helper: write paths are ~1
-- row/statement, where the helper's cost is irrelevant and its readability wins.
--
-- Semantics are UNCHANGED. courses' own RLS applies inside the subquery
-- (it is a plain expression over courses columns — no recursion), and its
-- predicate is identical to the branches below, so intersecting changes
-- nothing: authors see their rows; the public branch admits published+public
-- courses; anon callers get auth.uid() = null → author branch empty, exactly
-- like the helpers. Policy NAMES are preserved (drop + recreate).

-- ───────────── can_read_course tables (author OR published+public) ─────────

drop policy if exists "modules_select" on public.modules;
create policy "modules_select" on public.modules for select
  using (course_id in (
    select c.id from public.courses c
    where c.author_id = (select auth.uid())
       or (c.status = 'published' and c.visibility = 'public')
  ));

drop policy if exists "lessons_select" on public.lessons;
create policy "lessons_select" on public.lessons for select
  using (course_id in (
    select c.id from public.courses c
    where c.author_id = (select auth.uid())
       or (c.status = 'published' and c.visibility = 'public')
  ));

drop policy if exists "blocks_select" on public.blocks;
create policy "blocks_select" on public.blocks for select
  using (course_id in (
    select c.id from public.courses c
    where c.author_id = (select auth.uid())
       or (c.status = 'published' and c.visibility = 'public')
  ));

-- ──────────────────────── author-only tables ───────────────────────────────

drop policy if exists "analytics_event_select" on public.analytics_event;
create policy "analytics_event_select" on public.analytics_event for select
  using (course_id in (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  ));

drop policy if exists "learning_events_select" on public.learning_events;
create policy "learning_events_select" on public.learning_events for select
  using (course_id in (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  ));

drop policy if exists "change_set_items_select" on public.change_set_items;
create policy "change_set_items_select" on public.change_set_items for select
  using (course_id in (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  ));

drop policy if exists "change_sets_select" on public.change_sets;
create policy "change_sets_select" on public.change_sets for select
  using (course_id in (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  ));

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations for select
  using (course_id in (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  ));

drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages for select
  using (course_id in (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  ));

-- ────────────── course_reviews: merge two permissive SELECTs ───────────────
-- Advisor-flagged: two permissive policies for the same action are OR'd by
-- Postgres anyway but BOTH evaluate per row. One policy, same predicate:
-- learners read their own row; creators read reviews on their courses.
-- Write policies (insert/update, eligibility-gated) are untouched.

drop policy if exists "course_reviews_select_own" on public.course_reviews;
drop policy if exists "course_reviews_select_author" on public.course_reviews;
create policy "course_reviews_select" on public.course_reviews for select
  using (
    user_id = (select auth.uid())
    or course_id in (
      select c.id from public.courses c where c.author_id = (select auth.uid())
    )
  );
