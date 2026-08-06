-- WiseSel — TUTOR-1 Wave 6 (P6.3): escalation REPLY DELIVERY.
--
-- The creator side of the escalation loop: an author approves a cluster with a
-- final answer, and that answer must reach EVERY learner who asked — landing as an
-- instructor-role tutor_turn in each learner's own thread, EXACTLY ONCE per member.
--
-- The exactly-once discipline is the svix-dedup pattern (apply_comms_delivery /
-- ingest_learning_events): a delivery LEDGER table (escalation_reply_delivery)
-- keyed by (cluster_id, user_id) is the idempotency store, and the delivery insert
-- is `on conflict do nothing`. A retry, a partial-failure re-run, or a second
-- Approve press delivers ZERO additional turns to a member already delivered.
--
-- THE PRIVACY SPINE (binding): escalation_reply_delivery carries user_id, so it is
-- RLS-ENABLED with ZERO POLICIES — no client role (author or learner) can read it;
-- only the service role / this definer function touches it. The creator approves a
-- COUNT (the cluster's member_count) and never sees who the members are. The
-- instructor turn is written into the LEARNER's thread (visible to the learner via
-- the existing tutor_turns RLS), never surfaced to the creator.

/* ─────────────────────── escalation_reply_delivery ──────────────────────────
 * The per-member delivery ledger — the exactly-once store. One row per delivered
 * (cluster, learner). PK (cluster_id, user_id) IS the idempotency key: the
 * delivery insert `on conflict (cluster_id, user_id) do nothing` makes re-runs /
 * retries / a double Approve a no-op. turn_id back-links the instructor turn that
 * was written. Identity-bearing (user_id) → RLS enabled, ZERO POLICIES: the
 * service role / this definer function is the ONLY reader/writer. Do NOT add a
 * policy — the creator must never learn the roster. */
create table public.escalation_reply_delivery (
  cluster_id   uuid not null references public.escalation_cluster(id) on delete cascade,
  user_id      uuid not null,
  turn_id      uuid,
  delivered_at timestamptz not null default now(),
  primary key (cluster_id, user_id)
);
create index escalation_reply_delivery_cluster_idx
  on public.escalation_reply_delivery(cluster_id);

alter table public.escalation_reply_delivery enable row level security;
-- NO POLICIES. RLS enabled + zero policies = every client role denied; only the
-- service role / a definer function (which bypass RLS) may read/write. This is the
-- roster-privacy guarantee for the delivery ledger (drift-guarded by the int suite).

comment on table public.escalation_reply_delivery is
  'Per-(cluster,learner) escalation-reply delivery ledger (Wave 6 P6.3). The exactly-once store: the delivery insert is on-conflict-do-nothing keyed by (cluster_id,user_id). Identity-bearing (user_id) → RLS enabled, ZERO policies (service-role/definer only). The creator never reads it — roster privacy.';

/* ─────────────────────────── apply_escalation_reply ─────────────────────────
 * The SERVICE-ROLE reply-delivery transaction. Given a cluster + the author's
 * final answer, it writes ONE instructor tutor_turn per dossier member of the
 * cluster that has not already been delivered (the ledger dedups), records each
 * delivery, and flips the cluster to `replied` with the final answer as the new
 * representative_answer.
 *
 * EXACTLY-ONCE: the ledger PK (cluster_id, user_id) + `on conflict do nothing`
 * guarantee a member is delivered at most once, so a retry / partial-failure
 * re-run / double Approve adds no turns for an already-delivered member. A member
 * NEWLY consenting after a first reply IS delivered on a later call (open→replied
 * clusters both accept new deliveries) — hence the guard allows status in
 * ('open','replied').
 *
 * The instructor turn lands in the LEARNER's own thread (user_id, course_id) — the
 * per-learner thread the escalation came from (one thread per learner per course).
 * tutor_turns is NOT-NULL on publication_id + version; those are inherited from the
 * learner's most-recent turn in the thread (the escalation came from a real
 * conversation, so a prior turn exists), falling back to the course's live
 * publication when no prior turn resolves. A member with neither is SKIPPED (a
 * degenerate seed) and counted as skipped, never a throw.
 *
 * SECURITY DEFINER, but it reads/writes only escalation_dossier (service-role-only)
 * + tutor_turns + tutor_threads + escalation_cluster + escalation_reply_delivery;
 * execute is granted to service_role ONLY (no author/learner can call it — the
 * author reaches it through the author-gated server action's admin client).
 *
 * Returns {delivered:int, alreadyDelivered:int, skipped:int}. */
create function public.apply_escalation_reply(p_cluster_id uuid, p_final_answer text)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_course_id         uuid;
  v_status            text;
  v_delivered         int := 0;
  v_already           int := 0;
  v_skipped           int := 0;
  v_thread_id         uuid;
  v_pub_id            uuid;
  v_version           int;
  v_turn_id           uuid;
  v_live_pub_id       uuid;
  v_live_version      int;
  v_answer            text := coalesce(nullif(btrim(p_final_answer), ''), '');
  r                   record;
begin
  if v_answer = '' then
    raise exception 'apply_escalation_reply: a final answer is required';
  end if;

  -- Verify the cluster exists and is in a repliable state (open or already replied
  -- — a replied cluster can still deliver to a member who consented afterward).
  select course_id, status into v_course_id, v_status
  from public.escalation_cluster
  where id = p_cluster_id;
  if not found then
    raise exception 'apply_escalation_reply: cluster % not found', p_cluster_id;
  end if;
  if v_status not in ('open', 'replied') then
    raise exception 'apply_escalation_reply: cluster % is % (must be open or replied)', p_cluster_id, v_status;
  end if;

  -- The course's live publication (the fallback publication/version for a member
  -- whose thread carries no prior turn).
  select id, version into v_live_pub_id, v_live_version
  from public.course_publications
  where course_id = v_course_id and status = 'live'
  order by version desc
  limit 1;

  -- One instructor turn per DISTINCT dossier member of the cluster (a learner may
  -- own several dossiers in the cluster — several near-dup questions — but gets ONE
  -- reply). The ledger PK (cluster_id, user_id) enforces the per-member cap.
  for r in
    select distinct d.user_id
    from public.escalation_dossier d
    where d.cluster_id = p_cluster_id
  loop
    -- Already delivered to this member? (idempotency — retry / double Approve.)
    if exists (
      select 1 from public.escalation_reply_delivery
      where cluster_id = p_cluster_id and user_id = r.user_id
    ) then
      v_already := v_already + 1;
      continue;
    end if;

    -- The learner's thread for this course (one per learner per course). It should
    -- exist (the escalation came from a real conversation); create it if somehow
    -- absent so delivery never strands.
    select id into v_thread_id
    from public.tutor_threads
    where user_id = r.user_id and course_id = v_course_id;
    if not found then
      insert into public.tutor_threads (user_id, course_id)
      values (r.user_id, v_course_id)
      on conflict (user_id, course_id) do update set updated_at = now()
      returning id into v_thread_id;
    end if;

    -- Inherit publication_id + version from the learner's most-recent turn (NOT-NULL
    -- columns); fall back to the course's live publication.
    select publication_id, version into v_pub_id, v_version
    from public.tutor_turns
    where thread_id = v_thread_id
    order by created_at desc
    limit 1;
    if v_pub_id is null then
      v_pub_id := v_live_pub_id;
      v_version := v_live_version;
    end if;
    if v_pub_id is null or v_version is null then
      -- No publication resolvable (no prior turn AND no live publication) — a
      -- degenerate member; skip rather than write an invalid turn.
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Write the instructor turn into the learner's thread (service-role write; the
    -- append-only trigger + role check allow only this path). grounding stays '{}'.
    insert into public.tutor_turns
      (thread_id, user_id, course_id, role, content, publication_id, version, grounding)
    values
      (v_thread_id, r.user_id, v_course_id, 'instructor', v_answer, v_pub_id, v_version, '{}'::jsonb)
    returning id into v_turn_id;

    -- Record the delivery (exactly-once ledger). If a concurrent call raced us to
    -- this member, do-nothing swallows it and we DON'T double-count.
    insert into public.escalation_reply_delivery (cluster_id, user_id, turn_id)
    values (p_cluster_id, r.user_id, v_turn_id)
    on conflict (cluster_id, user_id) do nothing;
    if found then
      v_delivered := v_delivered + 1;
    else
      -- Lost the race: another call already delivered. The turn we wrote is a
      -- harmless duplicate for that member (append-only, immutable) but we don't
      -- count it — the ledger row is the source of truth for exactly-once.
      v_already := v_already + 1;
    end if;
  end loop;

  -- Flip the cluster to replied + adopt the final answer as its representative.
  update public.escalation_cluster
  set status = 'replied', representative_answer = v_answer, updated_at = now()
  where id = p_cluster_id;

  return jsonb_build_object(
    'delivered', v_delivered,
    'alreadyDelivered', v_already,
    'skipped', v_skipped
  );
end;
$$;
revoke all on function public.apply_escalation_reply(uuid, text) from public, anon, authenticated;
grant execute on function public.apply_escalation_reply(uuid, text) to service_role;

comment on function public.apply_escalation_reply(uuid, text) is
  'Service-role escalation reply delivery (Wave 6 P6.3). Writes ONE instructor tutor_turn per distinct dossier member of the cluster into that learner''s thread, EXACTLY-ONCE via the escalation_reply_delivery ledger (on-conflict-do-nothing on (cluster_id,user_id)), then flips the cluster to replied with the final answer as representative_answer. execute granted to service_role ONLY. Returns {delivered,alreadyDelivered,skipped}.';
