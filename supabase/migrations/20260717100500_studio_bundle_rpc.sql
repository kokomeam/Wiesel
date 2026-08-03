-- PERF-1 C1 — /studio (editor variant) bundle RPC.
--
-- Replaces the page's 7-query, 5-hop load (courses row awaited alone →
-- Promise.all of modules(*) / lessons(*) / blocks(*) + getPendingBlocks
-- [internal 2-hop: change_sets → change_set_items] + getPendingNodes
-- [re-running the identical change_sets query] + an exact findings count)
-- with ONE SECURITY DEFINER round trip (docs/perf/PERF-1_diagnosis.md §A2).
--
-- Contract (validated by lib/editor/studioLoad.ts, zod-first):
--   { course, modules[], lessons[], blocks[],           ← to_jsonb(row) — the
--                                                          exact select("*")
--                                                          shapes courseDocFromRows
--                                                          already consumes
--     pending_blocks[]  {block_id, change_set_id, op, node_type, evidence},
--     pending_nodes[]   {node_id, node_type, change_set_id, op},
--     open_findings     int }
--
-- Authorization lives INSIDE the function: auth.uid() is pinned once and the
-- caller must be the course AUTHOR, else the function returns NULL and the
-- page falls back to the gallery — the same behavior as the current
-- missing/forbidden ?course= path. (The studio is an authoring surface;
-- published+public visibility never opens it — drafts stay visibility
-- 'private' by the M1 rule, so the author gate changes nothing in practice.)
-- Being a single statement, the bundle is also atomic: the partial-read
-- failure mode the page defends against (a lossy tree that autosave would
-- orphan-delete from) cannot occur.
--
-- The pending join runs ONCE (the CTE is referenced twice → materialized) and
-- splits by node_type, replacing the duplicated change_sets query pair.

create function public.studio_course_bundle(p_course_id uuid)
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
      where p.node_type in ('module','lesson') and p.node_id is not null), '[]'::jsonb),
    'open_findings', (
      select count(*)::integer from public.agent_findings f
      where f.course_id = p_course_id and f.status = 'open')
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.studio_course_bundle(uuid) from public, anon;
grant execute on function public.studio_course_bundle(uuid) to authenticated;
