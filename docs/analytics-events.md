# Analytics — the event taxonomy, batching semantics, and rollup formulas

How learner behaviour becomes creator insight. Source of truth:
`lib/analytics/*` + migration `20260702050000_analytics_events.sql` (+ the
threshold filing in `20260703000000_maintenance_agent_comms.sql`).

## The event contract (`lib/analytics/events.ts`)

Nine event types in one Zod discriminated union (camelCase on the wire,
`mapEventToColumns` → the snake `learning_events` row):

| event | extra fields | emitted by |
|---|---|---|
| `lesson_started` | — | client (lesson open) |
| `slide_viewed` | `slideId`, `dwellMs` | client (visibility-aware dwell timer) |
| `video_progress` | `blockId`, `quartile` 1–3 | client (25/50/75 crossings) |
| `video_completed` | `blockId` | client (≥ VIDEO_COMPLETE_PCT) |
| `quiz_started` | `blockId` | client (quiz mount) |
| `quiz_submitted` | `blockId`, `attemptId` | **server** (quizService, keyed by the attempt id) |
| `homework_submitted` | `blockId` | **server** (homework route, keyed by the submission id) |
| `lesson_completed` | — | **server** (progressService, on the completed FLIP, keyed by the progress row id) |
| `session_heartbeat` | — | client (60s, visible-tab only) |

Every event carries `publicationId`/`version`/`courseId`/`lessonId` (+ optional
`blockId`/`slideId`), a uuid `clientEventId`, and `clientTs`.

**The hybrid trust split:** the browser reports only ENGAGEMENT; the
authoritative events are server-emitted with **stable row uuids as the
idempotency key**, so a closed tab loses nothing and a retry double-counts
nothing. No dashboard number depends solely on a client event — funnel
completion cross-checks `learn_progress`, quiz stats read
`quiz_attempts`/`question_responses`.

## Batching semantics (`lib/analytics/client.ts` + `AnalyticsProvider`)

- In-memory queue; flush every **10s**, on `visibilitychange → hidden`, on
  `pagehide`, and on unmount — always as `fetch(..., { keepalive: true })` so
  the final flush survives page teardown.
- Failed batches re-queue with exponential backoff (1s → … → 30s, jitter);
  4xx responses DROP the batch (a poisoned batch must not retry forever);
  batches chunk at 100 events; an offline queue caps at 500 (oldest dropped).
- Delivery is **at-least-once**; the DB-unique `client_event_id` makes replay a
  no-op, which is what makes the whole pipeline idempotent.
- Ingest = `POST /api/analytics/ingest` → the SECURITY DEFINER
  `ingest_learning_events` RPC. ⚠ Postgres applies the SELECT policy to
  `INSERT … ON CONFLICT` rows and students deliberately read none — hence the
  RPC (which pins `user_id = auth.uid()`, requires enrollment-or-authorship,
  and requires every publication to belong to its claimed course). The table's
  insert policy remains as defense-in-depth.
- Author previews emit nothing (`AnalyticsProvider enabled=false`).

## Rollups (nightly pg_cron `0 3 * * *` + author-gated `refresh_course_analytics`)

All keyed by `(course_id, publication_id, version)` — republished versions never
mix; the dashboard reads the live publication's rows only. Written exclusively
by `private.recompute_course_analytics(cid)`:

- **`rollup_lesson_funnel`** — per lesson (snapshot order): `started_count` =
  distinct users with ANY event for the lesson ∪ any `learn_progress` row ≠
  not_started (backfills pre-instrumentation learners; keeps completed ⊆
  started); `completed_count` = `learn_progress.status='completed'` OR a
  `lesson_completed` event; `dropoff_pct = 1 − started/lag(started)`.
- **`rollup_slide_dwell`** — `percentile_cont(0.5 | 0.9)` over `slide_viewed`
  dwell, grouped by slide (labels via `mode() within group` — min/max don't
  exist for uuid).
- **`rollup_question_stats`** — one attempt = one respondent; total score = #
  correct in the attempt. **Point-biserial discrimination**:

  ```
  r_pb = ((m1 − m0) / stddev_pop(total)) · sqrt(p·(1−p))
  ```

  where `p` = proportion correct, `m1`/`m0` = mean total of correct/incorrect
  respondents; null when n<2 or sd=0. `answer_distribution` buckets = choiceId |
  raw text | 'true'/'false' | sorted choiceIds joined '+'; `key_value` = the
  correct answer's bucket, resolved from `quiz_answer_keys` AT ROLLUP TIME.
  Mirrored (and golden-tested against SQL) by `lib/analytics/stats.ts`.
- **`rollup_video_retention`** — distinct users reaching each quartile
  (`video_completed` ⇒ q4).
- **`learner_flags`** — `inactive_7d_incomplete` (active enrollment,
  `coalesce(max(last_activity_at), enrolled_at) < now() − 7 days`) and
  `repeated_quiz_failure` (≥2 attempts < 60% on one block).

## Flag thresholds — the single-source rule

- Raw statistics live ONLY in SQL; the dashboard never recomputes them.
- Item-analysis flags live ONLY in `lib/analytics/flags.ts` (red:
  `pct_correct < 40 @ n ≥ 20` · top distractor ≥ 2× the key ·
  `discrimination < 0.1` · dwell skim/stall vs the publication's
  median-of-medians), applied at render time.
- The stuck-learner constants (7d / 2 attempts / 0.60) exist in BOTH SQL and TS
  by necessity (the nightly job needs them) — `verify-analytics.ts`
  regex-asserts the migration text against the TS constants so drift fails CI.

## Threshold → findings (Milestone 5 bridge)

After every recompute, `private.file_threshold_findings(cid)` files OPEN
`agent_findings` rows when flags cross the same limits — ONE finding per
question (reasons aggregated) and one per (learner, flag flavor), deduped by a
partial unique index on `(course_id, dedupe_key) where status='open'` so
nightly reruns never duplicate. Resolved findings may legitimately re-file if
the problem recurs. The studio surfaces the open count as a badge; a
maintenance run adopts open findings into its analysis.

## Tests

`npm run verify:analytics` (57 pure) · `verify:analytics:int` (55 live) ·
threshold filing + adoption also covered by `verify:maintenance:int`.
