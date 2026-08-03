-- WiseSel — Milestone 9 (Engagement & Retention wave): course reviews.
--
-- Creator-only reviews: learners who are done (or nearly done) with a course
-- rate it 1–5 with optional text; creators read them on the analytics
-- Overview. NO public read path this wave — is_public exists for the future
-- but nothing selects on it.
--
-- Trust model:
--   • user_id is server-pinned: the submit RPC uses auth.uid(), and the RLS
--     write policies BOTH require user_id = auth.uid() AND the eligibility
--     gate — so a forged direct insert fails the same way the RPC does.
--   • Eligibility = a completion-adjacent signal, reusing the codebase's
--     existing "almost done" threshold: enrollment status 'completed' OR
--     course progress ≥ 70% (sum(learn_progress.pct) / live-snapshot lesson
--     count — the exact course_roster formula). Mirrored in
--     lib/learn/reviews.ts REVIEW_ELIGIBLE_PROGRESS_PCT; drift-guarded by
--     verify-analytics.ts.
--   • One review per (course, learner): UNIQUE + upsert semantics — editing
--     is a re-submission, never a second row; updated_at maintained.
--   • Reviews are DIRECT HUMAN INPUT — they never touch the change-set
--     Accept/Reject flow (that is for AI mutations only).
--   • The prompt-dismissal state (review_dismissed_at / review_dismiss_count
--     on enrollments) is written only via the dismiss RPC (auth-pinned).

-- ───────────────────────────── 1. course_reviews ────────────────────────────
create table public.course_reviews (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  review_text text,
  -- Reserved for a future public-display wave: no UI, no API surface, no
  -- query path reads it yet.
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (course_id, user_id)
);
create index course_reviews_course_recent_idx
  on public.course_reviews(course_id, updated_at desc);
create trigger course_reviews_set_updated_at before update on public.course_reviews
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.course_reviews enable row level security;

-- ─────────────── 2. Eligibility (the server-side gate, ONE place) ───────────
create function private.is_review_eligible(cid uuid, uid uuid)
returns boolean language plpgsql security definer stable
set search_path = public as $$
declare
  v_status text;
  v_total  numeric;
  v_sum    numeric;
begin
  select e.status into v_status
  from public.enrollments e
  where e.course_id = cid and e.user_id = uid;
  if not found then return false; end if;
  if v_status = 'completed' then return true; end if;
  if v_status <> 'active' then return false; end if; -- dropped learners aren't asked

  select count(*)::numeric into v_total
  from public.course_publications pub,
       jsonb_array_elements(pub.snapshot->'modules') m(value),
       jsonb_array_elements(m.value->'lessons') l(value)
  where pub.course_id = cid and pub.status = 'live';
  if v_total is null or v_total = 0 then return false; end if;

  select coalesce(sum(lp.pct), 0)::numeric into v_sum
  from public.learn_progress lp
  where lp.course_id = cid and lp.user_id = uid;

  -- The "almost done" threshold already used elsewhere (comms templates,
  -- Stuck queue) — mirrored as REVIEW_ELIGIBLE_PROGRESS_PCT in TS.
  return (v_sum / v_total) >= 70;
end;
$$;

-- ────────────────────────────── 3. RLS ──────────────────────────────────────
-- Learners: own row only, writes additionally gated on eligibility (a forged
-- client call fails here even without the RPC). Creators: read-only over
-- their own courses. Nobody deletes (edit = re-submit). No public read path.
create policy "course_reviews_select_own" on public.course_reviews
  for select using (user_id = (select auth.uid()));
create policy "course_reviews_select_author" on public.course_reviews
  for select using (private.is_course_author(course_id));
create policy "course_reviews_insert_own_eligible" on public.course_reviews
  for insert with check (
    user_id = (select auth.uid())
    and private.is_review_eligible(course_id, user_id));
create policy "course_reviews_update_own_eligible" on public.course_reviews
  for update using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and private.is_review_eligible(course_id, user_id));

-- ───────────── 4. Prompt-dismissal state (enrollment-scoped) ────────────────
alter table public.enrollments
  add column review_dismissed_at  timestamptz,
  add column review_dismiss_count smallint not null default 0;

-- ─────────────────────────── 5. The submit RPC ──────────────────────────────
-- Upsert semantics; rating validated here AND by the table CHECK; text
-- trimmed + capped at 2000 chars (empty → null).
create function public.submit_course_review(
  p_course_id uuid, p_rating integer, p_review_text text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.course_reviews;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'rating must be between 1 and 5';
  end if;
  if not private.is_review_eligible(p_course_id, v_uid) then
    raise exception 'not eligible to review this course yet';
  end if;

  insert into public.course_reviews (course_id, user_id, rating, review_text)
  values (
    p_course_id, v_uid, p_rating::smallint,
    nullif(left(trim(p_review_text), 2000), '')
  )
  on conflict (course_id, user_id) do update
    set rating      = excluded.rating,
        review_text = excluded.review_text,
        updated_at  = now()
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'rating', v_row.rating,
    'reviewText', v_row.review_text,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at
  );
end;
$$;
revoke all on function public.submit_course_review(uuid, integer, text)
  from public, anon;
grant execute on function public.submit_course_review(uuid, integer, text)
  to authenticated;

-- ───────────── 6. Prompt state (one read for the learn pages) ───────────────
create function public.review_prompt_state(p_course_id uuid)
returns jsonb language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid     uuid := (select auth.uid());
  v_status  text;
  v_dis_at  timestamptz;
  v_dis_n   smallint;
  v_review  jsonb;
  v_creator text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select pr.display_name into v_creator
  from public.courses c
  left join public.profiles pr on pr.id = c.author_id
  where c.id = p_course_id;

  select e.status, e.review_dismissed_at, e.review_dismiss_count
    into v_status, v_dis_at, v_dis_n
  from public.enrollments e
  where e.course_id = p_course_id and e.user_id = v_uid;
  if not found then
    return jsonb_build_object(
      'enrolled', false, 'eligible', false, 'review', null,
      'dismissCount', 0, 'dismissedAt', null,
      'creatorName', coalesce(v_creator, 'the creator'));
  end if;

  select jsonb_build_object(
           'rating', r.rating, 'reviewText', r.review_text,
           'updatedAt', r.updated_at)
    into v_review
  from public.course_reviews r
  where r.course_id = p_course_id and r.user_id = v_uid;

  return jsonb_build_object(
    'enrolled', true,
    'eligible', private.is_review_eligible(p_course_id, v_uid),
    'review', v_review,
    'dismissCount', coalesce(v_dis_n, 0),
    'dismissedAt', v_dis_at,
    'creatorName', coalesce(v_creator, 'the creator'));
end;
$$;
revoke all on function public.review_prompt_state(uuid) from public, anon;
grant execute on function public.review_prompt_state(uuid) to authenticated;

-- ───────────────────────────── 7. Dismiss RPC ───────────────────────────────
create function public.dismiss_review_prompt(p_course_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  update public.enrollments
     set review_dismissed_at  = now(),
         review_dismiss_count = least(review_dismiss_count + 1, 100)
   where course_id = p_course_id and user_id = v_uid;
  return found;
end;
$$;
revoke all on function public.dismiss_review_prompt(uuid) from public, anon;
grant execute on function public.dismiss_review_prompt(uuid) to authenticated;

-- ──────────────────────── 8. rollup_course_reviews ──────────────────────────
-- Per COURSE (reviews are course-level, not publication-level). Standard
-- rollup posture: author-select RLS, zero client writes, idempotent
-- delete+insert recompute, refreshed nightly + on manual refresh.
create table public.rollup_course_reviews (
  course_id           uuid primary key references public.courses(id) on delete cascade,
  review_count        integer not null,
  avg_rating          numeric(3,2) not null,
  -- {"1": n, "2": n, "3": n, "4": n, "5": n}
  rating_distribution jsonb not null,
  computed_at         timestamptz not null default now()
);
alter table public.rollup_course_reviews enable row level security;
create policy "rollup_course_reviews_select" on public.rollup_course_reviews
  for select using (private.is_course_author(course_id));

create function private.recompute_course_reviews(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.rollup_course_reviews where course_id = cid;
  insert into public.rollup_course_reviews
    (course_id, review_count, avg_rating, rating_distribution)
  select
    cid,
    count(*)::integer,
    round(avg(rating), 2),
    jsonb_build_object(
      '1', count(*) filter (where rating = 1),
      '2', count(*) filter (where rating = 2),
      '3', count(*) filter (where rating = 3),
      '4', count(*) filter (where rating = 4),
      '5', count(*) filter (where rating = 5))
  from public.course_reviews
  where course_id = cid
  having count(*) > 0;
end;
$$;

-- ───── 9. Wire into the two SMALL refresh callers (the 20260703 precedent —
-- the big recompute is never restated; bodies verbatim + the reviews call) ───
create or replace function public.refresh_course_analytics(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  perform 1 from public.courses where id = cid and author_id = v_uid;
  if not found then
    raise exception 'not the course author';
  end if;
  perform private.recompute_course_analytics(cid);
  perform private.file_threshold_findings(cid);
  perform private.recompute_course_reviews(cid);
end;
$$;

create or replace function private.refresh_all_course_analytics()
returns void language plpgsql security definer set search_path = public as $$
declare
  c record;
begin
  for c in
    select distinct course_id from public.course_publications
  loop
    perform private.recompute_course_analytics(c.course_id);
    perform private.file_threshold_findings(c.course_id);
    perform private.recompute_course_reviews(c.course_id);
  end loop;
end;
$$;
