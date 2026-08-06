-- WiseSel — TUTOR-1 Wave 6.6: widen the learning_events.job_type CHECK to the
-- two remaining Terra job kinds so their runTurn cost rows can land.
--
-- Two Terra jobs — lesson_rationale (P5.3, the lesson-health rationale synthesis)
-- and escalation_dossier (P6.2, the on-consent escalation synthesis) — currently
-- SKIP their runTurn tutor_model_call cost row in the withPooledModel decorator,
-- because the learning_events.job_type CHECK (added in 20260803100000) was closed
-- to the four telemetered kinds (graph_extraction, reconciliation, embedding,
-- tutor_turn) and the ingest CHECK would reject any other value.
--
-- This drops + re-adds that CHECK with the two new kinds appended (the existing
-- four are preserved verbatim). The decorator's skip for these two is removed in
-- the same wave (lib/ai/subagent.ts) so their cost rows now emit — closing the two
-- deferred cost-tracking deviations. `practice_gen` stays a decorator-side skip (a
-- separate luna precedent, never a DB job_type — deliberately NOT added here).
--
-- The two-sided learning_events_tutor_call_check (also from 20260803100000) is
-- unchanged: it only requires job_type to be NON-NULL for a tutor_model_call and
-- NULL otherwise — the value CHECK below is the sole enumerator, so widening it
-- here is the complete change. No RLS / view / ingest-RPC change is needed (the
-- view aggregates by job_type generically; the ingest RPC never accepts tutor_%
-- rows in the first place).

alter table public.learning_events
  drop constraint learning_events_job_type_check;

alter table public.learning_events
  add constraint learning_events_job_type_check
    check (job_type is null
           or job_type in ('graph_extraction','reconciliation','embedding','tutor_turn','lesson_rationale','escalation_dossier'));
