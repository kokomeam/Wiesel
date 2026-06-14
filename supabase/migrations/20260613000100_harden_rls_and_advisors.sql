-- Hardening pass driven by the Supabase advisors after 0001.

-- 1) Relocate RLS helper + signup-trigger functions out of the API-exposed
--    `public` schema so they can't be invoked via /rest/v1/rpc. Policies and
--    the auth trigger reference them by OID, so they keep working after the move.
--    anon/authenticated need USAGE on the schema for RLS evaluation to call them.
create schema if not exists private;
grant usage on schema private to anon, authenticated;
alter function public.is_course_author(uuid) set schema private;
alter function public.can_read_course(uuid)  set schema private;
alter function public.handle_new_user()       set schema private;

-- 2) course-assets is a public bucket: drop the broad SELECT (list) policy.
--    Objects stay reachable by direct public URL; this only removed the ability
--    to enumerate every file in the bucket.
drop policy if exists "course_assets_public_read" on storage.objects;

-- 3) Split each `for all` write policy into insert/update/delete so the SELECT
--    action is governed by a single permissive policy (perf warning).
drop policy if exists "modules_write" on public.modules;
create policy "modules_insert" on public.modules for insert with check (private.is_course_author(course_id));
create policy "modules_update" on public.modules for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "modules_delete" on public.modules for delete using (private.is_course_author(course_id));

drop policy if exists "lessons_write" on public.lessons;
create policy "lessons_insert" on public.lessons for insert with check (private.is_course_author(course_id));
create policy "lessons_update" on public.lessons for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "lessons_delete" on public.lessons for delete using (private.is_course_author(course_id));

drop policy if exists "blocks_write" on public.blocks;
create policy "blocks_insert" on public.blocks for insert with check (private.is_course_author(course_id));
create policy "blocks_update" on public.blocks for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "blocks_delete" on public.blocks for delete using (private.is_course_author(course_id));
