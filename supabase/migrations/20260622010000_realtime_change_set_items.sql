-- Live render — stream staged change-set items to the editor as the agent builds.
--
-- Adds the staging table to the `supabase_realtime` publication so the studio's
-- Supabase Realtime subscription (lib/editor/useChangeSetRealtime.ts) receives an
-- INSERT the moment a block is staged for review. RLS still governs which rows a
-- client may receive (change_set_items SELECT is author-only via
-- private.is_course_author(course_id)), so this exposes nothing new — it only turns
-- on the realtime feed for rows the author can already read.
--
-- INSERT-only subscription needs no `replica identity full` (the NEW row is checked
-- against RLS). Idempotent-guarded so a re-run is a no-op.
--
-- ⚠ Proposed for human review. Apply when ready; the live-render feature also works
--   without it (the agent's SSE stream drives a fallback re-sync), so this migration
--   is a progressive enhancement, not a hard dependency.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'change_set_items'
  ) then
    alter publication supabase_realtime add table public.change_set_items;
  end if;
end
$$;
