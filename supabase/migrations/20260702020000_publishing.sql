-- CourseGen Pro — Snapshot publishing (Milestone 1 of the publishing/analytics phase).
--
-- A PUBLICATION is an immutable, fully denormalized snapshot of the course
-- document (modules → lessons → blocks, resolved theme) written once at publish
-- time and never mutated. Creators keep editing the draft tables freely; the
-- student runtime reads ONLY publications. Node ids inside the snapshot are the
-- draft row ids (modules/lessons/blocks keep their UUIDs), so progress,
-- analytics events, and agent evidence stay joinable across versions.
--
-- Design notes:
--   • Quiz answer keys are STRIPPED from the snapshot at publish time into
--     `quiz_answer_keys`, which has RLS enabled and ZERO policies — no client
--     role can ever read it. Grading happens server-side (Milestone 2).
--   • Publishing runs through the SECURITY DEFINER `public.publish_course` RPC:
--     it is the one place that can insert publications + answer keys, and it is
--     a single transaction (version bump + retire previous live + insert).
--     There is deliberately NO insert policy on course_publications.
--   • Immutability is enforced IN THE DATABASE by a BEFORE UPDATE trigger:
--     snapshot / content_hash / version / course_id / published_at / created_by
--     can never change. Mutable columns: status (live|unpublished), visibility,
--     slug (+ previous_slugs for redirect-safe renames), linter_report never
--     needs to change so it is guarded too.
--   • Slug model: the slug lives on each publication row. Uniqueness is
--     enforced as "one LIVE publication per slug" (partial unique index) —
--     versions of the same course reuse the course's slug, and renamed slugs
--     stay resolvable (redirect) via `previous_slugs` + historical rows.
--   • Enrollment is at COURSE level (students always see the latest live
--     publication; progress survives republish because node ids are stable).

-- ───────────────────────── 1. course_publications ──────────────────────────
create table public.course_publications (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses(id) on delete cascade,
  version       integer not null check (version >= 1),
  -- URL-safe slug: lowercase alnum groups separated by single hyphens.
  slug          text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- Prior slugs of THIS course's publication line (redirect-safe renames).
  previous_slugs text[] not null default '{}',
  snapshot      jsonb not null,
  visibility    text not null default 'public'
                  check (visibility in ('public','unlisted')),
  status        text not null default 'live'
                  check (status in ('live','unpublished')),
  -- sha256 over {snapshot, answerKeys} — drives the "unpublished draft
  -- changes" indicator and the republish diff.
  content_hash  text not null,
  -- Pre-flight linter report persisted at publish time (audit trail).
  linter_report jsonb,
  published_at  timestamptz not null default now(),
  created_by    uuid not null references auth.users(id) on delete cascade,
  unique (course_id, version)
);
create index course_publications_course_id_idx on public.course_publications(course_id);
create index course_publications_slug_idx      on public.course_publications(slug);
-- At most ONE live publication per course, and one live claimant per slug.
create unique index course_publications_one_live_per_course_uidx
  on public.course_publications(course_id) where status = 'live';
create unique index course_publications_live_slug_uidx
  on public.course_publications(slug) where status = 'live';

-- Immutability guard: a publication's content identity can never change.
create function private.enforce_publication_immutable()
returns trigger language plpgsql as $$
begin
  if new.snapshot      is distinct from old.snapshot
     or new.content_hash  is distinct from old.content_hash
     or new.version       is distinct from old.version
     or new.course_id     is distinct from old.course_id
     or new.published_at  is distinct from old.published_at
     or new.created_by    is distinct from old.created_by
     or new.linter_report is distinct from old.linter_report
  then
    raise exception 'course_publications is immutable: snapshot/version/hash/report can never change';
  end if;
  return new;
end;
$$;
create trigger course_publications_immutable before update on public.course_publications
  for each row execute procedure private.enforce_publication_immutable();

-- ─────────────────────────── 2. quiz_answer_keys ───────────────────────────
-- Server-only: RLS enabled with NO policies. Written by publish_course
-- (security definer); read by server-side grading via the service-role client.
create table public.quiz_answer_keys (
  publication_id uuid not null references public.course_publications(id) on delete cascade,
  block_id       uuid not null,
  keys           jsonb not null,
  created_at     timestamptz not null default now(),
  primary key (publication_id, block_id)
);

-- ───────────────────────────── 3. enrollments ──────────────────────────────
create table public.enrollments (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'active'
                  check (status in ('active','dropped','completed')),
  comms_opt_out boolean not null default false,
  enrolled_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (course_id, user_id)
);
create index enrollments_course_id_idx on public.enrollments(course_id);
create index enrollments_user_id_idx   on public.enrollments(user_id);
create trigger enrollments_set_updated_at before update on public.enrollments
  for each row execute procedure extensions.moddatetime(updated_at);

-- ────────────────────────── 4. RLS helper functions ────────────────────────
-- SECURITY DEFINER so enrollment's insert policy can check for a live
-- publication without recursing through course_publications RLS.
create function private.has_live_publication(cid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.course_publications
    where course_id = cid and status = 'live'
  );
$$;

-- ──────────────────────────────── 5. RLS ───────────────────────────────────
alter table public.course_publications enable row level security;
alter table public.quiz_answer_keys    enable row level security;  -- NO policies: server-only
alter table public.enrollments         enable row level security;

-- Publications: owner always; anyone when live+public; any signed-in user when
-- live+unlisted (link-possession model). Non-live versions are owner-only.
create policy "publications_select" on public.course_publications for select
  using (
    private.is_course_author(course_id)
    or (status = 'live' and visibility = 'public')
    or (status = 'live' and visibility = 'unlisted' and (select auth.uid()) is not null)
  );
-- Owner may update ONLY the mutable columns (trigger guards the rest):
-- status (unpublish/restore), visibility, slug/previous_slugs.
create policy "publications_update" on public.course_publications for update
  using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));
-- No insert policy (publish_course RPC only) and no delete policy
-- (publications are permanent; course deletion cascades).

-- Enrollments: the student owns their row; the course owner can read.
create policy "enrollments_select" on public.enrollments for select
  using (user_id = (select auth.uid()) or private.is_course_author(course_id));
create policy "enrollments_insert" on public.enrollments for insert
  with check (
    user_id = (select auth.uid())
    and private.has_live_publication(course_id)
  );
create policy "enrollments_update" on public.enrollments for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- No delete: dropping a course is a status change (analytics keep the row).

-- ───────────────────────── 6. publish_course RPC ───────────────────────────
-- The ONE transaction that publishes: verifies authorship, locks the course
-- row (serializes concurrent publishes), bumps the version, retires the
-- previous live publication, inserts the new one + its answer keys, and
-- mirrors courses.status for the gallery. Slug: first publish takes p_slug;
-- republish always inherits the course's current slug (renames are a separate
-- owner UPDATE). Returns a summary (never the snapshot — callers have it).
create function public.publish_course(
  p_course_id     uuid,
  p_snapshot      jsonb,
  p_answer_keys   jsonb,          -- [{ "blockId": "<uuid>", "keys": {...} }, …]
  p_content_hash  text,
  p_linter_report jsonb default null,
  p_slug          text  default null,
  p_visibility    text  default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid        uuid := (select auth.uid());
  v_prev       public.course_publications%rowtype;
  v_version    integer;
  v_slug       text;
  v_visibility text;
  v_pub        public.course_publications%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  perform 1 from public.courses
    where id = p_course_id and author_id = v_uid
    for update;
  if not found then
    raise exception 'not the course author';
  end if;
  if p_snapshot is null or p_content_hash is null then
    raise exception 'snapshot and content_hash are required';
  end if;

  select * into v_prev from public.course_publications
    where course_id = p_course_id
    order by version desc
    limit 1;

  v_version := coalesce(v_prev.version, 0) + 1;
  v_slug := coalesce(v_prev.slug, p_slug);
  if v_slug is null then
    raise exception 'slug is required on first publish';
  end if;
  v_visibility := coalesce(p_visibility, v_prev.visibility, 'public');
  if v_visibility not in ('public','unlisted') then
    raise exception 'visibility must be public or unlisted';
  end if;

  update public.course_publications
    set status = 'unpublished'
    where course_id = p_course_id and status = 'live';

  insert into public.course_publications
      (course_id, version, slug, previous_slugs, snapshot, visibility,
       status, content_hash, linter_report, created_by)
    values
      (p_course_id, v_version, v_slug, coalesce(v_prev.previous_slugs, '{}'),
       p_snapshot, v_visibility, 'live', p_content_hash, p_linter_report, v_uid)
    returning * into v_pub;

  insert into public.quiz_answer_keys (publication_id, block_id, keys)
    select v_pub.id, (k->>'blockId')::uuid, k->'keys'
    from jsonb_array_elements(coalesce(p_answer_keys, '[]'::jsonb)) as k;

  update public.courses set status = 'published' where id = p_course_id;

  return jsonb_build_object(
    'id', v_pub.id,
    'courseId', v_pub.course_id,
    'version', v_pub.version,
    'slug', v_pub.slug,
    'visibility', v_pub.visibility,
    'status', v_pub.status,
    'contentHash', v_pub.content_hash,
    'publishedAt', v_pub.published_at
  );
end;
$$;

-- Only signed-in users may call it (it re-verifies authorship itself).
revoke all on function public.publish_course(uuid, jsonb, jsonb, text, jsonb, text, text) from public, anon;
grant execute on function public.publish_course(uuid, jsonb, jsonb, text, jsonb, text, text) to authenticated;
