/* ============================================================================
 * Wave 6 P6.5 — Creator digest (the ONLY sanctioned creator-addressed mail seam)
 * ----------------------------------------------------------------------------
 * A nightly (opt-in, daily-cadence) email summarising a course's new escalation
 * clusters + movers, sent to the COURSE AUTHOR. This is a NEW send seam distinct
 * from lib/comms (which mails LEARNERS). The row records `provider_mode` on EVERY
 * insert — the footgun guard: an unset RESEND_API_KEY silently downgrades the
 * provider to a recording mock, so a row is NEVER marked status='sent' unless it
 * was genuinely 'resend'-sent. `idempotency_key` (unique) makes a same-day re-run
 * a no-op. RLS: the author reads own rows (courses semi-join); ALL writes are
 * service-role / definer only (NO insert/update/delete policy).
 * ========================================================================== */

create table public.creator_digest (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  author_id       uuid not null,
  digest_date     date not null,
  content         jsonb not null,
  provider_mode   text not null check (provider_mode in ('resend','mock','dry_run')),
  status          text not null default 'pending'
    check (status in ('pending','sent','failed','dry_run')),
  idempotency_key text not null unique,
  sent_at         timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);

create index creator_digest_course_date_idx
  on public.creator_digest(course_id, digest_date desc);

alter table public.creator_digest enable row level security;

-- Author reads OWN course digests (identity-free content; the roster never rides
-- in the digest). Writes are service-role / definer only — NO insert/update/delete
-- policy, mirroring the creator_digest-is-a-server-seam contract.
create policy "creator_digest_select" on public.creator_digest for select
  using (course_id in (select c.id from public.courses c where c.author_id = (select auth.uid())));

comment on table public.creator_digest is
  'Creator-addressed escalation digest (Wave 6 P6.5). NEW send seam (lib/notify/creatorDigest.ts) distinct from lib/comms (learner mail). provider_mode persisted per row is the footgun guard — status=''sent'' ONLY when provider_mode=''resend'' AND the send succeeded. Author-read-own RLS; writes service-role only.';

/* ─────────────────── tutor_course_settings: opt-out + cadence ─────────────── */
alter table public.tutor_course_settings
  add column if not exists digest_opt_out boolean not null default false,
  add column if not exists digest_cadence text not null default 'daily'
    check (digest_cadence in ('daily','off'));

comment on column public.tutor_course_settings.digest_opt_out is
  'Creator opt-out for the escalation digest (Wave 6 P6.5). Re-checked AT SEND in lib/notify/creatorDigest.ts.';
comment on column public.tutor_course_settings.digest_cadence is
  'Digest cadence: daily (nightly cron) | off. Re-checked AT SEND.';
