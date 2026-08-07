# Creator Tutor Console — Analytics (bad-lesson detection + most-missed)

TUTOR-1 Wave 5, package **P5.3**. The Analytics tab of `/studio/[courseId]/tutor`
turns the learner-side telemetry into a creator's "what needs my attention" view:
a ranked bad-lesson list, the most-missed questions with distractor breakdowns,
and confusion/mastery overlays over the outline.

Migration: `supabase/migrations/20260805120000_tutor_lesson_health.sql`.
TS: `lib/analytics/lessonHealth.ts` (+ `lessonRationale.ts` prompt).
UI: `components/studio/tutor/AnalyticsTutorTab.tsx` (server component).
Nightly: `lib/inngest/functions/tutorLessonHealth.ts` (`tutorLessonHealthNightly`,
cron `0 5 * * *`, registered in `app/api/inngest/route.ts`).

## The composite health score (deterministic)

`private.recompute_lesson_health(cid)` writes, per (publication, lesson), a
`composite_score ∈ [0,1]` (higher = needs more attention) as a **weighted sum of
five normalized inputs** (each 0..1, higher = worse). The composite is **pure SQL
arithmetic** — the model never computes or ranks it.

| Input                       | Weight | Source (already aggregated / floored)                                   |
| --------------------------- | -----: | ----------------------------------------------------------------------- |
| `mastery_shortfall`         | **0.30** | mean over the lesson's anchored concept nodes of `below_threshold_count / learner_count`, from `mastery_course_aggregate`, **cohort-floored to nodes with `learner_count >= 5`** |
| `first_attempt_error_rate`  | **0.25** | mean over the lesson's questions of `1 - pct_correct/100`, from `rollup_question_stats` (`n > 0`) |
| `confusion_density`         | **0.20** | the lesson-level `rollup_content_feedback.confusing_pct/100` (the `slide_id IS NULL` row) |
| `dropout_after_rate`        | **0.15** | `rollup_lesson_funnel.dropoff_pct` (already 0..1 — the drop entering this lesson) |
| `rewatch_scrub_density`     | **0.10** | mean over the lesson's videos of `1 - q4_count/viewers`, from `rollup_video_retention` (0 when there is no video) |

Weights **sum to 1.0**. They are named SQL constants (`v_w_*`) in the migration
and **MIRRORED** in `LESSON_HEALTH_WEIGHTS` (`lib/analytics/lessonHealth.ts`).

### Threshold single-source rule (drift guard)

The weights are the ONLY tunable threshold here, and they live in two places (the
SQL that WRITES the score + the TS mirror the UI/tests reason with). Per the
`verify-analytics.ts` precedent, `scripts/verify-tutor-analytics-console.ts`
regex-asserts the migration's `v_w_* constant numeric := <n>` lines equal the TS
`LESSON_HEALTH_WEIGHTS` values — a divergence trips CI. Change the weights in BOTH
and the guard keeps them honest.

### Rationale (bounded model role)

The composite decides the ranking; a nightly Terra step (`gpt-5.6-terra`,
`TUTOR_MODELS.lesson_rationale`) writes the human-readable `rationale` for the
**top-N flagged lessons** OVER THE ALREADY-COMPUTED evidence. The model never
computes, ranks, or invents numbers — it turns the computed facts (composite +
the five inputs + the implicated worst question) into one short case. A missing
key skips the rationale (the composite still ranks + renders); the write is
idempotent by `(publication_id, lesson_id)`.

## Most-missed questions

`most_missed_questions(p_course_id)` returns, per question, the first- vs
second-attempt error rate, per-option distractor counts, mapped concept node ids,
and a teaching-slide deep link — **ranked by first-attempt error desc**.

- **Attempt ordinal is DERIVED, never stored**: per `(user, block, question)` the
  `quiz_attempt_detail` rows are ordered by `(created_at, id)`; ordinal 1 = first
  attempt, 2 = second. This avoids duplicating `quiz_attempts.attempt_number`.
- **Per-option counts** come from `response_summary.selected` (a scalar for
  mc/tf, an array for ms) over every attempt — the distractor view.
- **Concept mapping**: a question's block → concept nodes whose `anchors[].blockId`
  reference that block (the R-13 anchor shape).

## Tool evidence (A3) — `tutor_evidence_recorded` + misconceptions

Amendment A3 Wave 2 (evidence spine). Every completed assessment-tool
interaction persists ONE event on the same `learning_events` stream, and
recurring wrong ideas roll up per concept for the console.

- **Event**: `tutor_evidence_recorded` (server-emitted; the ingest RPC's
  `tutor_%` arm rejects any client submission) with typed columns
  `tool_name` · `outcome` (`demonstrated|partial|not_demonstrated`) ·
  `misconception_slug` · `confidence` (`sure|unsure`) · `fade_level` (0–3) ·
  `initiation` (`question|practice_request|invitation_accepted`) ·
  `item_source` (`generated|reviewed`) · `reviewed_item_id` (null in A3) ·
  `latency_ms`. Envelope: `publication_id` + `version` required, lesson
  OPTIONAL (a tutor conversation spans lessons); `node_id` carries the concept
  node uuid.
- **Naming (ruling R-1)**: concepts have NO slug — the writer's `conceptSlug`
  parameter IS the concept node's uuid (merged nodes resolve to their survivor;
  unknown/retired nodes are refused as `unknown_concept`). Misconception ids
  are human-readable slugs (model-proposed, e.g. `insertion-order-preserved`),
  scoped per course.
- **Writer**: `recordToolEvidence` (`lib/tutor/runtime/evidenceRecord.ts`) is
  the single write path — admin client, NO approval/tool-tier machinery in the
  path (evidence recording is not a governed side effect). **Idempotency**: the
  `completionKey` derives the event's `client_event_id`, so exactly ONE row
  lands per completionKey and a replay is a no-op that still reports
  `recorded:true`. Misconception get-or-create against the registry is
  race-safe (concurrent proposers converge on one row).
- **Registry**: `public.tutor_misconceptions` — `(course_id, node_id, slug)`
  UNIQUE, versioned rows (optimistic updates: a stale `version` matches 0
  rows). RLS: author SELECT only; the service role is the only writer.
- **Rollup + floors**: `tutor_misconception_rollup(p_course_id)` (author-gated
  definer RPC) returns `{node_id, node_title, misconception_slug,
  learner_count, evidence_count, cohort_size}` — v1 semantics: `learner_count`
  = distinct learners ever observed holding the (node, slug) with
  `outcome ≠ demonstrated`; `cohort_size` = distinct learners with ANY tool
  evidence on the course. The ≥5 disclosure floor is applied INSIDE the RPC —
  a pair seen by <5 distinct learners is OMITTED, and a course whose cohort is
  <5 returns NOTHING. **Display rule (A3-23)** layers
  ON TOP: below a 20-learner cohort the console shows RAW COUNTS ONLY
  ("4 learners"); at ≥20 a percentage may ride alongside — encoded once in
  `misconceptionCountDisplay` (`lib/analytics/misconceptions.ts`) and rendered
  by the Analytics tab's "Misconceptions" section.

## Privacy — what creators can and can't see (Amendment D-4)

The **cohort floor is 5** and is applied INSIDE every author-gated definer RPC —
authors never read a raw learner table by any path.

- **`most_missed_questions`** — a question answered by **< 5 distinct learners is
  OMITTED entirely** (no count, no rates, no distractors). Above the floor, only
  per-question aggregates are emitted. It reads the ZERO-policy
  `quiz_attempt_detail` as a definer but never returns a learner row.
- **`lesson_health`** — per-lesson aggregates + the Terra rationale only. The
  `mastery_shortfall` input is floored to concept nodes with `learner_count >= 5`
  inside `recompute_lesson_health`; `mastery_course_aggregate` (ZERO-policy) is
  read only as a definer.
- **`rollup_lesson_health`** holds NO learner identity (only per-lesson numbers),
  so it carries an author-select semi-join policy as defense-in-depth; the loader
  still reads through the `lesson_health` definer RPC for consistency with D-4.
- **What a creator CAN see**: cohort-floored per-lesson health, per-question error
  rates + distractor distributions (≥5 learners), module-level mastery shares.
- **What a creator CANNOT see**: any individual learner's answers, per-question
  detail rows, mastery rows, or any number backed by fewer than five learners.

RLS matrix (enforced + tested in `verify-tutor-analytics-console-int.ts`): a
non-author (enrolled learner OR stranger) is refused every new RPC; the author
DIRECT-reads ZERO `quiz_attempt_detail` / `mastery_course_aggregate` /
`learner_mastery` rows.

## Grants

Every read RPC (`most_missed_questions`, `lesson_health`) is `revoke all … from
public, anon` + `grant execute … to authenticated`. The recompute wrapper
`recompute_lesson_health_admin` is `revoke … from public, anon, authenticated` +
`grant execute … to service_role` (the nightly Inngest job is the only caller).
