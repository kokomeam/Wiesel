-- WiseSel — Milestone 5 (maintenance agent) + Milestone 6 (learner comms).
--
-- Adds the agent-run ledger (agent_runs — every run fully logged + replayable
-- from its report jsonb), the findings table (agent_findings — threshold-filed
-- nightly + Analyst-produced per run), the evidence column on change_set_items
-- (each agent proposal carries the finding's evidence into the review UI), and
-- learner_messages (Milestone 6 drafts — draft → approved → sent|failed, NO
-- auto-send path exists anywhere).
--
-- Safety rails (enforced by shape, verified by tests):
--   • The agent writes ONLY through change-sets against the draft; these
--     tables grant it no path to publications, enrollments, or sending.
--   • learner_messages rows are AUTHOR-only under RLS; learners receive email,
--     never an in-app surface. Sending happens exclusively through
--     lib/comms/service.ts (the single seam), which re-checks
--     enrollments.comms_opt_out at send time.
--   • Scheduled runs are QUEUED here by pg_cron (in-DB, works everywhere) and
--     executed by the CRON_SECRET-guarded drain route — pg_cron itself never
--     calls a model or sends anything.
--
-- NOTE: "trigger" is a reserved word — quoted in ALL raw SQL touching it.

-- ───────────────────────────── 1. agent_runs ───────────────────────────────
create table public.agent_runs (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses(id) on delete cascade,
  "trigger"   text not null check ("trigger" in ('chat','scheduled','threshold')),
  status      text not null default 'queued'
                check (status in ('queued','running','completed','failed')),
  -- null = whole course; else {moduleId?, lessonIds?, prompt?}
  scope       jsonb,
  -- {calls, inputTokens, outputTokens, reasoningTokens, cachedTokens}
  budget_used jsonb,
  -- The replay artifact: InsightReport + dispatch map + subagent transcripts.
  report      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index agent_runs_queued_idx on public.agent_runs(created_at)
  where status = 'queued';
create index agent_runs_course_status_idx on public.agent_runs(course_id, status);

-- ─────────────────────────── 2. agent_findings ─────────────────────────────
create table public.agent_findings (
  id            uuid primary key default gen_random_uuid(),
  -- null = threshold-filed and not yet adopted by a run.
  run_id        uuid references public.agent_runs(id) on delete set null,
  course_id     uuid not null references public.courses(id) on delete cascade,
  kind          text not null
                  check (kind in ('content_issue','learner_risk','structure_gap')),
  severity      text not null check (severity in ('low','medium','high')),
  -- e.g. 'question:<questionId>' (ONE finding per question — a question
  -- tripping several thresholds never spawns duplicate remediation) or
  -- 'learner_<flagType>:<userId>'.
  dedupe_key    text not null,
  -- Full FindingSchema payload: {id, kind, severity, title,
  --  evidence:{metrics, summary}, targets:{lessonId?,blockId?,questionId?,userId?},
  --  recommendation}
  finding       jsonb not null,
  status        text not null default 'open'
                  check (status in ('open','proposed','accepted','dismissed')),
  change_set_id uuid references public.change_sets(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- No duplicate OPEN findings across nightly filings; a resolved finding can
-- legitimately re-file later if the problem recurs.
create unique index agent_findings_open_dedupe
  on public.agent_findings(course_id, dedupe_key) where status = 'open';
create index agent_findings_course_status_idx
  on public.agent_findings(course_id, status);
create index agent_findings_run_idx on public.agent_findings(run_id);
create trigger agent_findings_set_updated_at before update on public.agent_findings
  for each row execute procedure extensions.moddatetime(updated_at);

-- ─────────────── 3. Evidence rides on every proposed change ────────────────
-- Nullable — every existing writer/reader is untouched; realtime replicates
-- the new column automatically.
alter table public.change_set_items add column evidence jsonb;

-- ───────────────────────── 4. learner_messages ─────────────────────────────
create table public.learner_messages (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null references public.courses(id) on delete cascade,
  finding_id          uuid references public.agent_findings(id) on delete set null,
  user_id             uuid not null references auth.users(id) on delete cascade,
  channel             text not null default 'email' check (channel in ('email')),
  subject             text not null,
  -- EmailBody block model (lib/comms/types.ts); rendered at SEND time so an
  -- edited draft always sends what the author last saw.
  body                jsonb not null,
  status              text not null default 'draft'
                        check (status in ('draft','approved','sent','failed')),
  sent_at             timestamptz,
  provider_message_id text,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index learner_messages_course_status_idx
  on public.learner_messages(course_id, status);
create index learner_messages_user_idx on public.learner_messages(user_id, course_id);
create trigger learner_messages_set_updated_at before update on public.learner_messages
  for each row execute procedure extensions.moddatetime(updated_at);

-- ──────────────────────────────── 5. RLS ───────────────────────────────────
-- All four tables are AUTHOR-only (the change_sets pattern). The cron drain
-- route and the opt-out route use the service-role client.
alter table public.agent_runs       enable row level security;
alter table public.agent_findings   enable row level security;
alter table public.learner_messages enable row level security;

create policy "agent_runs_select" on public.agent_runs for select
  using (private.is_course_author(course_id));
create policy "agent_runs_insert" on public.agent_runs for insert
  with check (private.is_course_author(course_id));
create policy "agent_runs_update" on public.agent_runs for update
  using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));

create policy "agent_findings_select" on public.agent_findings for select
  using (private.is_course_author(course_id));
create policy "agent_findings_insert" on public.agent_findings for insert
  with check (private.is_course_author(course_id));
create policy "agent_findings_update" on public.agent_findings for update
  using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));

create policy "learner_messages_select" on public.learner_messages for select
  using (private.is_course_author(course_id));
create policy "learner_messages_insert" on public.learner_messages for insert
  with check (private.is_course_author(course_id));
create policy "learner_messages_update" on public.learner_messages for update
  using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));
create policy "learner_messages_delete" on public.learner_messages for delete
  using (private.is_course_author(course_id));
-- No deletes on agent_runs/agent_findings: the run ledger is permanent
-- (course deletion cascades).

-- ───────────────── 6. Threshold filing (nightly, deduped) ──────────────────
-- Files OPEN findings when rollup flags cross the SAME limits the dashboard
-- flags at (mirrored in lib/analytics/flags.ts — edit together):
--   content_issue: pct_correct < 40 @ n ≥ 20 · top distractor ≥ 2× the key ·
--                  discrimination < 0.1
--   learner_risk:  every learner_flags row
-- ONE finding per question (reasons aggregated); on conflict do nothing
-- against the open-dedupe index.
create function private.file_threshold_findings(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- Content issues from the LIVE publication's question stats.
  insert into public.agent_findings
    (course_id, kind, severity, dedupe_key, finding)
  select
    cid,
    'content_issue',
    q.severity,
    'question:' || q.question_id,
    jsonb_build_object(
      'id', gen_random_uuid(),
      'kind', 'content_issue',
      'severity', q.severity,
      'title', 'Quiz question flagged by nightly thresholds',
      'evidence', jsonb_build_object(
        'metrics', jsonb_strip_nulls(jsonb_build_object(
          'pctCorrect', q.pct_correct,
          'n', q.n,
          'topDistractorCount', q.top_wrong,
          'keyCount', q.key_count,
          'discrimination', q.discrimination)),
        'summary', array_to_string(q.reasons, ' · ')
      ),
      'targets', jsonb_build_object(
        'lessonId', q.lesson_id, 'blockId', q.block_id,
        'questionId', q.question_id, 'userId', null),
      'recommendation',
        'Review the question wording, the correct answer, and the distractors.'
    )
  from (
    select
      s.question_id, s.block_id, s.lesson_id, s.n, s.pct_correct,
      s.discrimination,
      (select max(value::integer) from jsonb_each_text(s.answer_distribution)
        where key <> s.key_value) as top_wrong,
      coalesce((s.answer_distribution ->> s.key_value)::integer, 0) as key_count,
      case
        when (s.pct_correct < 25 and s.n >= 20) then 'high'
        else 'medium'
      end as severity,
      array_remove(array[
        case when s.pct_correct < 40 and s.n >= 20 then
          format('Only %s%% of %s learners answer correctly', s.pct_correct, s.n) end,
        case when s.key_value is not null and (
            select max(value::integer) from jsonb_each_text(s.answer_distribution)
            where key <> s.key_value
          ) >= 2 * greatest(coalesce((s.answer_distribution ->> s.key_value)::integer, 0), 1)
          then 'A wrong answer is chosen at least twice as often as the key' end,
        case when s.discrimination is not null and s.discrimination < 0.1 then
          format('Discrimination %s — strong and weak learners miss it alike',
                 s.discrimination) end
      ], null) as reasons
    from public.rollup_question_stats s
    join public.course_publications p
      on p.id = s.publication_id and p.status = 'live'
    where s.course_id = cid
  ) q
  where array_length(q.reasons, 1) >= 1
  on conflict (course_id, dedupe_key) where status = 'open' do nothing;

  -- Learner risks from the current flag pass.
  insert into public.agent_findings
    (course_id, kind, severity, dedupe_key, finding)
  select
    cid,
    'learner_risk',
    case when lf.flag_type = 'repeated_quiz_failure' then 'high' else 'medium' end,
    'learner_' || lf.flag_type || ':' || lf.user_id,
    jsonb_build_object(
      'id', gen_random_uuid(),
      'kind', 'learner_risk',
      'severity',
        case when lf.flag_type = 'repeated_quiz_failure' then 'high' else 'medium' end,
      'title',
        case when lf.flag_type = 'repeated_quiz_failure'
             then 'A learner keeps failing the same quiz'
             else 'A learner has gone quiet with the course unfinished' end,
      'evidence', jsonb_build_object(
        'metrics', '{}'::jsonb,
        'summary', lf.detail::text
      ),
      'targets', jsonb_build_object(
        'lessonId', null, 'blockId', null, 'questionId', null,
        'userId', lf.user_id),
      'recommendation', 'Draft a personal check-in for this learner.'
    )
  from public.learner_flags lf
  where lf.course_id = cid
  on conflict (course_id, dedupe_key) where status = 'open' do nothing;
end;
$$;

-- ───── 7. Wire filing into the two SMALL refresh callers (bodies copied ─────
-- verbatim from 20260702050000 — the big recompute is NEVER restated).
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
  end loop;
end;
$$;

-- ── 7b. Service-role access for the analytics read RPCs ────────────────────
-- Scheduled maintenance runs execute with the service-role client (no user
-- session), but course_analytics_overview/course_roster raised
-- 'not authenticated' on a null auth.uid(). Allow the service role through
-- (it bypasses RLS everywhere else anyway); authors stay author-gated and
-- anon stays revoked. Bodies otherwise verbatim from 20260702050000.
create or replace function public.course_analytics_overview(cid uuid)
returns jsonb language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is not null then
    perform 1 from public.courses where id = cid and author_id = v_uid;
    if not found then
      raise exception 'not the course author';
    end if;
  elsif coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'not authenticated';
  end if;

  return jsonb_build_object(
    'totalEnrollments',
      (select count(*) from public.enrollments e where e.course_id = cid),
    'activeEnrollments',
      (select count(*) from public.enrollments e
        where e.course_id = cid and e.status = 'active'),
    'completedEnrollments',
      (select count(*) from public.enrollments e
        where e.course_id = cid and e.status = 'completed'),
    'active7d',
      (select count(distinct lp.user_id) from public.learn_progress lp
        where lp.course_id = cid
          and lp.last_activity_at > now() - interval '7 days'),
    'enrollmentsByDay', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'count', d.n)
                       order by d.day)
      from (
        select (date_trunc('day', enrolled_at))::date as day,
               count(*)::integer as n
        from public.enrollments where course_id = cid group by 1
      ) d), '[]'::jsonb)
  );
end;
$$;

create or replace function public.course_roster(cid uuid)
returns table (
  user_id           uuid,
  display_name      text,
  email             text,
  enrolled_at       timestamptz,
  enrollment_status text,
  progress_pct      numeric,
  completed_lessons integer,
  total_lessons     integer,
  last_activity_at  timestamptz,
  flags             jsonb
) language plpgsql security definer stable set search_path = public as $$
declare
  v_uid   uuid := (select auth.uid());
  v_total integer;
begin
  if v_uid is not null then
    perform 1 from public.courses c where c.id = cid and c.author_id = v_uid;
    if not found then
      raise exception 'not the course author';
    end if;
  elsif coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'not authenticated';
  end if;

  select count(*)::integer into v_total
  from public.course_publications p,
       jsonb_array_elements(p.snapshot->'modules') m(value),
       jsonb_array_elements(m.value->'lessons') l(value)
  where p.course_id = cid and p.status = 'live';

  return query
  select
    e.user_id,
    coalesce(pr.display_name, 'Learner'),
    coalesce(u.email::text, ''),
    e.enrolled_at,
    e.status,
    case when v_total > 0
         then round(coalesce(sum(lp.pct), 0) / v_total, 1)
         else 0::numeric end,
    (count(lp.id) filter (where lp.status = 'completed'))::integer,
    v_total,
    max(lp.last_activity_at),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', lf.flag_type, 'detail', lf.detail, 'computedAt', lf.computed_at))
      from public.learner_flags lf
      where lf.course_id = cid and lf.user_id = e.user_id
    ), '[]'::jsonb)
  from public.enrollments e
  left join public.profiles pr on pr.id = e.user_id
  left join auth.users u on u.id = e.user_id
  left join public.learn_progress lp
    on lp.course_id = cid and lp.user_id = e.user_id
  where e.course_id = cid
  group by e.user_id, pr.display_name, u.email, e.enrolled_at, e.status
  order by e.enrolled_at desc;
end;
$$;

-- ───────────────── 8. Weekly scheduled maintenance queue ───────────────────
-- pg_cron QUEUES runs in-DB (works on localhost too); the CRON_SECRET-guarded
-- drain route executes them. Courses with a publication + learners only; the
-- not-exists guard prevents queue pileup if the drain lags.
select cron.schedule(
  'weekly-maintenance-runs',
  '0 4 * * 1',
  $$
  insert into public.agent_runs (course_id, "trigger", status)
  select c.id, 'scheduled', 'queued'
  from public.courses c
  where exists (select 1 from public.course_publications p where p.course_id = c.id)
    and exists (select 1 from public.enrollments e where e.course_id = c.id)
    and not exists (
      select 1 from public.agent_runs r
      where r.course_id = c.id and r.status in ('queued','running'));
  $$
);
