-- WiseSel — Milestone 7: learner-comms delivery tracking (Resend webhooks).
--
-- Extends the M3 learning-event stream with five SERVER-EMITTED comms delivery
-- event types (comms_email_delivered / _open / _click / _bounce / _complaint),
-- adds a delivery-status trail to learner_messages, and a per-user suppression
-- table (hard bounce / spam complaint → never send again).
--
-- Trust model:
--   • Comms events are emitted ONLY by the Resend webhook route (service role)
--     after Svix signature verification. The webhook handler resolves the
--     learner from the learner_messages row — NEVER from the payload/tags —
--     so user attribution is server-pinned (the M3 discipline).
--   • The client batch path can NEVER mint one: the ingest Zod contract
--     excludes comms types, and the ingest_learning_events RPC independently
--     rejects them (a comms event has no publication, and the RPC requires the
--     publication to belong to the claimed course).
--   • Idempotency: client_event_id = a uuid DERIVED deterministically from the
--     Svix message id (`svix-id` is stable across retries), so a redelivered
--     webhook upserts into the same row and no-ops. Trail entries dedupe by
--     svixId inside apply_comms_delivery.
--   • comms_suppressions has RLS enabled and ZERO policies (the
--     quiz_answer_keys precedent): only the service role reads/writes it —
--     the send seam re-checks it AT SEND TIME, and creators see suppression
--     state only through the author-gated messages API.

-- ─────────────── 1. learning_events: admit the comms taxonomy ───────────────
alter table public.learning_events
  drop constraint learning_events_event_type_check;
alter table public.learning_events
  add constraint learning_events_event_type_check check (event_type in (
    'lesson_started','slide_viewed','video_progress','video_completed',
    'quiz_started','quiz_submitted','homework_submitted','lesson_completed',
    'session_heartbeat',
    'comms_email_delivered','comms_email_open','comms_email_click',
    'comms_email_bounce','comms_email_complaint'));

-- A comms event belongs to a COURSE, not a publication/lesson (the email is
-- course-scoped and outlives republishes). Learner events keep the full
-- envelope — enforced by the check below, so the M3 rollups' assumptions hold.
alter table public.learning_events alter column publication_id drop not null;
alter table public.learning_events alter column version        drop not null;
alter table public.learning_events alter column lesson_id      drop not null;
alter table public.learning_events
  add constraint learning_events_envelope_check check (
    event_type like 'comms_email_%'
    or (publication_id is not null and version is not null and lesson_id is not null));

-- ───────────── 2. learner_messages: the delivery-status trail ───────────────
-- delivery_status = the single authoritative delivery state (monotone by rank:
-- none < sent < delivered < opened < clicked < bounced < complained — advanced
-- only by apply_comms_delivery, never downgraded by out-of-order webhooks).
-- delivery_events = the audit trail ({type, at, via, svixId?, detail?}).
alter table public.learner_messages
  add column delivery_status text not null default 'none'
    check (delivery_status in
      ('none','sent','delivered','opened','clicked','bounced','complained')),
  add column delivery_events jsonb not null default '[]'::jsonb;

-- Backfill: everything already sent starts its trail at 'sent'.
update public.learner_messages set delivery_status = 'sent' where status = 'sent';

-- ─────────────────────── 3. comms_suppressions ──────────────────────────────
-- Per-USER (an address that hard-bounces or complains is bad for every course).
create table public.comms_suppressions (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  reason     text not null check (reason in ('hard_bounce','complaint')),
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.comms_suppressions enable row level security;
-- ZERO policies — deliberately server-only (see the trust model above).

-- ────────────── 4. apply_comms_delivery (atomic status + trail) ─────────────
-- One locked round trip per webhook: advance delivery_status only UP the rank
-- ladder (concurrent/out-of-order deliveries can't downgrade), append the
-- trail entry only if its svixId is unseen (retry-safe), cap the trail at 50.
-- p_status null = trail-only note (email.sent / email.delivery_delayed).
-- Callable by the service role ONLY.
create function public.apply_comms_delivery(
  p_message_id uuid,
  p_status     text,
  p_entry      jsonb
) returns jsonb language plpgsql set search_path = public as $$
declare
  v_ranks constant text[] :=
    array['none','sent','delivered','opened','clicked','bounced','complained'];
  v_row        public.learner_messages%rowtype;
  v_new_status text;
  v_append     boolean;
begin
  select * into v_row from public.learner_messages
    where id = p_message_id for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  v_new_status := v_row.delivery_status;
  if p_status is not null
     and array_position(v_ranks, p_status) is not null
     and array_position(v_ranks, p_status)
         > coalesce(array_position(v_ranks, v_row.delivery_status), 0) then
    v_new_status := p_status;
  end if;

  v_append := p_entry is not null
    and (p_entry ->> 'svixId') is not null
    and jsonb_array_length(v_row.delivery_events) < 50
    and not exists (
      select 1 from jsonb_array_elements(v_row.delivery_events) e
      where e ->> 'svixId' = p_entry ->> 'svixId');

  update public.learner_messages
     set delivery_status = v_new_status,
         delivery_events = case when v_append
           then delivery_events || jsonb_build_array(p_entry)
           else delivery_events end
   where id = p_message_id;

  return jsonb_build_object('found', true, 'status', v_new_status, 'appended', v_append);
end;
$$;
revoke all on function public.apply_comms_delivery(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_comms_delivery(uuid, text, jsonb)
  to service_role;
