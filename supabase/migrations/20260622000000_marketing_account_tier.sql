-- Marketing Assistant — account (creator) tier above course scope.
--
-- Adds a per-creator master mailing list so a person is ONE identity across all
-- their courses, while per-course funnel state stays on `subscriber`. Events roll
-- up to a person AND a course.
--
--   audience_contact  — one row per (author_id, email); name, consent, GLOBAL
--                       unsubscribe. The creator's general list.
--   subscriber.contact_id      — links the per-course membership to the contact.
--   analytics_event.contact_id — events roll up to a person (keeps course_id).
--
-- Backfill is idempotent (derives contacts from existing subscribers). Reversible
-- down-migration at the bottom (commented) — apply as a separate migration if
-- ever needed.
--
-- ⚠ Proposed for human review. Apply only after sign-off; regenerate
--   lib/database.types.ts afterwards.

create extension if not exists moddatetime schema extensions;

/* ─────────────────────────── audience_contact ──────────────────────────
 * The creator's master mailing list. Scoped directly to the author (not a
 * course), so RLS is author_id = auth.uid(). */
create table public.audience_contact (
  id              uuid primary key default gen_random_uuid(),
  author_id       uuid not null references auth.users(id) on delete cascade,
  email           text not null,
  name            text,
  consent         jsonb not null default '{}'::jsonb,
  attributes      jsonb not null default '{}'::jsonb,
  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (author_id, email)
);
create index audience_contact_author_id_idx on public.audience_contact(author_id);
create trigger audience_contact_set_updated_at before update on public.audience_contact
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.audience_contact enable row level security;
create policy "audience_contact_select" on public.audience_contact for select using (author_id = (select auth.uid()));
create policy "audience_contact_insert" on public.audience_contact for insert with check (author_id = (select auth.uid()));
create policy "audience_contact_update" on public.audience_contact for update using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "audience_contact_delete" on public.audience_contact for delete using (author_id = (select auth.uid()));

/* ───────────────────── contact_id on the course tables ─────────────────
 * Nullable FK (set null on contact delete). Existing author-scoped RLS on
 * subscriber / analytics_event already covers these columns. */
alter table public.subscriber      add column contact_id uuid references public.audience_contact(id) on delete set null;
alter table public.analytics_event add column contact_id uuid references public.audience_contact(id) on delete set null;
create index subscriber_contact_id_idx      on public.subscriber(contact_id);
create index analytics_event_contact_id_idx on public.analytics_event(contact_id);

/* ──────────────────────────────── backfill ─────────────────────────────
 * 1) one contact per (author, email) derived from existing subscribers. */
insert into public.audience_contact (author_id, email, name, created_at)
select c.author_id, s.email, min(s.name), min(s.created_at)
from public.subscriber s
join public.courses c on c.id = s.course_id
group by c.author_id, s.email
on conflict (author_id, email) do nothing;

-- 2) link each subscriber to its contact.
update public.subscriber s
set contact_id = ac.id
from public.courses c, public.audience_contact ac
where c.id = s.course_id
  and ac.author_id = c.author_id
  and ac.email = s.email
  and s.contact_id is null;

-- 3) roll existing events up to the contact via their subscriber.
update public.analytics_event e
set contact_id = s.contact_id
from public.subscriber s
where s.id = e.subscriber_id
  and s.contact_id is not null
  and e.contact_id is null;

/* ─────────────────────── down-migration (reference) ────────────────────
 * drop index if exists public.analytics_event_contact_id_idx;
 * drop index if exists public.subscriber_contact_id_idx;
 * alter table public.analytics_event drop column if exists contact_id;
 * alter table public.subscriber      drop column if exists contact_id;
 * drop table if exists public.audience_contact;
 */
