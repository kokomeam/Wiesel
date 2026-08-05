-- WiseSel — TUTOR-1 Wave 5, P5.2: the Concept Graph console backend.
--
-- Two SECURITY DEFINER functions, both author-gated (raise / return null for a
-- non-author), both `revoke all … from public, anon` + `grant execute … to
-- authenticated` (the canonical privacy pattern — mirrors
-- concept_mastery_aggregate). The cohort floor is 5 verbatim (`>= 5`), matching
-- Amendment D-4; below-floor overlays are `suppressed := true` with a NULL value.
--
--   (a) tutor_graph_console(p_course_id)          — the ONE round trip the graph
--       tab makes: nodes + edges + assumed priors (author has full CRUD RLS, so
--       the RPC reads them) PLUS cohort-floored mastery/confusion overlays (from
--       the ZERO-policy learner tables, readable ONLY through a floored definer
--       RPC) + the pending concept_graph change-set id + per-node evidence.
--   (b) tutor_merge_concept_nodes(p_course_id, survivor, absorbed[]) — the ONLY
--       legal path to write the service-role-only learner_mastery: fold absorbed
--       nodes into a survivor (mastery redistribution per Directive §1.4),
--       re-point edges, retire the absorbed nodes.

-- ─────────────────────────── (a) tutor_graph_console ─────────────────────────
create function public.tutor_graph_console(p_course_id uuid)
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_nodes          jsonb;
  v_edges          jsonb;
  v_assumed        jsonb;
  v_mastery        jsonb;
  v_confusion      jsonb;
  v_pending        uuid;
  v_evidence       jsonb;
begin
  -- Author gate FIRST (before any learner-table read): a non-author sees null,
  -- which the loader collapses to a 404 — the course's existence never leaks.
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.author_id = v_uid
  ) then
    return null;
  end if;

  -- nodes / edges / assumed priors — the author-RLS graph tables, verbatim rows.
  select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at), '[]'::jsonb)
    into v_nodes
  from public.concept_nodes n
  where n.course_id = p_course_id;

  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at), '[]'::jsonb)
    into v_edges
  from public.concept_edges e
  where e.course_id = p_course_id;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]'::jsonb)
    into v_assumed
  from public.assumed_prior_nodes a
  where a.course_id = p_course_id;

  -- mastery overlay — the cohort-floored aggregate (>= 5). mastery_course_aggregate
  -- is ZERO-policy; the definer bypasses RLS but emits ONLY floored aggregates.
  -- A below-floor node → suppressed=true, learner_count/avg_decayed_p NULL.
  select coalesce(jsonb_agg(jsonb_build_object(
      'node_id',       agg.node_id,
      'avg_decayed_p', case when agg.learner_count >= 5 then agg.avg_decayed_p else null end,
      'learner_count', case when agg.learner_count >= 5 then agg.learner_count else null end,
      'suppressed',    (agg.learner_count < 5)
    ) order by agg.node_id), '[]'::jsonb)
    into v_mastery
  from public.mastery_course_aggregate agg
  where agg.course_id = p_course_id
    and agg.learner_count > 0;

  -- confusion overlay — rollup_content_feedback per block, floored to >= 5 DISTINCT
  -- learners (distinct-learner count derived from the LATEST-reaction rollup's
  -- helpful+confusing tally, the closest available cohort size). Below floor →
  -- suppressed, no number.
  select coalesce(jsonb_agg(jsonb_build_object(
      'block_id',        f.block_id,
      'confusing_pct',   case when (f.helpful_count + f.confusing_count) >= 5 then f.confusing_pct   else null end,
      'confusing_count', case when (f.helpful_count + f.confusing_count) >= 5 then f.confusing_count else null end,
      'suppressed',      ((f.helpful_count + f.confusing_count) < 5)
    ) order by f.block_id), '[]'::jsonb)
    into v_confusion
  from public.rollup_content_feedback f
  join public.course_publications p on p.id = f.publication_id and p.status = 'live'
  where f.course_id = p_course_id
    and f.block_id is not null
    -- one row per block (the per-slide rows carry slide_id; the per-lesson roll-up
    -- has block_id NULL and is already excluded above).
    and f.slide_id is null;

  -- pending concept_graph change-set id for this course (drives the review rail).
  select cs.id into v_pending
  from public.change_sets cs
  where cs.course_id = p_course_id
    and cs.status = 'pending'
    and exists (
      select 1 from public.change_set_items i
      where i.change_set_id = cs.id and i.node_type = 'concept_graph'
    )
  order by cs.created_at desc
  limit 1;

  -- evidence-by-node: the evidence jsonb stamped on each concept_graph change-set
  -- item, keyed by node_id (the item's node_id IS the concept node id). Latest
  -- non-null evidence per node wins.
  select coalesce(jsonb_object_agg(t.node_id, t.evidence), '{}'::jsonb)
    into v_evidence
  from (
    select distinct on (i.node_id) i.node_id::text as node_id, i.evidence
    from public.change_set_items i
    join public.change_sets cs on cs.id = i.change_set_id and cs.course_id = p_course_id
    where i.node_type = 'concept_graph'
      and i.node_id is not null
      and i.evidence is not null
    order by i.node_id, cs.created_at desc
  ) t;

  return jsonb_build_object(
    'nodes',          v_nodes,
    'edges',          v_edges,
    'mastery',        v_mastery,
    'confusion',      v_confusion,
    'assumedPriors',  v_assumed,
    'pendingChangeSetId', v_pending,
    'evidenceByNode', v_evidence
  );
end;
$$;
revoke all on function public.tutor_graph_console(uuid) from public, anon;
grant execute on function public.tutor_graph_console(uuid) to authenticated;

comment on function public.tutor_graph_console(uuid) is
  'Author-gated console bundle: concept nodes/edges/assumed-priors + cohort-floored (>=5) mastery/confusion overlays + the pending concept_graph change-set id + per-node evidence. Non-author → null.';

-- ─────────────────────── (b) tutor_merge_concept_nodes ───────────────────────
-- The ONLY legal path to write the service-role-only learner_mastery. Folds the
-- absorbed nodes into the survivor (Directive §1.4):
--   • absorbed nodes → status 'merged_into', merged_into_node_id = survivor.
--   • learner_mastery: per learner, fold every absorbed row into the survivor row —
--     evidence_count = sum; decayed_p / p_learned = evidence-weighted mean across
--     the survivor + absorbed rows (weight = evidence_count, min 1 so a zero-
--     evidence row still contributes); then DELETE the absorbed rows.
--   • concept_edges: re-point absorbed endpoints to the survivor, DROPPING any
--     that would self-loop (source=target) or duplicate an existing (source,
--     target, kind) — the unique index would otherwise reject them.
create function public.tutor_merge_concept_nodes(
  p_course_id        uuid,
  p_survivor_node_id uuid,
  p_absorbed_node_ids uuid[]
)
returns jsonb
language plpgsql security definer volatile set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_folded integer := 0;
  v_absorbed_count integer;
begin
  -- Author gate.
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.author_id = v_uid
  ) then
    raise exception 'not the course author';
  end if;

  -- The survivor must be an active node OF THIS COURSE.
  if not exists (
    select 1 from public.concept_nodes n
    where n.id = p_survivor_node_id and n.course_id = p_course_id
  ) then
    raise exception 'survivor node % not in course', p_survivor_node_id;
  end if;

  -- Absorbed set: only nodes of this course, never the survivor itself.
  select array_agg(n.id) into p_absorbed_node_ids
  from public.concept_nodes n
  where n.id = any(p_absorbed_node_ids)
    and n.course_id = p_course_id
    and n.id <> p_survivor_node_id;

  if p_absorbed_node_ids is null or array_length(p_absorbed_node_ids, 1) is null then
    return jsonb_build_object(
      'survivorNodeId', p_survivor_node_id,
      'absorbedCount', 0,
      'masteryRowsFolded', 0
    );
  end if;
  v_absorbed_count := array_length(p_absorbed_node_ids, 1);

  -- 1. Fold learner_mastery. For each learner who has ANY row among survivor ∪
  --    absorbed, compute the folded survivor values (evidence-weighted mean;
  --    weight = greatest(evidence_count, 1)), then upsert the survivor row and
  --    delete the absorbed rows.
  with participating as (
    select m.user_id
    from public.learner_mastery m
    where m.course_id = p_course_id
      and m.node_id in (
        select unnest(array_append(p_absorbed_node_ids, p_survivor_node_id))
      )
    group by m.user_id
  ),
  folded as (
    select
      pp.user_id,
      sum(coalesce(m.evidence_count, 0))                                                    as evidence_count,
      sum(m.p_learned  * greatest(m.evidence_count, 1)) / sum(greatest(m.evidence_count, 1)) as p_learned,
      sum(m.decayed_p  * greatest(m.evidence_count, 1)) / sum(greatest(m.evidence_count, 1)) as decayed_p,
      max(m.last_positive_at)                                                                as last_positive_at
    from participating pp
    join public.learner_mastery m
      on m.user_id = pp.user_id
     and m.course_id = p_course_id
     and m.node_id in (
       select unnest(array_append(p_absorbed_node_ids, p_survivor_node_id))
     )
    group by pp.user_id
  ),
  upserted as (
    insert into public.learner_mastery
      (user_id, course_id, node_id, p_learned, decayed_p, evidence_count, last_positive_at, computed_at)
    select f.user_id, p_course_id, p_survivor_node_id,
           least(greatest(f.p_learned, 0), 1),
           least(greatest(f.decayed_p, 0), 1),
           f.evidence_count, f.last_positive_at, now()
    from folded f
    on conflict (user_id, course_id, node_id) do update
      set p_learned        = excluded.p_learned,
          decayed_p        = excluded.decayed_p,
          evidence_count   = excluded.evidence_count,
          last_positive_at = excluded.last_positive_at,
          computed_at      = excluded.computed_at
    returning 1
  )
  select count(*) into v_folded from upserted;

  -- Delete the absorbed learner_mastery rows (survivor row already upserted).
  delete from public.learner_mastery m
  where m.course_id = p_course_id
    and m.node_id = any(p_absorbed_node_ids);

  -- 2. Re-point edges from absorbed → survivor. Drop any that would self-loop or
  --    collide with an existing (source, target, kind) triple.
  --    First delete the ones that would become duplicates or self-loops…
  delete from public.concept_edges e
  where e.course_id = p_course_id
    and (e.source_node_id = any(p_absorbed_node_ids) or e.target_node_id = any(p_absorbed_node_ids))
    and (
      -- would self-loop after re-point
      (case when e.source_node_id = any(p_absorbed_node_ids) then p_survivor_node_id else e.source_node_id end)
        = (case when e.target_node_id = any(p_absorbed_node_ids) then p_survivor_node_id else e.target_node_id end)
      -- OR would duplicate an existing survivor-anchored edge of the same kind
      or exists (
        select 1 from public.concept_edges e2
        where e2.course_id = p_course_id
          and e2.id <> e.id
          and e2.kind = e.kind
          and e2.source_node_id = (case when e.source_node_id = any(p_absorbed_node_ids) then p_survivor_node_id else e.source_node_id end)
          and e2.target_node_id = (case when e.target_node_id = any(p_absorbed_node_ids) then p_survivor_node_id else e.target_node_id end)
          and not (e2.source_node_id = any(p_absorbed_node_ids) or e2.target_node_id = any(p_absorbed_node_ids))
      )
    );

  --    …then re-point the survivors.
  update public.concept_edges e
    set source_node_id = case when e.source_node_id = any(p_absorbed_node_ids) then p_survivor_node_id else e.source_node_id end,
        target_node_id = case when e.target_node_id = any(p_absorbed_node_ids) then p_survivor_node_id else e.target_node_id end,
        version = e.version + 1
  where e.course_id = p_course_id
    and (e.source_node_id = any(p_absorbed_node_ids) or e.target_node_id = any(p_absorbed_node_ids));

  -- 3. Retire the absorbed nodes (status merged_into, pointer to survivor).
  update public.concept_nodes n
    set status = 'merged_into',
        merged_into_node_id = p_survivor_node_id,
        version = n.version + 1
  where n.course_id = p_course_id
    and n.id = any(p_absorbed_node_ids);

  return jsonb_build_object(
    'survivorNodeId', p_survivor_node_id,
    'absorbedCount', v_absorbed_count,
    'masteryRowsFolded', v_folded
  );
end;
$$;
revoke all on function public.tutor_merge_concept_nodes(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.tutor_merge_concept_nodes(uuid, uuid, uuid[]) to authenticated;

comment on function public.tutor_merge_concept_nodes(uuid, uuid, uuid[]) is
  'Author-gated node merge — the ONLY legal writer of the service-role-only learner_mastery. Folds absorbed nodes into a survivor (evidence-weighted mastery mean, edge re-point dropping self-loops/dupes, absorbed → merged_into). Non-author → raises.';
