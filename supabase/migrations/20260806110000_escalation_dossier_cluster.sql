-- WiseSel — TUTOR-1 Wave 6 (P6.2): escalation DOSSIER + CLUSTER.
--
-- The consent-gated escalation loop's synthesis surface. When a learner consents
-- to hand an escalation to their instructor (the W6.1 consent_pending → consented
-- transition, event tutor/escalation.consented), the on-consent synthesis job
-- writes TWO derived rows:
--
--   1. escalation_dossier — the IDENTITY-BEARING synthesis of ONE consented
--      candidate: the anonymized-at-synthesis question, the tutor's proposed
--      answer, the rung trail, the Terra-written dossier {summary, confidenceNotes},
--      and the question embedding used for clustering. It carries user_id →
--      RLS ENABLED, ZERO POLICIES (service-role / definer ONLY). A creator can
--      NEVER read it — the learner roster stays server-side. This is the roster-
--      privacy guarantee; a verify script asserts the ZERO-policy state.
--
--   2. escalation_cluster — the IDENTITY-FREE creator-visible surface: many
--      near-duplicate learner questions on ONE concept node collapse into one
--      cluster carrying a representative question/answer + a member_count. It has
--      NO user_id, so author full-CRUD RLS is SAFE (the creator sees the count,
--      never who asked). Writes happen service-role/definer in practice, but the
--      author policy is harmless and lets the queue read the surface directly; the
--      author-gated tutor_escalation_queue RPC below is the primary read.
--
-- THE PRIVACY SPINE (binding, this whole wave): identity → dossier (server-only);
-- counts → cluster (author-readable). Terra prompts carry NO learner identity.

create extension if not exists moddatetime schema extensions;

/* ─────────────────────────── escalation_cluster ─────────────────────────────
 * The identity-FREE creator-visible surface. One row per (node_id, semantic
 * question group). member_count is recomputed from the dossiers pointing at the
 * cluster; representative_question / representative_answer are copied from the
 * cluster's most-central (earliest) member so the creator sees a concrete example
 * without ever touching a learner row. `change_set_id` links a promotion (P6.4)
 * that clarifies the concept in content; `status` walks open → replied |
 * dismissed | resolved_in_content. NO user_id anywhere — author RLS is safe. */
create table public.escalation_cluster (
  id                     uuid primary key default gen_random_uuid(),
  course_id              uuid not null references public.courses(id) on delete cascade,
  node_id                uuid not null,
  representative_question text,
  representative_answer   text,
  member_count           integer not null default 0,
  status                 text not null default 'open'
    check (status in ('open','replied','dismissed','resolved_in_content')),
  change_set_id          uuid,
  dismiss_reason         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index escalation_cluster_course_status_idx
  on public.escalation_cluster(course_id, status);
create index escalation_cluster_course_node_idx
  on public.escalation_cluster(course_id, node_id);
create trigger escalation_cluster_set_updated_at before update on public.escalation_cluster
  for each row execute procedure extensions.moddatetime(updated_at);

/* ─────────────────────────── escalation_dossier ─────────────────────────────
 * The IDENTITY-BEARING synthesis of one consented candidate. candidate_id IS the
 * primary key → the synthesis job UPSERTS by candidate, so a re-run (event replay
 * OR the nightly reconcile) is idempotent (one dossier per candidate). It carries
 * user_id, so RLS is ENABLED with ZERO POLICIES: no client role — not the author,
 * not the learner — can read it. Only the service role / a definer function does.
 * The question_embedding pins the row to its cluster; cluster_id may be null
 * transiently (before assignment) but is filled by the synthesis job.
 *
 * ⚠ DRIFT GUARD: escalation_dossier having ZERO policies is the roster-privacy
 * guarantee of the whole escalation loop. A verify script asserts a creator/author
 * principal reads ZERO dossier rows. Do NOT add any policy here — ever. */
create table public.escalation_dossier (
  candidate_id         uuid primary key
    references public.tutor_escalation_candidates(id) on delete cascade,
  course_id            uuid not null,
  user_id              uuid not null,
  node_ids             jsonb not null default '[]'::jsonb,
  learner_question     text,
  rung_trail           jsonb not null default '[]'::jsonb,
  tutor_proposed_answer text,
  dossier              jsonb,          -- {summary, confidenceNotes} — the Terra synthesis
  question_embedding   jsonb,          -- float array (identity-free vector), pins the cluster
  cluster_id           uuid references public.escalation_cluster(id),
  created_at           timestamptz not null default now()
);
create index escalation_dossier_course_idx on public.escalation_dossier(course_id);
create index escalation_dossier_cluster_idx on public.escalation_dossier(cluster_id);

/* ──────────────────────────────── RLS ───────────────────────────────────────
 * escalation_cluster: author full CRUD via the per-statement semi-join idiom
 *   (the current house style — 20260803100100). SAFE: the table is identity-free.
 * escalation_dossier: RLS ENABLED, ZERO POLICIES — service-role / definer ONLY.
 *   The privacy spine. Do NOT add a policy. */
alter table public.escalation_cluster  enable row level security;
alter table public.escalation_dossier  enable row level security;

-- escalation_cluster — author full CRUD (identity-free; the creator sees counts).
create policy "escalation_cluster_select" on public.escalation_cluster for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "escalation_cluster_insert" on public.escalation_cluster for insert
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "escalation_cluster_update" on public.escalation_cluster for update
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())))
  with check (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));
create policy "escalation_cluster_delete" on public.escalation_cluster for delete
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

-- escalation_dossier — NO POLICIES. RLS is enabled and every client role is denied
-- by default (service-role / definer bypass RLS). This ZERO-policy state IS the
-- roster-privacy guarantee (drift-guarded by scripts/verify-tutor-escalation-cluster-int.ts).

/* ─────────────────────────── tutor_escalation_queue ─────────────────────────
 * The author-gated creator read of the escalation queue. Returns the open /
 * replied clusters for a course as a jsonb array — COUNT ONLY, NEVER a user_id or
 * any roster. A non-author (or a missing course) gets NULL, never an exception
 * (the page 404s), mirroring tutor_console_bundle.
 *
 * Each cluster row carries: id, node_id, node_title (joined from concept_nodes),
 * anchors (the node's teaching anchors — [{lessonId,blockId,slideId?}] — so the
 * queue can deep-link into the lesson), representative_question / _answer,
 * member_count, status, change_set_id. There is NO cohort floor: a member_count is
 * an aggregate over a cluster, not a per-learner statistic, and identity is never
 * exposed (the dossier table it derives from is unreadable to every client role).
 *
 * Ordered by member_count desc, then updated_at desc (the biggest, freshest
 * clusters first). SECURITY DEFINER so it can read concept_nodes for the title +
 * anchors without granting the author direct access. */
create function public.tutor_escalation_queue(p_course_id uuid)
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
        'changeSetId',            cl.change_set_id
      )
      order by cl.member_count desc, cl.updated_at desc
    ),
    '[]'::jsonb
  )
  into v_out
  from public.escalation_cluster cl
  left join public.concept_nodes n on n.id = cl.node_id
  where cl.course_id = p_course_id
    and cl.status in ('open','replied');

  return v_out;
end;
$$;
revoke all on function public.tutor_escalation_queue(uuid) from public, anon;
grant execute on function public.tutor_escalation_queue(uuid) to authenticated;

comment on function public.tutor_escalation_queue(uuid) is
  'Author-gated creator escalation-queue read (Wave 6 P6.2). NULL for non-authors (page 404s). Returns open/replied escalation_cluster rows as jsonb with node title + anchors joined from concept_nodes — COUNT ONLY, never a user_id/roster. escalation_dossier (identity-bearing) is unreadable to every client role; this RPC + the identity-free escalation_cluster table are the only creator surfaces.';

comment on table public.escalation_dossier is
  'IDENTITY-BEARING escalation synthesis (Wave 6 P6.2). RLS enabled, ZERO policies — service-role/definer ONLY. A creator can NEVER read it; this ZERO-policy state is the roster-privacy guarantee (drift-guarded).';
comment on table public.escalation_cluster is
  'IDENTITY-FREE creator-visible escalation cluster surface (Wave 6 P6.2). No user_id — author full-CRUD RLS is safe. member_count is an aggregate, never a per-learner stat.';
