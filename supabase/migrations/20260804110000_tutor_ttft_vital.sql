-- WiseSel — TUTOR-1: admit TUTOR_TTFT to the perf_vital metric CHECK.
--
-- WHY: the learner tutor's client-measured TIME-TO-FIRST-FRAME (ms from the
-- outgoing /api/learn/tutor fetch to the first SSE frame) is a real user-
-- perceived latency, and it rides the EXACT SAME app-scoped perf_vital
-- contract as the web-vitals five (same Zod contract, same batching client,
-- same ingest RPC, same learning_events table — never a parallel path). The
-- only DB gate that hard-lists the allowed metrics is the metric_name CHECK
-- added by 20260718100100; extend it here so TUTOR_TTFT rows insert.
--
-- ALERTS-NOT-GATES: like every perf_vital metric, a TUTOR_TTFT threshold
-- crossing (its daily p75 rising into "needs-improvement" territory) pages a
-- human via the perf_vitals_daily read surface — it NEVER blocks a
-- build/deploy/publish. TUTOR_TTFT is a monitoring signal, not a quality gate.
--
-- Everything else in 20260718100100 already admits TUTOR_TTFT unchanged:
--   • learning_events_event_type_check keeps 'perf_vital'.
--   • learning_events_perf_vital_check's WHEN branch (event_type='perf_vital')
--     places no constraint on navigation_type, so a null it is fine.
--   • the metric list is the ONLY place the metric name itself is enumerated.
-- So this migration touches exactly one constraint.

alter table public.learning_events
  drop constraint learning_events_metric_name_check;
alter table public.learning_events
  add constraint learning_events_metric_name_check
    check (metric_name is null
           or metric_name in ('LCP','INP','CLS','FCP','TTFB','TUTOR_TTFT'));
