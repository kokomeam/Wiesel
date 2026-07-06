-- CourseGen Pro — "My learning" listing RPC (Milestone 2 follow-up).
--
-- One row per enrollment of the CALLER, joined to the course's live
-- publication and the caller's own progress counts. SECURITY DEFINER because
-- lesson totals require aggregating the snapshot jsonb (not composable via
-- PostgREST) — but every row is hard-scoped to auth.uid()'s enrollments, and
-- only card-safe metadata leaves (never the snapshot body).
create function public.my_learning()
returns table (
  enrollment_id     uuid,
  enrollment_status text,
  enrolled_at       timestamptz,
  course_id         uuid,
  publication_id    uuid,
  slug              text,
  version           integer,
  title             text,
  description       text,
  level             text,
  total_lessons     integer,
  completed_lessons integer,
  last_activity_at  timestamptz
)
language sql security definer stable set search_path = public as $$
  select
    e.id,
    e.status,
    e.enrolled_at,
    e.course_id,
    p.id,
    p.slug,
    p.version,
    p.snapshot->'course'->>'title',
    p.snapshot->'course'->>'description',
    p.snapshot->'course'->>'level',
    coalesce((
      select sum(jsonb_array_length(m->'lessons'))::integer
      from jsonb_array_elements(p.snapshot->'modules') as m
    ), 0),
    coalesce((
      select count(*)::integer from public.learn_progress lp
      where lp.user_id = e.user_id
        and lp.course_id = e.course_id
        and lp.status = 'completed'
    ), 0),
    (
      select max(lp.last_activity_at) from public.learn_progress lp
      where lp.user_id = e.user_id and lp.course_id = e.course_id
    )
  from public.enrollments e
  join public.course_publications p
    on p.course_id = e.course_id and p.status = 'live'
  where e.user_id = (select auth.uid())
    and e.status in ('active','completed')
  order by coalesce((
    select max(lp.last_activity_at) from public.learn_progress lp
    where lp.user_id = e.user_id and lp.course_id = e.course_id
  ), e.enrolled_at) desc;
$$;
revoke all on function public.my_learning() from public, anon;
grant execute on function public.my_learning() to authenticated;
