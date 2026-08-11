-- TUTOR-1 — Amendment A4, Wave 1 follow-on: make apply_escalation_reply
-- lesson-thread-aware.
--
-- 20260810120000 re-scoped tutor_threads to (learner, LESSON) and DROPPED the
-- old UNIQUE(user_id, course_id). apply_escalation_reply (Wave 6 P6.3) still
-- assumed one thread per (learner, course):
--   • its `select id into v_thread_id ... where user_id and course_id` could now
--     match SEVERAL rows (one per lesson) and pick an arbitrary one; and
--   • its fallback insert used `on conflict (user_id, course_id)`, which now
--     references a constraint that no longer exists → a hard error if the branch
--     is ever taken (a member with no thread yet).
--
-- FIX (behavior otherwise identical): deliver the instructor reply into the
-- learner's MOST-RECENTLY-ACTIVE (non-archived) thread for the course
-- (deterministic), and when none exists create the GENERAL (null-lesson) thread
-- using the new partial-unique's predicate as the conflict target. Everything
-- else — the exactly-once ledger, the append-only instructor turn, the cluster
-- flip — is byte-for-byte the original.
--
-- ROLLBACK: re-run 20260806120000's create (the pre-A4 body) — but only valid
-- while UNIQUE(user_id, course_id) exists (i.e. after 20260810120000 is itself
-- rolled back).

create or replace function public.apply_escalation_reply(p_cluster_id uuid, p_final_answer text)
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

  select course_id, status into v_course_id, v_status
  from public.escalation_cluster
  where id = p_cluster_id;
  if not found then
    raise exception 'apply_escalation_reply: cluster % not found', p_cluster_id;
  end if;
  if v_status not in ('open', 'replied') then
    raise exception 'apply_escalation_reply: cluster % is % (must be open or replied)', p_cluster_id, v_status;
  end if;

  select id, version into v_live_pub_id, v_live_version
  from public.course_publications
  where course_id = v_course_id and status = 'live'
  order by version desc
  limit 1;

  for r in
    select distinct d.user_id
    from public.escalation_dossier d
    where d.cluster_id = p_cluster_id
  loop
    if exists (
      select 1 from public.escalation_reply_delivery
      where cluster_id = p_cluster_id and user_id = r.user_id
    ) then
      v_already := v_already + 1;
      continue;
    end if;

    -- A4: threads are lesson-scoped (many per course). Deliver into the learner's
    -- MOST-RECENTLY-ACTIVE (non-archived) thread — deterministic under multiple
    -- lesson threads; create it if somehow absent so delivery never strands.
    select id into v_thread_id
    from public.tutor_threads
    where user_id = r.user_id and course_id = v_course_id and archived_at is null
    order by updated_at desc
    limit 1;
    if not found then
      -- Create the GENERAL (null-lesson) thread. A4 replaced UNIQUE(user_id,
      -- course_id) with a partial unique; name its predicate as the conflict target.
      insert into public.tutor_threads (user_id, course_id)
      values (r.user_id, v_course_id)
      on conflict (user_id, course_id) where lesson_id is null and archived_at is null
        do update set updated_at = now()
      returning id into v_thread_id;
    end if;

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
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.tutor_turns
      (thread_id, user_id, course_id, role, content, publication_id, version, grounding)
    values
      (v_thread_id, r.user_id, v_course_id, 'instructor', v_answer, v_pub_id, v_version, '{}'::jsonb)
    returning id into v_turn_id;

    insert into public.escalation_reply_delivery (cluster_id, user_id, turn_id)
    values (p_cluster_id, r.user_id, v_turn_id)
    on conflict (cluster_id, user_id) do nothing;
    if found then
      v_delivered := v_delivered + 1;
    else
      v_already := v_already + 1;
    end if;
  end loop;

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
