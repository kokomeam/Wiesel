-- WiseSel — TUTOR-1 Wave 2: learner mastery state, the review queue, and the
-- cohort aggregate. These are the mastery-refold OUTPUT tables (the sibling
-- agent computes them; THIS migration authors the DDL verbatim from the frozen
-- Wave-2 contract — one owner for every migration this wave).
--
-- STRICT REGIME throughout: a learner reads their OWN mastery + review queue
-- (definer RPCs / a single own-rows select policy); the creator sees ONLY
-- cohort-floored aggregates via a definer RPC (Amendment D-4: the cohort floor
-- is 5). Service-role is the only writer of all three. No author policy on any
-- of them — a creator never reads a named learner's mastery.

-- ─────────────────────────────── 1. learner_mastery ─────────────────────────
-- Per (learner, course, concept) mastery estimate. p_learned is the raw BKT-ish
-- probability; decayed_p applies time decay. Service-role writes only; the
-- learner reads their OWN rows (a single select policy).
create table public.learner_mastery (
  user_id          uuid not null,
  course_id        uuid not null,
  node_id          uuid not null references public.concept_nodes(id) on delete cascade,
  p_learned        numeric not null check (p_learned >= 0 and p_learned <= 1),
  decayed_p        numeric not null check (decayed_p >= 0 and decayed_p <= 1),
  evidence_count   integer not null default 0,
  last_positive_at timestamptz,
  computed_at      timestamptz not null default now(),
  primary key (user_id, course_id, node_id)
);
create index learner_mastery_course_node_idx on public.learner_mastery(course_id, node_id);

alter table public.learner_mastery enable row level security;
-- EXACTLY ONE policy: the learner reads their own mastery. NO insert/update/
-- delete policy (service-role is the only writer); NO author policy (the strict
-- regime — creators see cohort-floored aggregates only, via
-- concept_mastery_aggregate below).
create policy "learner_mastery_select_own" on public.learner_mastery for select
  using (user_id = (select auth.uid()));

-- ─────────────────────────────── 2. mastery_review_queue ────────────────────
-- The learner's ranked spaced-review queue. Service-role writes only; the
-- learner reads their own rows through the my_review_queue definer RPC (RLS on,
-- ZERO policies — no direct client read at all).
create table public.mastery_review_queue (
  user_id     uuid not null,
  course_id   uuid not null,
  node_id     uuid not null references public.concept_nodes(id) on delete cascade,
  rank        integer not null,
  score       numeric not null,
  reason      jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (user_id, course_id, node_id)
);
create index mastery_review_queue_user_rank_idx
  on public.mastery_review_queue(user_id, course_id, rank);

alter table public.mastery_review_queue enable row level security;
-- ZERO policies — the learner reads own rows only via my_review_queue.

-- The queue rows carry only node_id; concept_nodes is AUTHOR-RLS (a learner
-- cannot read node titles directly). This DEFINER RPC bypasses RLS, so it joins
-- concept_nodes to return the node `title` alongside the learner's OWN queue —
-- the ONLY learner-readable path to a title, disclosing nothing but the learner's
-- own queue's concept names (TUTOR-1 W2.4 studentHome integration).
create function public.my_review_queue(p_course_id uuid)
returns table (
  node_id     uuid,
  title       text,
  rank        integer,
  score       numeric,
  reason      jsonb,
  computed_at timestamptz
)
language sql security definer stable set search_path = public as $$
  select q.node_id, n.title, q.rank, q.score, q.reason, q.computed_at
  from public.mastery_review_queue q
  join public.concept_nodes n on n.id = q.node_id
  where q.course_id = p_course_id
    and q.user_id = (select auth.uid())
  order by q.rank;
$$;
revoke all on function public.my_review_queue(uuid) from public, anon;
grant execute on function public.my_review_queue(uuid) to authenticated;

-- ─────────────────────────────── 3. mastery_course_aggregate ────────────────
-- Per (course, concept) cohort aggregate — the ONLY mastery surface a creator
-- sees. Service-role writes only; RLS on, ZERO policies (the definer RPC below
-- is the sole read path, and it applies the cohort floor).
create table public.mastery_course_aggregate (
  course_id             uuid not null,
  node_id               uuid not null references public.concept_nodes(id) on delete cascade,
  learner_count         integer not null,
  avg_decayed_p         numeric,
  p25                   numeric,
  p50                   numeric,
  p75                   numeric,
  below_threshold_count integer not null default 0,
  computed_at           timestamptz not null default now(),
  primary key (course_id, node_id)
);

alter table public.mastery_course_aggregate enable row level security;
-- ZERO policies — the author reads only through concept_mastery_aggregate (the
-- cohort floor is applied there, so a below-floor node discloses nothing).

-- The AUTHOR-gated cohort aggregate. Amendment D-4: the cohort floor is 5.
--   learner_count >= 5 → the real aggregates.
--   0 < learner_count < 5 → suppressed := true and EVERY aggregate NULL, with
--     learner_count itself NULL (the count is not disclosed below the floor).
--   learner_count = 0 → no row (the node simply has no cohort data).
-- The literal `>= 5` appears here verbatim (the sibling's TS mirror + drift
-- guard pin against it).
create function public.concept_mastery_aggregate(p_course_id uuid)
returns table (
  node_id               uuid,
  suppressed            boolean,
  learner_count         integer,
  avg_decayed_p         numeric,
  p25                   numeric,
  p50                   numeric,
  p75                   numeric,
  below_threshold_count integer
)
language plpgsql security definer stable set search_path = public as $$
begin
  if not exists (
    select 1 from public.courses c
    where c.id = p_course_id and c.author_id = (select auth.uid())
  ) then
    raise exception 'not the course author';
  end if;

  return query
  select
    a.node_id,
    (a.learner_count < 5) as suppressed,
    case when a.learner_count >= 5 then a.learner_count else null end,
    case when a.learner_count >= 5 then a.avg_decayed_p else null end,
    case when a.learner_count >= 5 then a.p25 else null end,
    case when a.learner_count >= 5 then a.p50 else null end,
    case when a.learner_count >= 5 then a.p75 else null end,
    case when a.learner_count >= 5 then a.below_threshold_count else null end
  from public.mastery_course_aggregate a
  where a.course_id = p_course_id
    and a.learner_count > 0;
end;
$$;
revoke all on function public.concept_mastery_aggregate(uuid) from public, anon;
grant execute on function public.concept_mastery_aggregate(uuid) to authenticated;

comment on table public.learner_mastery is
  'Strict-regime per (learner, course, concept) mastery estimate. Service-role writes only; ONE select policy (own rows); NO author policy — creators see cohort-floored aggregates only.';
comment on table public.mastery_review_queue is
  'Strict-regime ranked spaced-review queue. RLS on, ZERO policies — learner reads own rows via my_review_queue.';
comment on table public.mastery_course_aggregate is
  'Per (course, concept) cohort aggregate — the ONLY mastery surface a creator sees, via concept_mastery_aggregate (cohort floor 5). RLS on, ZERO policies.';
