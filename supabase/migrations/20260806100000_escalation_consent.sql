-- TUTOR-1 Wave 6 (P6.1) — escalation CONSENT relax.
--
-- The consent moment: when a learner confirms a tutor-raised escalation, they may
-- EDIT the exact payload before it is shared (the question they actually want the
-- instructor to answer, the concepts, the rung trail). The Wave-4 status-only
-- trigger (migration 20260804100000) froze ALL non-status columns once written —
-- so a consent transition that also edits the question was impossible.
--
-- This migration RELAXES `private.enforce_escalation_status_only()` so that DURING
-- the `consent_pending → consented` transition ONLY, three payload columns may
-- ALSO change in the same UPDATE: `learner_question`, `anchors`, `rung_trail`.
-- Every OTHER update stays status-only (the homework pattern, unchanged); an
-- illegal status transition still raises; both terminal states (consented,
-- withdrawn) remain FROZEN afterward — no column may change once terminal.
--
-- ── THE CONSENT INVARIANT (binding, UNTOUCHED here) ──────────────────────────
-- The RLS is not modified. `tutor_escalation_candidates` keeps its learner-own
-- SELECT + status-only UPDATE policies and has NO author policy at all. A
-- `consent_pending` or `withdrawn` row stays unreachable by ANY creator principal.
-- Only the consent transition (→ consented) moves an escalation into creator
-- scope, and it does so ONLY via P6.2's on-consent synthesis writing DERIVED rows
-- — never by opening this table to the author. This migration adds NO policy.

-- Consent timestamp — set by the consent path when the learner confirms sharing.
alter table public.tutor_escalation_candidates
  add column consented_at timestamptz;

-- RELAXED status-only trigger. Same illegal-transition + status-only semantics as
-- 20260804100000 for EVERY case except the ONE consent transition, where the
-- three payload columns are permitted to change alongside the status flip.
create or replace function private.enforce_escalation_status_only()
returns trigger language plpgsql set search_path = public as $$
declare
  v_is_consent boolean;
begin
  -- The consent transition is the ONLY update allowed to edit payload columns.
  v_is_consent := (old.status = 'consent_pending' and new.status = 'consented');

  -- Immutable-always columns (never editable, in any transition).
  if new.user_id               is distinct from old.user_id
     or new.course_id             is distinct from old.course_id
     or new.node_ids              is distinct from old.node_ids
     or new.tutor_proposed_answer is distinct from old.tutor_proposed_answer
     or new.created_at            is distinct from old.created_at
  then
    raise exception 'tutor_escalation_candidates: only the status may change';
  end if;

  -- Payload columns (learner_question, anchors, rung_trail): editable ONLY during
  -- the consent transition (the learner confirming/editing the exact payload).
  -- Any other update that touches them is status-only-violating and raises.
  if not v_is_consent then
    if new.learner_question is distinct from old.learner_question
       or new.anchors       is distinct from old.anchors
       or new.rung_trail    is distinct from old.rung_trail
    then
      raise exception 'tutor_escalation_candidates: only the status may change';
    end if;
  end if;

  -- Legal transitions out of consent_pending only; both consented and withdrawn
  -- are terminal (no further status change).
  if new.status is distinct from old.status
     and not (old.status = 'consent_pending' and new.status in ('consented','withdrawn'))
  then
    raise exception 'tutor_escalation_candidates: illegal status transition % → %', old.status, new.status;
  end if;

  return new;
end;
$$;

comment on column public.tutor_escalation_candidates.consented_at is
  'When the learner consented to share this escalation with the instructor (set on the consent_pending → consented transition). Null while pending or withdrawn.';
comment on function private.enforce_escalation_status_only() is
  'Status-only guard for tutor_escalation_candidates (Wave 4), RELAXED in Wave 6 (P6.1): during the consent_pending → consented transition ONLY, the payload columns learner_question/anchors/rung_trail may also change (the learner confirms/edits the exact payload at consent). Every other update stays status-only; both terminal states stay frozen. RLS is untouched — the consent invariant (no author policy) holds.';
