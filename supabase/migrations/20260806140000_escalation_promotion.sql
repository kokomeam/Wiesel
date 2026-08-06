-- WiseSel — TUTOR-1 Wave 6 (P6.4): escalation CONTENT-PATCH PROMOTION.
--
-- The loop closes here. A promoted cluster files a CLARIFICATION (a FAQ lecture block)
-- through the standard change-set rail; when the creator ACCEPTS that change-set, the
-- cluster is "resolved_in_content". Resolution is DERIVED from change_sets.status —
-- there is NO trigger and NO hook into acceptChangeSet; the two author-gated read RPCs
-- compute it at read time.
--
-- This migration `create or replace`s the two RPCs (additive columns only — every
-- existing caller keeps working, the pure/int suites for the graph console stay green):
--
--   (a) tutor_escalation_queue  — each cluster row gains a `resolved` boolean
--       (change_set_id present AND its change_set is 'accepted') alongside the
--       already-emitted changeSetId. Ordering + author gate + count-only privacy are
--       unchanged. The queue still returns open/replied clusters (a resolved_in_content
--       cluster leaves the queue — it's surfaced on the node drawer instead).
--
--   (b) tutor_graph_console     — the node bundle gains, per node, a `clarifications`
--       array [{clusterId, memberCount}] for clusters ON THAT NODE whose change_set is
--       ACCEPTED — the node drawer surfaces "clarified after N learners asked". A
--       cluster whose change-set is still pending / rejected does NOT appear (only an
--       accepted clarification counts as landed content). Identity-free throughout.

-- ─────────────────────── (a) tutor_escalation_queue (v2) ─────────────────────
-- Adds `resolved` to each row. `changeSetId` was already emitted; we join
-- change_sets to compute whether the linked change-set is accepted.
create or replace function public.tutor_escalation_queue(p_course_id uuid)
returns jsonb language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid  uuid := (select auth.uid());
  v_out  jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  -- Author gate: a non-author (or a missing course) returns NULL → the page 404s.
  perform 1 from public.courses c
  where c.id = p_course_id and c.author_id = v_uid;
  if not found then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',                     cl.id,
        'nodeId',                 cl.node_id,
        'nodeTitle',              n.title,
        'anchors',                coalesce(n.anchors, '[]'::jsonb),
        'representativeQuestion', cl.representative_question,
        'representativeAnswer',   cl.representative_answer,
        'memberCount',            cl.member_count,
        'status',                 cl.status,
        'changeSetId',            cl.change_set_id,
        -- DERIVED resolution: a promotion whose change-set is accepted. NO trigger,
        -- NO acceptChangeSet hook — the change_sets.status IS the source of truth.
        'resolved',               (cs.id is not null and cs.status = 'accepted')
      )
      order by cl.member_count desc, cl.updated_at desc
    ),
    '[]'::jsonb
  )
  into v_out
  from public.escalation_cluster cl
  left join public.concept_nodes n on n.id = cl.node_id
  left join public.change_sets  cs on cs.id = cl.change_set_id
  where cl.course_id = p_course_id
    and cl.status in ('open','replied');

  return v_out;
end;
$$;
revoke all on function public.tutor_escalation_queue(uuid) from public, anon;
grant execute on function public.tutor_escalation_queue(uuid) to authenticated;

comment on function public.tutor_escalation_queue(uuid) is
  'Author-gated creator escalation-queue read (Wave 6 P6.2/P6.4). NULL for non-authors (page 404s). Returns open/replied escalation_cluster rows as jsonb with node title + anchors joined from concept_nodes — COUNT ONLY, never a user_id/roster. Each row carries changeSetId + a DERIVED `resolved` (change_set_id present AND its change_set accepted; no trigger, no acceptChangeSet hook).';

-- ─────────────────────── (b) tutor_graph_console (v2) ────────────────────────
-- Adds `clarifications` (a node_id → [{clusterId, memberCount}] map) for clusters
-- whose promotion change-set is ACCEPTED — the node drawer's "clarified after N asks".
-- Everything else (nodes/edges/priors/overlays/pending/evidence) is byte-identical to
-- 20260805110000 so the graph-console suites stay green.
create or replace function public.tutor_graph_console(p_course_id uuid)
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
  v_clarifications jsonb;
begin
  -- Author gate FIRST (before any learner-table read): a non-author sees null.
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.author_id = v_uid
  ) then
    return null;
  end if;

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
    and f.slide_id is null;

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

  -- clarifications: node_id → [{clusterId, memberCount}] for clusters ON THAT NODE
  -- whose promotion change-set is ACCEPTED (a landed content clarification). Identity-
  -- free (member_count is an aggregate). Pending/rejected change-sets are excluded —
  -- only an accepted clarification is "landed". This drives the drawer's
  -- "clarified after N learners asked".
  select coalesce(jsonb_object_agg(g.node_id, g.rows), '{}'::jsonb)
    into v_clarifications
  from (
    select cl.node_id::text as node_id,
           jsonb_agg(
             jsonb_build_object('clusterId', cl.id, 'memberCount', cl.member_count)
             order by cl.member_count desc, cl.updated_at desc
           ) as rows
    from public.escalation_cluster cl
    join public.change_sets cs on cs.id = cl.change_set_id
    where cl.course_id = p_course_id
      and cl.change_set_id is not null
      and cs.status = 'accepted'
    group by cl.node_id
  ) g;

  return jsonb_build_object(
    'nodes',          v_nodes,
    'edges',          v_edges,
    'mastery',        v_mastery,
    'confusion',      v_confusion,
    'assumedPriors',  v_assumed,
    'pendingChangeSetId', v_pending,
    'evidenceByNode', v_evidence,
    'clarifications', v_clarifications
  );
end;
$$;
revoke all on function public.tutor_graph_console(uuid) from public, anon;
grant execute on function public.tutor_graph_console(uuid) to authenticated;

comment on function public.tutor_graph_console(uuid) is
  'Author-gated console bundle (Wave 5 + P6.4): concept nodes/edges/assumed-priors + cohort-floored (>=5) mastery/confusion overlays + the pending concept_graph change-set id + per-node evidence + per-node `clarifications` [{clusterId,memberCount}] for clusters whose promotion change-set is ACCEPTED (the "clarified after N asks" surface). Non-author → null.';
