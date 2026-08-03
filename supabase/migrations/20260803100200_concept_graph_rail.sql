-- TUTOR-1 W1.2B — extend the Accept/Reject change-set rail to the concept graph.
--
-- Doctrine (per 20260701000000_structural_change_set_items.sql): rather than add a
-- sibling table, EXTEND `change_set_items` so the single realtime feed, the RLS
-- policy set, and the all-or-nothing reject keep working over ONE stream. This
-- migration widens the rail to accept a NEW node_type, 'concept_graph', whose items
-- carry a concept-graph entity (node/edge/assumed-prior/snapshot-map) row on
-- before/after — NOT a course-document node.
--
-- ⚠ THE KEY INVARIANT: a concept_graph item is NOT a CoursePatch-revertable node.
-- Reject restores it through the DOMAIN-PARTITIONED entity path
-- (lib/tutor/railRestore.ts + rejectChangeSet's partition), NEVER the CoursePatch
-- pipeline. This migration is purely the DB-side widening (constraints + the studio
-- bundle RPC's pending filter); the reject logic lives in application code. The rail
-- is EXTENDED, never weakened — a graph item that fails to parse aborts the whole
-- reject exactly as a bad block item does.
--
-- ⚠ Proposed for human review. Apply when ready; regenerate lib/database.types.ts
--   afterwards (W1.2A owns that file). Idempotent-guarded so a re-run is a no-op.

-- 1. Widen the node_type CHECK to add 'concept_graph'.
--    The 20260701000000 migration added the column with an inline `check (node_type
--    in ('block','lesson','module'))`, which Postgres auto-names
--    `change_set_items_node_type_check`. Drop it and re-add the widened set.
alter table public.change_set_items
  drop constraint if exists change_set_items_node_type_check;
alter table public.change_set_items
  add constraint change_set_items_node_type_check
    check (node_type in ('block','lesson','module','concept_graph'));

-- 2. Widen the identity invariant: a concept_graph item, like lesson/module items,
--    carries its identity on node_id (the entity row's id; for snapshot_map rows the
--    node_id). Re-create the same-named constraint with the widened node_id arm.
alter table public.change_set_items
  drop constraint if exists change_set_items_identity_chk;
alter table public.change_set_items
  add constraint change_set_items_identity_chk check (
    (node_type = 'block' and block_id is not null) or
    (node_type in ('lesson','module','concept_graph') and node_id is not null)
  );

-- 3. Re-create public.studio_course_bundle with EXACTLY ONE change vs 20260717100500:
--    the pending_nodes filter includes 'concept_graph'. Body copied verbatim; grants
--    and behavior otherwise identical. (studioLoad.ts parses the widened node_type at
--    the schema boundary; concept_graph pending items are filtered out of the studio
--    outline surface there — they belong to the graph review UI, not the outline
--    sidebar.)
create or replace function public.studio_course_bundle(p_course_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_course jsonb;
  v_result jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  -- Author gate: never trust a client-supplied user id; a missing or
  -- non-authored course returns null (→ the page redirects to the gallery).
  select to_jsonb(c) into v_course
  from public.courses c
  where c.id = p_course_id and c.author_id = v_uid;
  if v_course is null then
    return null;
  end if;

  with pending as (
    select i.block_id, i.node_id, i.node_type, i.change_set_id, i.op, i.evidence
    from public.change_set_items i
    join public.change_sets s on s.id = i.change_set_id
    where s.course_id = p_course_id
      and s.status = 'pending'
  )
  select jsonb_build_object(
    'course', v_course,
    'modules', coalesce((
      select jsonb_agg(to_jsonb(m) order by m."order")
      from public.modules m where m.course_id = p_course_id), '[]'::jsonb),
    'lessons', coalesce((
      select jsonb_agg(to_jsonb(l) order by l."order")
      from public.lessons l where l.course_id = p_course_id), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(to_jsonb(b) order by b."order")
      from public.blocks b where b.course_id = p_course_id), '[]'::jsonb),
    'pending_blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'block_id',      p.block_id,
        'change_set_id', p.change_set_id,
        'op',            p.op,
        'node_type',     p.node_type,
        'evidence',      p.evidence))
      from pending p
      where p.node_type = 'block' and p.block_id is not null), '[]'::jsonb),
    'pending_nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'node_id',       p.node_id,
        'node_type',     p.node_type,
        'change_set_id', p.change_set_id,
        'op',            p.op))
      from pending p
      where p.node_type in ('module','lesson','concept_graph') and p.node_id is not null), '[]'::jsonb),
    'open_findings', (
      select count(*)::integer from public.agent_findings f
      where f.course_id = p_course_id and f.status = 'open')
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.studio_course_bundle(uuid) from public, anon;
grant execute on function public.studio_course_bundle(uuid) to authenticated;
