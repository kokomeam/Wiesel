# Analytics — the event taxonomy, batching semantics, and rollup formulas

How learner behaviour becomes creator insight. Source of truth:
`lib/analytics/*` + migration `20260702050000_analytics_events.sql` (+ the
threshold filing in `20260703000000_maintenance_agent_comms.sql`, + the comms
delivery extension in `20260707000000_comms_delivery_tracking.sql`, + the
perf-vitals extension in `20260718100100_perf_vitals.sql`).

## The event contract (`lib/analytics/events.ts`)

Sixteen event types in one Zod discriminated union — ten learner events,
five comms delivery events (M7, next section), and one app-scoped perf event
(PERF-1 E1, its own section below). CamelCase on the wire,
`mapEventToColumns` → the snake `learning_events` row. The learner ten:

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
| `slide_feedback` (M10) | `blockId`, `slideId`, `reaction` helpful\|confusing, `comment` (≤500, nullable) | client (the per-slide reaction control) |

Every learner event carries `publicationId`/`version`/`courseId`/`lessonId`
(+ optional `blockId`/`slideId`), a uuid `clientEventId`, and `clientTs`.

**slide_feedback idempotency (M10):** the stream is append-only — a learner
toggling their reaction emits a NEW event each time, and **latest reaction
wins per (user, slide)** is enforced in the rollup (`distinct on … order by
server_ts desc`), never by mutating the log. The toggle UI's current state
comes from the narrow `my_slide_feedback` definer RPC (the caller's OWN
latest reactions only — students still read no `learning_events` rows).
Typed extras follow the M3 convention: real `reaction`/`feedback_comment`
columns with CHECKs (comment cap 500 = `FEEDBACK_COMMENT_MAX_CHARS`,
drift-guarded).

**The hybrid trust split:** the browser reports only ENGAGEMENT; the
authoritative events are server-emitted with **stable row uuids as the
idempotency key**, so a closed tab loses nothing and a retry double-counts
nothing. No dashboard number depends solely on a client event — funnel
completion cross-checks `learn_progress`, quiz stats read
`quiz_attempts`/`question_responses`.

## Comms delivery events (Milestone 7 — `lib/comms/webhook.ts`)

Five webhook-emitted types, extending the SAME union / table / row mapping
(no parallel schema, no second pipeline):

| event | extra fields | source (Resend) |
|---|---|---|
| `comms_email_delivered` | — | `email.delivered` |
| `comms_email_open` | — | `email.opened` |
| `comms_email_click` | `url` (≤500) | `email.clicked` |
| `comms_email_bounce` | `bounceType` hard\|soft, `bounceSubtype` | `email.bounced` (`Permanent` = hard) |
| `comms_email_complaint` | — | `email.complained` |

They carry a **course-only envelope** — `courseId` + `messageId` (the
`learner_messages` row, stored in `metadata`), with `publication_id` /
`version` / `lesson_id` NULL (an email is course-scoped and outlives
republishes; a DB check constraint keeps the full envelope mandatory for every
non-comms type, so rollup assumptions hold). `clientEventId` is DERIVED from
the Svix message id (`uuidFromSvixId`) — `svix-id` is stable across webhook
retries, so the UNIQUE constraint is the idempotency store.

**They are not client-reportable.** `AnalyticsBatchSchema` composes only the
client set (a comms event 400s at ingest), and the ingest RPC independently
rejects them (no publication). The ONLY emitter is the Svix-verified webhook
route, and the learner is attributed from the `learner_messages` row — never
from the payload. Full flow: `docs/comms-delivery-tracking.md`.

## Perf vitals (PERF-1 E1 — `lib/analytics/vitals.ts` + `components/perf/WebVitalsReporter.tsx`)

`perf_vital` is the one **app-scoped** client event: RUM web-vitals through
the SAME contract, batch schema, ingest route, RPC, and table — never a
parallel pipeline. `[FWD: agent-runtime-perf]` — E4 agent-latency metrics
will ride the same discriminator as further app-scoped members.

| field | shape |
|---|---|
| `metric` | `LCP` \| `INP` \| `CLS` \| `FCP` \| `TTFB` |
| `value` | ms for the timing metrics; **CLS is its raw unitless float** (column is `numeric` — never rescaled) |
| `rating` | `good` \| `needs-improvement` \| `poor` (web-vitals' own rating) |
| `route` | normalized route **pattern** (`normalizeRoute`: known app shapes → `/learn/[slug]/[lessonId]`-style; unknown paths get uuid segments scrubbed; ≤200 chars, DB-CHECKed) — never a raw URL |
| `deviceClass` | `mobile` \| `desktop` (viewport media query, evaluated once per load) |
| `navigationType` | web-vitals `Metric.navigationType`, nullable |

**No `courseId`/`publicationId`/`lessonId`** — a vital belongs to a route.
The ingest RPC skips the enrolled-or-author + publication∈course checks for
exactly this type (still pinning `user_id = auth.uid()`; a learner event in
the same batch is still fully gated), and inserts NULL
course/publication/lesson — both directions DB-CHECKed
(`learning_events_perf_vital_check`). Idempotency is unchanged: the UNIQUE
`client_event_id` dedupes replays.

**Emission** (`WebVitalsReporter`, mounted once in the root layout): the
`web-vitals` library (v5 — a **sanctioned exception** to the runtime-dep
freeze, explicitly mandated by the PERF-1 directive E1) with
`reportAllChanges: false` (final values only), attributed to the hard-loaded
route (App Router soft navigations are not separately attributed). Events
buffer in memory and flush on `visibilitychange → hidden` / `pagehide` via
`navigator.sendBeacon` (fallback: keepalive fetch).

**Sampling:** `NEXT_PUBLIC_PERF_VITALS_SAMPLE` (0..1, default 1 — report
everything), decided once per page load with `shouldSample`.

**Auth gap (documented):** `/api/analytics/ingest` requires a session, and a
beacon can't observe its response — so the first flush of a browser session
goes via keepalive fetch; a 401 marks the session denied (sessionStorage) and
every later flush no-ops. **Signed-out visitors on public pages report no
vitals** until a public ingest path is sanctioned — do not build a parallel
anonymous path around this.

**Read surface (E2):** perf rows have NULL `course_id`, so the author-select
semi-join policy excludes them — vitals are unreadable by every client role.
The only read surface is the `public.perf_vitals_daily` view (per
day×route×metric×device: `n`, `p50`/`p75`/`p95` of `metric_value`; SECURITY
INVOKER, revoked from anon/authenticated → service-role/internal dashboards
only for now).

**Alert thresholds (PERF-1 §2)** — alert when a daily p75 crosses the
web-vitals "needs-improvement" boundary: LCP > 2500 ms · INP > 200 ms ·
CLS > 0.1 · FCP > 1800 ms · TTFB > 800 ms. **Standing rule: production RUM
thresholds are monitoring alerts, never quality gates** — a crossing pages a
human; it never blocks a build/deploy/publish.

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
- **`rollup_content_feedback`** (M10) — per slide AND per lesson (slide_id
  null = the lesson row, summing that lesson's per-(user,slide) latest
  reactions): distinct-learner helpful/confusing counts deduped to each
  learner's LATEST reaction, `confusing_pct` (raw stat — the flag threshold
  lives in TS `feedbackOutlier`: ratio ≥ 0.4 at n ≥ 3), and a newest-first
  sample of non-null comments from the latest set (5/slide, 8/lesson).
  Recomputed by `private.recompute_content_feedback` from the two refresh
  wrappers. Surfaces on the Content health tab's unified "Slide health" table
  (dwell + feedback, one per-slide row set) and as the funnel's Feedback
  column — no separate feedback tab.
- **`rollup_course_reviews`** (M9) — per COURSE (not per publication):
  review count, average rating, 1–5 distribution. Recomputed by
  `private.recompute_course_reviews` from the two refresh wrappers (nightly +
  manual). Review TEXT is not rolled up — the dashboard reads it live under
  author RLS.
- **`learner_flags`** — `inactive_incomplete` (active enrollment,
  `coalesce(max(last_activity_at), enrolled_at) < now() − 4 days` — M8 retuned
  7→4 and renamed the flag duration-neutral) and `repeated_quiz_failure`
  (≥2 attempts < 60% on one block). Computed by
  `private.recompute_learner_flags` (extracted in M8 — migration
  `20260707010000` — so flag tuning never restates the big rollup function).

## Flag thresholds — the single-source rule

- Raw statistics live ONLY in SQL; the dashboard never recomputes them.
- Item-analysis flags live ONLY in `lib/analytics/flags.ts` (red:
  `pct_correct < 40 @ n ≥ 20` · top distractor ≥ 2× the key ·
  `discrimination < 0.1` · dwell skim/stall vs the publication's
  median-of-medians), applied at render time.
- The stuck-learner constants (4d / 2 attempts / 0.60, + the 14d nudge
  cooldown) exist in BOTH SQL and TS by necessity (the nightly job needs
  them) — `verify-analytics.ts` regex-asserts the M8 migration text
  (`20260707010000`) against the TS constants so drift fails CI.

## Threshold → findings (Milestone 5 bridge; M8 guards)

After every recompute, `private.file_threshold_findings(cid)` files OPEN
`agent_findings` rows when flags cross the same limits — ONE finding per
question (reasons aggregated) and ONE per learner
(`learner_risk:<userId>`, matching `dedupeKeyForFinding` in
`lib/ai/maintenanceSchema.ts` so Analyst adoption works — M8 fixed the old
per-flavor keys that never collided with the TS scheme), deduped by a partial
unique index on `(course_id, dedupe_key) where status='open'` so nightly
reruns never duplicate. Resolved findings may legitimately re-file if the
problem recurs.

**M8 nudge guards (filing-time — the dashboard Stuck queue still shows every
stuck learner; only the automatic draft-producing pipeline is guarded):**
learner risks are NOT filed for learners who opted out of comms, are
suppressed (M7 hard bounce/complaint), or have ANY `learner_messages` row for
the course within the last 14 days (`NUDGE_COOLDOWN_DAYS` — one check-in per
silence, not a drumbeat; the old pipeline re-nudged every run once a draft
flipped the finding to 'proposed'). The studio surfaces the open count as a
badge; a maintenance run adopts open findings into its analysis.

## Tests

`npm run verify:analytics` (77 pure) · `npm run verify:vitals` (60 pure —
the perf_vital contract, column mapping, route-normalization table, sampling
gate, builder stamps, and a drift guard regexing migration `20260718100100`
for the TS-mirrored literals) · `verify:analytics:int` (live — incl.
the PERF-1 E1 matrix: forged-userId pinning, NULL course envelope, replay
dedupe, no-enrollment vitals vs still-gated learner events, DB CHECKs,
client-unreadable rows, service-role-only view; plus
the M8 filing guards: merged key, 4-day threshold, opt-out/suppression/
cooldown each blocking alone and lifting; the M9 review matrix: eligibility
both branches, forged-insert rejection, upsert, RLS, rollup correctness +
idempotence; and the M10 feedback matrix: ingest through the existing RPC,
DB-CHECK rejection of malformed rows, toggle-sequence latest-wins, comment
sampling, lesson aggregation, idempotence, author-only RLS, own-reactions
RPC) · threshold filing + adoption also covered by `verify:maintenance:int` ·
the comms event extension (contract, batch rejection, column mapping, webhook
end-to-end) by `verify:comms` (61 pure) + `verify:comms:int` (46 live).
