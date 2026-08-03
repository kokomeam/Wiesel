-- TUTOR-1 Wave 1.2 (A) — concept graph: the course's knowledge model.
--
-- The concept graph is a CREATOR-OWNED course artifact — a DAG of concepts
-- (nodes) linked by typed edges (prerequisite / part_of / related), plus the
-- assumed-prior nodes the extraction pipeline surfaces and the per-course tutor
-- settings + reversibility ledger. It rides the SAME legacy author-RLS regime as
-- courses/modules/lessons: the author has full CRUD; LEARNERS GET NO DIRECT
-- ACCESS — their runtime reads arrive later through snapshot-scoped definer
-- functions over `snapshot_concept_map` (deliberately not wired here).
--
-- THE DAG INVARIANT IS ENFORCED AT THE WRITE PATH, NOT THE SCHEMA: edge writes
-- go EXCLUSIVELY through the `tutor_upsert_concept_edge` definer RPC, which runs
-- a per-kind WITH RECURSIVE cycle check before it commits. Renderers stay
-- cycle-TOLERANT (defensive) — a bad row that somehow lands must never crash a
-- traversal — but the write path is the gate that keeps such rows from ever
-- being created. concept_edges therefore has NO client insert/update policy.
--
-- Every child carries a denormalized `course_id` so RLS authorizes in one hop
-- via the per-statement semi-join idiom (20260717100100), the CURRENT house
-- style for author-scoped SELECT policies.

create extension if not exists moddatetime schema extensions;

/* ────────────────────────────── concept_nodes ──────────────────────────────
 * One concept. `status` retires or merges a node (a merge points at its
 * survivor via merged_into_node_id — the CHECK ties the two together).
 * `created_by` records provenance (the extraction pass, the reconciliation
 * pass, or a hand-authoring creator); `creator_edited` protects human edits
 * from being clobbered by a later automated pass. `anchors` is the R-13 anchor
 * shape [{lessonId,blockId,slideId?}] tying the concept to where it's taught. */
create table public.concept_nodes (
  id                   uuid primary key default gen_random_uuid(),
  course_id            uuid not null references public.courses(id) on delete cascade,
  title                text not null check (char_length(title) between 1 and 200),
  description          text not null default '' check (char_length(description) <= 2000),
  status               text not null default 'active'
    check (status in ('active','retired','merged_into')),
  merged_into_node_id  uuid references public.concept_nodes(id),
  created_by           text not null default 'extraction'
    check (created_by in ('extraction','reconciliation','creator')),
  creator_edited       boolean not null default false,
  aliases              jsonb not null default '[]'::jsonb,
  anchors              jsonb not null default '[]'::jsonb,  -- [{lessonId,blockId,slideId?}] — R-13 anchor shape
  embedding            jsonb,                               -- float array, pgvector-shaped for a future extension
  external_taxonomy_ref jsonb,                              -- [FWD]
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- a node is 'merged_into' iff it names its survivor (and vice-versa).
  check ((status = 'merged_into') = (merged_into_node_id is not null))
);
create index concept_nodes_course_status_idx on public.concept_nodes(course_id, status);
create trigger concept_nodes_set_updated_at before update on public.concept_nodes
  for each row execute procedure extensions.moddatetime(updated_at);

/* ────────────────────────────── concept_edges ──────────────────────────────
 * A typed directed edge between two concepts. The (source,target,kind) triple
 * is unique — one edge of a given kind per ordered pair. `creator_locked` marks
 * a human-confirmed edge an automated pass must not touch.
 *
 * ⚠ WRITE PATH IS THE CYCLE GATE ⚠ — this table has author SELECT + DELETE
 * policies ONLY. There is deliberately NO client insert/update policy: every
 * edge write MUST go through public.tutor_upsert_concept_edge (below), whose
 * WITH RECURSIVE cycle check is the ONLY thing keeping the DAG acyclic. A direct
 * client INSERT/UPDATE is refused by default-deny — the gate cannot be bypassed. */
create table public.concept_edges (
  id             uuid primary key default gen_random_uuid(),
  course_id      uuid not null references public.courses(id) on delete cascade,
  source_node_id uuid not null references public.concept_nodes(id) on delete cascade,
  target_node_id uuid not null references public.concept_nodes(id) on delete cascade,
  kind           text not null default 'prerequisite'
    check (kind in ('prerequisite','part_of','related')),
  evidence_refs  jsonb not null default '[]'::jsonb,
  creator_locked boolean not null default false,
  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (source_node_id, target_node_id, kind),
  check (source_node_id <> target_node_id)
);
create index concept_edges_course_id_idx on public.concept_edges(course_id);
create trigger concept_edges_set_updated_at before update on public.concept_edges
  for each row execute procedure extensions.moddatetime(updated_at);

/* ─────────────────────────── snapshot_concept_map ───────────────────────────
 * The published projection of the graph, keyed like the analytics rollups: the
 * (course_id, publication_id, version) triple pins a snapshot so a republish
 * never mixes maps. `anchors` are snapshot-RESOLVED; `anchor_downgraded` records
 * the R-13 case where a slide-level anchor could not be re-resolved against the
 * snapshot and was downgraded to block level. Author-only for now; the learner
 * runtime reads it later via definer functions. */
create table public.snapshot_concept_map (
  publication_id    uuid not null references public.course_publications(id) on delete cascade,
  node_id           uuid not null references public.concept_nodes(id) on delete cascade,
  course_id         uuid not null,
  version           integer not null,  -- (course_id, publication_id, version) keys rollups like the analytics tables
  anchors           jsonb not null default '[]'::jsonb,  -- snapshot-resolved
  anchor_downgraded boolean not null default false,      -- R-13: slide anchor could not be re-resolved → block level
  created_at        timestamptz not null default now(),
  primary key (publication_id, node_id)
);
create index snapshot_concept_map_course_pub_version_idx
  on public.snapshot_concept_map(course_id, publication_id, version);

/* ─────────────────────────── assumed_prior_nodes ────────────────────────────
 * Concepts the course leans on but never teaches — surfaced by extraction so the
 * creator can add coverage or acknowledge the assumption. `status` dismisses one.
 * unique (course_id, title) makes re-extraction idempotent per title. */
create table public.assumed_prior_nodes (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  evidence    jsonb not null default '[]'::jsonb,
  status      text not null default 'active' check (status in ('active','dismissed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (course_id, title)
);
create index assumed_prior_nodes_course_id_idx on public.assumed_prior_nodes(course_id);
create trigger assumed_prior_nodes_set_updated_at before update on public.assumed_prior_nodes
  for each row execute procedure extensions.moddatetime(updated_at);

/* ─────────────────────────── tutor_course_settings ──────────────────────────
 * Per-course tutor configuration (course_id IS the primary key — one row per
 * course). `budget_limit_usd` is [FWD] — enforced by later waves' spend gate. */
create table public.tutor_course_settings (
  course_id        uuid primary key references public.courses(id) on delete cascade,
  enabled          boolean not null default false,
  budget_limit_usd numeric check (budget_limit_usd is null or budget_limit_usd > 0),  -- [FWD] enforced by later waves
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger tutor_course_settings_set_updated_at before update on public.tutor_course_settings
  for each row execute procedure extensions.moddatetime(updated_at);

/* ────────────────────────────── tutor_action ────────────────────────────────
 * The tutor-scoped reversibility ledger — marketing_action's shape, one row per
 * mutating tool call. reversible actions store a before_snapshot and stay
 * revertable until revert_expires_at; the revert restores the snapshot through
 * the entity registry and flips status executed→reverted (fail-closed past the
 * window). */
create table public.tutor_action (
  id                uuid primary key default gen_random_uuid(),
  course_id         uuid not null references public.courses(id) on delete cascade,
  tool_name         text not null,
  action_kind       text not null,
  reversibility     text not null default 'reversible'
    check (reversibility in ('reversible','irreversible')),
  status            text not null default 'executed'
    check (status in ('executed','reverted')),
  params            jsonb not null default '{}'::jsonb,
  before_snapshot   jsonb,
  target_ref        jsonb,
  summary           text,
  requested_by      text not null default 'user' check (requested_by in ('agent','user')),
  revert_expires_at timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index tutor_action_course_created_idx on public.tutor_action(course_id, created_at desc);
create trigger tutor_action_set_updated_at before update on public.tutor_action
  for each row execute procedure extensions.moddatetime(updated_at);

/* ──────────────────────────────── RLS ───────────────────────────────────────
 * Author-only via the per-statement semi-join idiom (20260717100100):
 *   course_id in (select c.id from public.courses c where c.author_id = (select auth.uid()))
 *
 * ⚠ concept_edges is the EXCEPTION: author SELECT + DELETE ONLY. It has NO
 * insert/update policy — the definer RPC is the sole write path, because the
 * cycle gate lives there. Do NOT add an insert/update policy to concept_edges;
 * doing so would let a client create a cycle the RPC exists to prevent. */
alter table public.concept_nodes         enable row level security;
alter table public.concept_edges         enable row level security;
alter table public.snapshot_concept_map  enable row level security;
alter table public.assumed_prior_nodes   enable row level security;
alter table public.tutor_course_settings enable row level security;
alter table public.tutor_action          enable row level security;

-- concept_nodes — author full CRUD
create policy "concept_nodes_select" on public.concept_nodes for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "concept_nodes_insert" on public.concept_nodes for insert
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "concept_nodes_update" on public.concept_nodes for update
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())))
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "concept_nodes_delete" on public.concept_nodes for delete
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

-- concept_edges — author SELECT + DELETE ONLY (writes ride the definer RPC).
create policy "concept_edges_select" on public.concept_edges for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "concept_edges_delete" on public.concept_edges for delete
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
-- NO concept_edges insert/update policy — default-deny forces edge writes
-- through public.tutor_upsert_concept_edge (the cycle gate). Intentional.

-- snapshot_concept_map — author full CRUD
create policy "snapshot_concept_map_select" on public.snapshot_concept_map for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "snapshot_concept_map_insert" on public.snapshot_concept_map for insert
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "snapshot_concept_map_update" on public.snapshot_concept_map for update
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())))
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "snapshot_concept_map_delete" on public.snapshot_concept_map for delete
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

-- assumed_prior_nodes — author full CRUD
create policy "assumed_prior_nodes_select" on public.assumed_prior_nodes for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "assumed_prior_nodes_insert" on public.assumed_prior_nodes for insert
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "assumed_prior_nodes_update" on public.assumed_prior_nodes for update
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())))
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "assumed_prior_nodes_delete" on public.assumed_prior_nodes for delete
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

-- tutor_course_settings — author full CRUD
create policy "tutor_course_settings_select" on public.tutor_course_settings for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "tutor_course_settings_insert" on public.tutor_course_settings for insert
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "tutor_course_settings_update" on public.tutor_course_settings for update
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())))
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "tutor_course_settings_delete" on public.tutor_course_settings for delete
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

-- tutor_action — author full CRUD (the ledger; reverts run under the author client)
create policy "tutor_action_select" on public.tutor_action for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "tutor_action_insert" on public.tutor_action for insert
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "tutor_action_update" on public.tutor_action for update
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())))
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "tutor_action_delete" on public.tutor_action for delete
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

/* ─────────────────────── tutor_upsert_concept_edge ──────────────────────────
 * THE edge write path (the cycle gate). SECURITY DEFINER so it can run the
 * WITH RECURSIVE reachability check across the course's edges and enforce the
 * DAG invariant no client policy can. Returns the upserted row as jsonb.
 *
 * Author gate: the caller must be the course author OR the call is service-role
 * (auth.uid() is null under service_role → the extraction pipeline rides that).
 * Cycle check: same-kind reachability only — a 'related' edge can close a loop
 * the 'prerequisite' DAG forbids; each kind is its own DAG. Version discipline
 * mirrors the social versioned-update rule: a non-null p_expected_version that
 * differs from the live version raises a typed conflict. */
create or replace function public.tutor_upsert_concept_edge(
  p_id               uuid,
  p_course_id        uuid,
  p_source_node_id   uuid,
  p_target_node_id   uuid,
  p_kind             text,
  p_evidence_refs    jsonb   default '[]'::jsonb,
  p_creator_locked   boolean default false,
  p_expected_version integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_is_author  boolean;
  v_reaches    boolean;
  v_existing   public.concept_edges%rowtype;
  v_result     public.concept_edges%rowtype;
begin
  -- (a) author gate — the course author, or a service-role caller (null uid).
  if v_uid is not null then
    select exists(select 1 from public.courses c where c.id = p_course_id and c.author_id = v_uid)
      into v_is_author;
    if not v_is_author then
      raise exception 'concept_edge_forbidden' using errcode = 'P0001';
    end if;
  end if;
  -- (else: service-role — the extraction pipeline; allowed.)

  if p_kind is null or p_kind not in ('prerequisite','part_of','related') then
    raise exception 'concept_edge_invalid_kind' using errcode = 'P0001';
  end if;
  if p_source_node_id = p_target_node_id then
    raise exception 'concept_edge_self_loop' using errcode = 'P0001';
  end if;

  -- (b) both nodes exist, belong to the course, and are not retired.
  if not exists (
    select 1 from public.concept_nodes n
    where n.id = p_source_node_id and n.course_id = p_course_id and n.status <> 'retired'
  ) then
    raise exception 'concept_edge_bad_source' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.concept_nodes n
    where n.id = p_target_node_id and n.course_id = p_course_id and n.status <> 'retired'
  ) then
    raise exception 'concept_edge_bad_target' using errcode = 'P0001';
  end if;

  -- Serialize edge writes per (course, kind): the reachability check below is
  -- read-then-write — without this xact-scoped advisory lock two CONCURRENT
  -- writers could each pass the check and jointly commit a cycle (TOCTOU).
  perform pg_advisory_xact_lock(hashtext(p_course_id::text || ':' || p_kind));

  -- (c) cycle check: can p_target reach p_source via SAME-kind edges of this
  --     course, EXCLUDING the edge being replaced (by id and by the unique
  --     triple)? If so, adding source→target closes a cycle — refuse. The
  --     depth<500 guard bounds the recursion on a pathological graph.
  with recursive reachable(node_id, depth) as (
    select p_target_node_id, 0
    union all
    select e.target_node_id, r.depth + 1
    from public.concept_edges e
    join reachable r on e.source_node_id = r.node_id
    where e.course_id = p_course_id
      and e.kind = p_kind
      and e.id is distinct from p_id
      and not (e.source_node_id = p_source_node_id and e.target_node_id = p_target_node_id)
      and r.depth < 500
  )
  select exists(select 1 from reachable where node_id = p_source_node_id) into v_reaches;
  if v_reaches then
    raise exception 'concept_edge_cycle' using errcode = 'P0001';
  end if;

  -- (d) upsert with version discipline.
  --   Prefer the row named by p_id; fall back to the (source,target,kind)
  --   unique triple so a re-author of "the same edge" updates in place.
  select * into v_existing from public.concept_edges where id = p_id;
  if not found then
    select * into v_existing from public.concept_edges
    where source_node_id = p_source_node_id and target_node_id = p_target_node_id and kind = p_kind;
  end if;

  if found then
    if p_expected_version is not null and p_expected_version <> v_existing.version then
      raise exception 'concept_edge_version_conflict' using errcode = 'P0001';
    end if;
    update public.concept_edges
       set source_node_id = p_source_node_id,
           target_node_id = p_target_node_id,
           kind           = p_kind,
           evidence_refs  = coalesce(p_evidence_refs, '[]'::jsonb),
           creator_locked = p_creator_locked,
           version        = v_existing.version + 1
     where id = v_existing.id
     returning * into v_result;
  else
    insert into public.concept_edges
      (id, course_id, source_node_id, target_node_id, kind, evidence_refs, creator_locked, version)
    values
      (p_id, p_course_id, p_source_node_id, p_target_node_id, p_kind,
       coalesce(p_evidence_refs, '[]'::jsonb), p_creator_locked, 1)
    returning * into v_result;
  end if;

  return to_jsonb(v_result);
end;
$$;

revoke all on function public.tutor_upsert_concept_edge(
  uuid, uuid, uuid, uuid, text, jsonb, boolean, integer
) from public, anon;
grant execute on function public.tutor_upsert_concept_edge(
  uuid, uuid, uuid, uuid, text, jsonb, boolean, integer
) to authenticated, service_role;

/* ─────────────────────────────── comments ───────────────────────────────── */
comment on table public.concept_nodes is
  'Creator-owned concept in a course''s knowledge graph. Legacy author-RLS; learners read only the snapshot projection later via definer functions.';
comment on table public.concept_edges is
  'Typed directed edge between concepts. Author SELECT+DELETE only — writes go through tutor_upsert_concept_edge (the cycle gate); NO insert/update policy by design.';
comment on table public.snapshot_concept_map is
  'Published projection of the graph, keyed by (course_id, publication_id, version) like the analytics rollups. Snapshot-resolved anchors; anchor_downgraded records the R-13 slide→block fallback.';
comment on table public.assumed_prior_nodes is
  'Concepts the course assumes but never teaches, surfaced by extraction. unique (course_id, title) keeps re-extraction idempotent.';
comment on table public.tutor_course_settings is
  'Per-course tutor config (course_id is the PK). budget_limit_usd is [FWD] — enforced by later waves.';
comment on table public.tutor_action is
  'Tutor-scoped reversibility ledger (marketing_action''s shape). Reversible rows carry a before_snapshot and revert until revert_expires_at (fail-closed past the window).';
comment on function public.tutor_upsert_concept_edge(
  uuid, uuid, uuid, uuid, text, jsonb, boolean, integer
) is
  'The concept_edges write path + DAG cycle gate. SECURITY DEFINER; author-or-service-role; per-kind WITH RECURSIVE cycle check (depth<500); version discipline mirrors the social versioned-update rule. Typed errors: concept_edge_cycle / concept_edge_version_conflict / concept_edge_forbidden.';
