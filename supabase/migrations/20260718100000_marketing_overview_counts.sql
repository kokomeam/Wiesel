-- PERF-1 D-phase (C2-backlog hygiene, diagnosis §A3 "fetch-to-count" / A6 #15):
-- the account summary ran ~13 exact HEAD-count queries PER COURSE per call —
-- fanned out per course on /marketing/overview. One SECURITY DEFINER GROUP BY
-- round trip returns every per-course count the summary derives its funnels
-- from. The per-course getAnalyticsSummary (single-course dashboards + the
-- agent observe step) keeps its existing shape — only the account-level
-- fan-out moves here.
--
-- Contract (validated zod-first in lib/marketing/analytics.ts): jsonb {
--   event_counts:       [{course_id, type, n}]   — analytics_event by (course, type)
--   subscriber_counts:  [{course_id, status, n}] — subscriber by (course, status)
--   hard_bounce_counts: [{course_id, n}]         — scheduled_send bounce_type='hard'
--                       (Amendment 8: hard bounces come from the outbox's
--                       classification, never raw bounce events)
-- }
--
-- Author gate: the uncorrelated semi-join form (the Phase-C3 precedent —
-- hashed once per statement, never evaluated per row). auth.uid() null or a
-- courseless author → three empty arrays.

create function public.marketing_account_counts()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  with my_courses as (
    select c.id from public.courses c where c.author_id = (select auth.uid())
  )
  select jsonb_build_object(
    'event_counts', coalesce((
      select jsonb_agg(jsonb_build_object('course_id', t.course_id, 'type', t.type, 'n', t.n))
      from (
        select ae.course_id, ae.type, count(*)::int as n
        from public.analytics_event ae
        where ae.course_id in (select id from my_courses)
        group by ae.course_id, ae.type
      ) t
    ), '[]'::jsonb),
    'subscriber_counts', coalesce((
      select jsonb_agg(jsonb_build_object('course_id', t.course_id, 'status', t.status, 'n', t.n))
      from (
        select s.course_id, s.status, count(*)::int as n
        from public.subscriber s
        where s.course_id in (select id from my_courses)
        group by s.course_id, s.status
      ) t
    ), '[]'::jsonb),
    'hard_bounce_counts', coalesce((
      select jsonb_agg(jsonb_build_object('course_id', t.course_id, 'n', t.n))
      from (
        select ss.course_id, count(*)::int as n
        from public.scheduled_send ss
        where ss.bounce_type = 'hard'
          and ss.course_id in (select id from my_courses)
        group by ss.course_id
      ) t
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.marketing_account_counts() from public, anon;
grant execute on function public.marketing_account_counts() to authenticated;
