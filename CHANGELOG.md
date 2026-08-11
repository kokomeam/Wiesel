# Changelog — Course Studio editor upgrade

## TUTOR-1 Amendment A4 — calibration + docs (Wave 5), 2026-08-11 — AMENDMENT COMPLETE

The final wave: τ calibration, docs, Playwright. A4 (lesson-scoped threads +
course retrieval) is now fully shipped (Wave 0 audit + Waves 1–5).

- **τ calibration (+ a signal fix).** `scripts/calibrate-tutor-tau.ts` ran a
  32-query labeled corpus through REAL hybrid retrieval over cs61b (259 chunks,
  real embeddings). The calibration REVEALED that the RRF fused-rank score cannot
  separate relevant from irrelevant queries (both cluster at ~1/61 — the vector arm
  always returns a rank-1 nearest, the lexical arm rarely stacks on the same
  chunk). Fixed: the retrieve RPC now returns the top chunk's raw **cosine
  similarity** (migration `20260811100000`), and `insufficient_local_context` +
  the provenance gate compare THAT to τ. Re-calibrated: sufficient queries score
  0.51–0.68, insufficient 0.02–0.33 — τ ∈ [0.33, 0.50] gives **0% false-expansion
  AND 0% missed-expansion**; default **τ = 0.40** (mid-band, robust).
- **Docs (no stubs):** `docs/tutor/retrieval.md` (eligibility, the four expansion
  codes, τ + its calibration, the `[FWD]` source_tier seam + what enabling
  'adjacent' requires, the metrics table) + `docs/tutor/threading.md` (thread
  resolution, compaction, chain-expiry recovery, why no automatic reset).
- **Metrics (real):** lesson-grounding tokens/turn ~2,000 → ~900 (instrumented
  875→74 on a synthetic lesson); embedding cost cs61b ≈ $0.002 (measured);
  expansion/cross-lesson rates instrumented for production measurement.
- **Playwright (`verify-tutor-a4-browser.ts`, 11 checks, ran green vs a prod
  server):** open the tutor on two lessons → SEPARATE threads (A4-2); a seeded
  cross-lesson citation renders a single "Go to {label}" link that names its
  destination + resolves (D-8/A4-23/24); no UUID in the tutor panel (A4-22);
  derived chips render + vary with the active lesson (D-9). Deterministic (seeded,
  no live model); the model-generated flows are int-covered.
- **Test coverage** (the directive's unit + int requirements, shipped across
  Waves 1–4): eligibility + each expansion condition + compaction thresholds
  (`verify-tutor-scope.ts` / `verify-tutor-threading.ts`); thread resolution +
  chain rebuild + hybrid retrieval (`verify-tutor-threading-int.ts` /
  `verify-tutor-retrieval-int.ts` / `verify-tutor-scope-int.ts`).

## TUTOR-1 Amendment A4 — tutor integration + UI (Wave 4), 2026-08-11

Retrieval replaces the whole-lesson prompt dump; D-7/D-8/D-9 fixed. HARD STOP
after Wave 4 (τ calibration + docs + Playwright = Wave 5).

- **A4-26 · L2 → retrieval:** when a turn is retrieval-grounded, the developer
  message drops the whole-lesson L2 dump for a SHORT lesson header (title +
  objective); the retrieved passages carry the content. The per-turn token delta
  (L2 before vs header+retrieval after, ≈chars/4) is logged (`tutor_token_delta`)
  and surfaced on the result. Measured: **875 → 74 tokens (−801)** on a real
  lesson. A retrieval-empty turn keeps the full L2 (no regression).
- **D-7 · no learner-facing IDs (A4-22):** `lib/learn/tutorNav.ts`
  `redactInternalIds` scrubs any UUID the model echoed from the cleaned prose
  (before it reaches the escalation proposal too); labels + chips are id-free by
  construction.
- **D-8 · real "Go there" destinations (A4-23/24):** the server resolves a human
  LABEL (lesson title · "slide N") for every citation
  (`lib/tutor/retrieval/citationLabels.ts`), rides the turn payload, and is
  persisted into the grounding jsonb (history too). The chip renders **at most one**
  nav affordance per message (`primaryNavAffordance`), NAMES its destination, and
  never renders without a resolvable anchor.
- **D-9 · derived chips (A4-25):** `lib/learn/tutorChips.ts` `deriveSuggestionChips`
  replaces the static 4-chip array — chips vary with the active lesson title
  (new `ambient.lessonTitle`), the weakest flagged concept (review queue), and
  conversation state; deduped by action; the "Quiz me on this lesson" string
  stays pinned (the practice classifier depends on it).
- **Tests:** `verify-tutor-wave4.ts` (29 pure/loop — chip snapshots ×3 states,
  UUID redaction/detection, label resolution, ≤1 nav affordance, and the loop
  L2-replacement + token-delta + prose-redaction). runtime (270) / client (436) /
  route-int (77) re-ran green. Build/tsc/lint clean.

## TUTOR-1 Amendment A4 — scope policy (Wave 3), 2026-08-11

Eligibility + tiered expansion + forward/failure/contradiction behaviors, wired
into the tutor turn. HARD STOP after Wave 3 (full prompt-layer replacement + UI =
Wave 4).

- **Engine (`lib/tutor/retrieval/{scopeConfig,conceptLessons,eligibility,expansion,forward,scopePolicy}.ts`, pure):**
  eligibility = active ∪ **completed** (`learn_progress.status='completed'`) —
  never ordinal (A4-14). `conceptLessons` is the packaged concept↔lesson resolver
  the Wave-0 audit found missing (anchors→lessons, question→concepts,
  prereq→covering-lessons via `rootCause`). `runScopedRetrieval` retrieves Tier 1
  (active, 6) always and Tier 2 (completed, 4) ONLY under one recorded expansion
  code — **explicit_request / multi_concept_span / prerequisite_gap /
  insufficient_local_context** (priority-fused; never fires into an empty pool) —
  emitting `tutor.retrieval.expanded`. Forward material (a concept only in an
  incomplete lesson) → name it + decline (A4-17); total failure → offer creator
  escalation (A4-18); provenance gate (no course attribution without a hit,
  A4-20). τ is env-configurable + flagged PROVISIONAL (calibrated in Wave 5).
- **Loop integration:** the turn runs the scope policy over an **un-pooled**
  retriever (query embeds off the learner chat pool — §2/A4-21), injects the
  retrieved passages + forward-decline/failure-escalation/provenance instructions,
  and routes a model-flagged `contradiction` (new output-contract field) into the
  escalation loop (`tutor.contradiction.detected`, A4-19). The whole-lesson L2
  stays for now — Wave 4 replaces it + measures the token delta. The service
  builds the retriever over `deps.embedModel` (route passes an un-pooled
  `createOpenAIModelClient()`; tests inject the mock) + loads completed lessons.
- **Tests:** `verify-tutor-scope.ts` (40 pure/loop — the 100-query eligibility
  property test, all four codes independently, forward/failure/contradiction/
  provenance, no-extra-chat-call + un-pooled-embed source assertions, loop
  injection + surfacing) + `verify-tutor-scope-int.ts` (12 int — real completion→
  eligibility, real chunks retrieved in a real turn, expansion + event,
  incomplete-never-eligible, one chat call vs N embed calls). Build/tsc/lint clean.

## TUTOR-1 Amendment A4 — retrieval index (Wave 2), 2026-08-10

The pgvector chunk store + hybrid retrieval, embedded at publish. Not yet wired
into the tutor (that is Wave 4). HARD STOP after Wave 2.

- **Schema (migration `20260810140000`):** `create extension vector` + `tutor_chunks`
  (publication_id/version/content_hash/lesson_id/block_id/slide_id/chunk_ordinal/
  text/`embedding vector(1536)`/`tsv` GENERATED tsvector/`source_tier` CHECK=`'canon'`
  [FWD `'adjacent'` reserved, unreachable]/`display_anchor` jsonb). Indexes: **hnsw**
  (cosine) + **gin**(tsv) + (publication_id, lesson_id). RLS: enrolled-or-author
  select; writes only via the definer RPCs. Two SECURITY DEFINER RPCs:
  `tutor_store_chunks` (idempotent replace) + `tutor_retrieve_chunks` (hybrid).
- **Hybrid retrieval:** the retrieve RPC fuses a pgvector cosine (`<=>`) arm with a
  lexical `websearch_to_tsquery`/`ts_rank` arm by **reciprocal rank fusion**, so a
  lexical-only hit ("LLRB", "2-3 tree") a pure-vector search misses is still
  surfaced (A4-10). The eligible-lesson filter (`lesson_id = any(p_lesson_ids)`)
  runs INSIDE both arms (A4-11), never as a post-filter.
- **Chunker (`lib/tutor/retrieval/chunker.ts`, pure):** one chunk per SLIDE (the
  deep-linkable unit) / per non-deck text block; imported_deck + video skipped
  (no snapshot prose); reuses the concept-graph `collectStrings` walker; every
  chunk carries a resolvable `{lessonId, blockId, slideId?}` anchor (fixes D-8).
- **Embed at publish (`embedStore.ts` + Inngest `tutorChunksEmbed`):** the publish
  hook fires `tutor/chunks.embed.requested`; the durable worker embeds via a
  CREATOR-pooled client (never the LEARNER pool — Wave-0 §2) and stores. IDEMPOTENT
  by publication id: an unchanged republish makes ZERO embed calls (A4-9).
  `TUTOR_EMBEDDING_DIMS`/`padToDims` (zero-padding is cosine-preserving, so the
  32-dim test mock ranks identically to a real 1536-vector).
- **Tests:** `verify-tutor-retrieval.ts` (26 pure — chunker grain/anchors,
  padToDims cosine-preservation, the A4-11 lesson-filter + A4-13 CHECK source
  assertions, publish→embed wiring) + `verify-tutor-retrieval-int.ts` (24 int —
  embed-every-lesson, idempotent zero-re-embed, hybrid lexical-only match,
  in-query lesson filter, resolvable anchors, `source_tier='adjacent'` rejected).
  Build + tsc + lint clean.

## TUTOR-1 Amendment A4 — lesson-scoped threads + compaction (Wave 0 audit + Wave 1), 2026-08-10

Milestone-gated. Wave 0 = the read-only audit (`docs/audits/TUT-A4-audit.md`,
11/11 questions answered live). Wave 1 = LESSON-SCOPED tutor threads. HARD STOP
after Wave 1 (retrieval index is Wave 2).

- **Schema (migration `20260810120000`):** `tutor_threads` gains `lesson_id`
  (snapshot node id, **NO FK** — the tutor no-FK-to-draft convention),
  `archived_at` (Start-fresh marker), `compaction_summary` + `compacted_through_turn`.
  The old `UNIQUE(user_id, course_id)` is DROPPED and replaced by TWO PARTIAL
  uniques that exclude archived rows — one ACTIVE thread per (user, lesson) and
  one general (null-lesson) thread per (user, course). Backfill attributes a
  legacy thread to a lesson only when its turns name exactly one (2 of 24 live);
  the rest stay readable null-lesson general threads. Rollback proven clean.
- **Resolution:** `ensureThread` → **`resolveThread({userId, courseId, lessonId})`**
  (race-safe get-or-create without `onConflict` — the partial unique can't be a
  conflict arbiter; SELECT-active → INSERT → on-23505 re-SELECT). `archiveThread`
  flips `archived_at` (never deletes). Opening a different lesson resolves a
  different thread; the persistent client mount reloads history on lesson switch
  (never archiving — A4-6). Every `(user,course)`-keyed read fixed for
  multi-thread-per-course: `readActiveStream` (in-flight thread), `loadTutorHomeEntries`
  (latest turn per course_id), `loadTutorHistory` (lesson param), plus the
  `apply_escalation_reply` RPC (migration `20260810130000` — its `ON CONFLICT
  (user_id, course_id)` targeted the dropped constraint).
- **Compaction (A4-4):** `lib/tutor/runtime/compaction.ts` (pure thresholds +
  fold plan + summarizer prompt + L4 assembly) + `maybeCompactThread` (small-tier
  rolling summary, best-effort, at turn start). The model's L4 prepends the summary
  + a bounded verbatim window; the FULL transcript stays in `tutor_turns` for
  display. No summary ⇒ byte-identical to the pre-A4 replay.
- **Chain recovery (A4-5):** a rejected/stale `previous_response_id` (30-day
  OpenAI retention) is recovered TRANSPARENTLY — the loop rebuilds the textual
  replay + retries once without the anchor, emitting `tutor.chain.rebuilt`
  (`lib/tutor/runtime/runtimeEvents.ts` seam). No learner-visible error.
- **UI:** a "Start fresh" header control (`data-ai-tool=tutor-start-fresh`) archives
  the lesson thread; course-outline dots (`data-ai-tutor-thread`, `CourseNavSidebar`)
  mark lessons with an existing conversation (`loadTutoredLessonIds`).
- **Tests:** `verify:tutor` += `verify-tutor-threading.ts` (32 pure — thresholds,
  L4 assembly, chain-rebuild through the loop, the no-auto-reset source assertion);
  `verify:tutor:int` += `verify-tutor-threading-int.ts` (40 — per-lesson resolution,
  legacy survival, archive-not-delete, compaction persist+fold, outline exactness).
  stream-int (36) + route-int (77) re-ran green on the changed turn path. Build +
  tsc + lint clean.

## TUTOR-1 Wave 2 — learner mastery model (BKT · evidence contract · strict regime), 2026-08-03

Deterministic math and SQL only — ZERO model calls (grep-guarded + proven by
the cost-telemetry query in the checkpoint). Docs: `docs/tutor/mastery.md`;
report: `TUTOR-1-wave2-checkpoint.md`.

- **Evidence contract (migration `20260803110000`):** five new event members
  on the ONE stream — practice_answer / hint_request / self_report /
  tutor_inference SERVER-ONLY (the ingest RPC rejects them from the client
  batch; tutor_inference's {node_id, direction, strength, turn_ref} metadata
  is the FROZEN Wave-3 side-channel), content_engagement the one client
  member (rewatch/scrub_back/completed — a browser can't know node ids).
  Five typed CHECKed columns with bidirectional per-member isolation;
  dwell_over_median is NOT an event (derived in the refold vs the cohort
  rollup).
- **Quiz attempt detail (migration `20260803110100`):** per-question
  correctness + selections-only response_summary under STRICT-regime RLS
  (zero policies; learner-own reads via my_quiz_detail; deliberately NO
  author policy). The grading write is now genuinely ATOMIC — the
  record_quiz_attempt service-role RPC folds attempt + responses + detail
  into one transaction (attempt_number max+1 in SQL with bounded retry +
  replay adoption), replacing the old sequential inserts. verify:learn:int
  (61) green on the rewired path. No backfill is possible — detail accrues
  forward; historical attempts fold as weaker block-level evidence (the
  cold-start story).
- **BKT mastery engine (`lib/tutor/mastery/`):** 4-parameter BKT with
  weighted observations (hand-computed goldens to 4 decimals); the weights
  table with retry-contamination ordinals 1.0/0.5/0.15 (A1.2), hint rungs,
  capped tutor-inference; exponential decay toward the prior with
  volume-scaled half-life; the deterministic refold — byte-identical replay
  (R-22), LINEAGE-AWARE (split parents redistribute to children at the
  recorded 0.75 factor, merges map to survivors, chains resolve, retired ids
  never error — AC-T1.7b closed). learner_mastery under the strict regime
  (one own-rows select policy; service-role writer).
- **Graph-aware queries + materialization:** weakest_nodes / root_cause
  (deepest below-threshold ancestor) / review_queue (decay-gap × downstream
  leverage) as pure golden-mirrored TS, materialized nightly
  (tutor-mastery-nightly, 04:00) into result tables; my_review_queue
  (learner-own, titled) + concept_mastery_aggregate (author-gated, cohort
  floor 5 INSIDE the SQL — below floor: suppressed with every value AND the
  count null; TS mirror drift-guarded). On-demand
  tutor/mastery.refold.requested handled now, emitted by Wave 3.
- **Student home:** "Worth a review" consumes the learner's mastery queue
  when rows exist (concept titles + below-mastery reasons) and falls back to
  the legacy heuristic on cold start; server-side data swap, zero bundle
  impact; verify:portal untouched-green.
- **Fixture cohort:** six scripted learners (strong / upstream-gap / decayed
  / retry-heavy / two average) on a deterministic 10-node graph, crossing
  the cohort floor, goldens documented in the seeder.
- **Tests:** verify:tutor now chains EIGHT pure suites — 493 checks
  (48+36+70+83+63+70+77+46); verify:tutor:int adds evidence (int) +
  mastery-cohort (47) live; verify-mastery-home-browser drives the real UI.
  Refold perf on the cohort: 6 learners / 26 evidence items / 16.0s
  (network-bound per-learner round-trips; linear in learners).

## TUTOR-1 Wave 1 — concept graph subsystem (extraction · review rail · reconciliation), 2026-08-03

The first wave of the Learner Tutor Agent: the course's knowledge model, built
per the Wave 1 Execution Order (D-1 Branch A — Inngest). Full docs:
`docs/tutor/concept-graph.md` + `docs/tutor/architecture.md`; delta note:
`TUTOR-1-w1-delta-note.md`; checkpoint: `TUTOR-1-wave1-checkpoint.md`.

- **Foundations (W1.1):** `TUTOR_MODELS` job registry (terra/luna/embedding;
  gpt-5.6-sol DENY-LISTED at load + grep-guarded), pricing + pure
  `computeCostUsd`, `ModelClient.embed`, the D-3 chaining seam
  (previousResponseId/store/responseId — dead until Wave 3), and
  `tutor_model_call` cost telemetry on the ONE analytics pipeline (migration
  `20260803100000`; R-9: per-call rows invisible to every client role, the
  select policy excludes `tutor_%`; aggregate spend via the service-role-only
  `tutor_model_costs_daily` view). Live smoke green (real terra call +
  1536-dim embeddings).
- **Graph tables + write gate (W1.2, migration `20260803100100`):**
  concept_nodes/edges, snapshot_concept_map (R-13 anchors + downgrade flag),
  assumed_prior_nodes, tutor_course_settings, tutor_action ledger. THE DAG
  INVARIANT LIVES AT THE WRITE PATH: concept_edges has no client
  insert/update policy — every edge write rides the
  `tutor_upsert_concept_edge` definer RPC (per-kind WITH RECURSIVE cycle
  check, advisory-lock vs concurrent-writer TOCTOU, version discipline,
  typed errors). Versioned node updates (the social idiom) + byte-for-byte
  ledger reverts, fail-closed past the window.
- **Rail extension (W1.2, migration `20260803100200`):** change_set_items
  gains node_type 'concept_graph'; `rejectChangeSet` DOMAIN-PARTITIONED —
  both plans computed before any write, one bad item aborts everything, a
  graph-only reject NEVER loads the course doc; graph restores ride
  `lib/tutor/railRestore.ts` (edges through the cycle gate, so a revert can
  never install a cycle). The rail is extended, never weakened.
- **Extraction (W1.3):** chunk (snapshot-sourced; quiz STEMS only — snapshots
  are answer-stripped by construction) → per-lesson Terra proposals under a
  call budget (exhaustion checkpoints honestly) → grain band 1–4/lesson with
  out-of-band FLAGS → canonicalize (exact pre-merge → one batched embed →
  cosine clusters → merge adjudication) → R-13 anchor resolution → edge
  inference → prune-evidenceless / drop-low-confidence /
  break-cycles-drop-weakest / transitive-reduction → assumed priors →
  persist-rows-first, then ONE change-set + the agent_findings fate row.
  Accept activates; Reject deletes every staged row and leaves the course
  doc byte-identical. Inngest `tutor-graph-extract` (1/course concurrency;
  runs recorded + settled in agent_runs). Execution surfaced two real bugs
  (assumed-priors double-persisted; retry-unstable cost-telemetry ids) —
  fixed.
- **Publish seam + reconciliation (W1.4):** publishing enqueues extraction
  (no graph) / reconciliation (active graph) / nothing (pending review);
  the identical-hash republish path returns before the hook.
  `runGraphReconciliation` classifies every candidate — matched (ID KEPT) ·
  added · removed (retired, never deleted) · split/merged with full lineage
  {parent→children + the configured 0.75 confidence factor} in the item
  payloads (AC-T1.7a — Wave 2's mastery redistribution consumes exactly
  this); creator_locked edges and creator_edited nodes are suppressed from
  the diff (flagged when their content vanished, never auto-changed).
- **Tests:** `verify:tutor` = 300 pure (models 48 · telemetry 36 · graph 70 ·
  extraction 83 · reconcile 63, in the `npm test` chain) + `verify:reject`
  chains the 45-check rail suite; `verify:tutor:int` = 83 vs live Supabase
  (graph 14 · extraction 33 · reconcile 36) — the cycle gate, the full RLS
  matrix, byte-for-byte reverts, AC-T1.3–T1.8 + AC-W1M.1/2. LIVE extraction
  smoke over the 12-lesson Microeconomics fixture: 36 nodes / 38 edges
  (40 pre-reduction), zero grain flags, $0.0988 — and the cost-event rollup
  reconciles the run total EXACTLY.

All notable editor changes, newest first. Each batch is individually
verifiable; verification = `npm run build` + `npm run lint` + a temporary
Playwright script driving the real UI through its `data-ai-*` attributes.
Part C = the approved AUDIT.md items (all except #1 persistence — Supabase
is next — #5 multi-selection styling, and #8 canvas a11y).

## PERF-1 Phases D+E — rendering, bundles, RUM, CI guardrails, 2026-07-23

Closes the wave (checkpoint report: `docs/perf/PERF-1_checkpoint3.md`; local
repro: `docs/perf/README.md`). All five route JS budgets now PASS
(`npm run verify:budgets` — dashboard 174/250 · studio 544/550 [renegotiated
in-map with the chunk decomposition] · learn 212/250 · analytics 172/250 ·
marketing 250/300, gzip wire, load-bounded) and Lighthouse image/stability
assertions are 40/40 (`verify:budgets:lh`).

- **D1:** the learner route no longer imports the editor — `SlideView`
  read-only renderer + zod-free registry split (`structuredLayoutsCore` /
  `layoutRegistry`), source-graph-proven; studio's modal subsystems all
  `next/dynamic` (recorder/publish/plan/image-dialog/agent-panel,
  transcript-preserving latches); framer-motion out of every hot route
  (ConfirmDialog + CourseReview CSS transitions); supabase-js out of the
  shell (SignOutButton → server action) and lazy at the identity band,
  settings, and homework block; **the zod core out of every non-editor
  route** via zod-free splits (`lib/analytics/eventConstants`,
  `lib/learn/reviewsShared`, `lib/profile/limits`) — the RUM reporter had
  been dragging the full zod contract into every page.
- **D2:** dependency-free `lib/perf/virtualRows.ts` (26 checks, scroll
  restoration) on DraftList (+ comms API bounded 200) and the studio
  filmstrip; PostQueue memoized; server tables get `content-visibility`
  containment (per-row is spec-impossible in `<table>`; documented).
- **D3:** `next/image` pipeline (remotePatterns Supabase+Mux, AVIF/WebP)
  across covers/avatars/cards/landing-LCP (+`priority`/`fetchPriority`);
  ONE `SlideImage` for all slide surfaces (allowlist mirror + blob/data
  fallback); `uses-responsive-images` 0.5 → 1.0 on every route.
- **D4:** Fraunces italic dropped (~29 KB off every route's preload).
- **D5 (proven fixes only):** editor whole-doc subscriptions →
  getState()/per-element selectors; rAF-coalesced pointermove (exact
  pointerup flush); filmstrip windowed + lint scoped; agent SSE per-frame
  delta batching + memoized bubbles + incremental markdown (fuzzed ×873
  states) + the defeated doc-walk memo fixed.
- **E1/E2:** `perf_vital` in the ONE analytics contract + ingest RPC
  (NULL-course envelope, CHECK-scoped columns, idempotent; forged-uid test
  live — `verify:analytics:int` 104), `web-vitals` reporter in the root
  layout (sampling env; dep-freeze exception is directive-mandated),
  `perf_vitals_daily` P50/75/95 view with alerts-not-gates thresholds.
- **E3:** the repo's FIRST CI — `.github/workflows/perf.yml` (build →
  verify:perf → budgets → Lighthouse) + `test.yml` (the 32-suite pure
  chain); budget gate + LH gate self-provision their fixtures (CI-portable);
  deliberate-regression demonstration captured in README then reverted.
- Final lab (desktop): TTFB 538–886 ms (was 919–2664), LCP 0.9–1.2 s (was
  2.5–6.6); mobile LH scores 78–85 (was 69–76), TBT ≤31 ms. Gates:
  `npm test` 32 suites · `verify:perf:rt` 20 · `verify:perf:browser` 39+2.

## PERF-1 Phases B+C — perceived performance + data layer, 2026-07-17

Diagnosis (Phase A) lives in `docs/perf/PERF-1_diagnosis.md`; caching rules in
`docs/perf/caching-policy.md`. Every §2 CI target failed at baseline (mobile
LCP 5.2–7.4 s, TTFB all > 800 ms, 13–28 server round trips per view, route JS
391–639 KB gz). This wave = do-less-work + do-work-earlier + honest feedback.

- **Auth tax collapsed (C1):** `getSessionUser` = `react cache()`d
  `auth.getUser()` (`lib/supabase/server.ts`) — one network auth call per
  render pass (was 3–4); `createClient` is a per-request singleton;
  `getSessionProfile` (`lib/supabase/sessionProfile.ts`) kills the duplicate
  layout/page profile reads. Middleware no longer runs on `/api/*` (every
  handler self-authenticates) and short-circuits with ZERO auth round trips
  for anonymous visitors on public pages. 41 files swept.
- **One bundle RPC per hot route (C1):** `creator_dashboard()`,
  `studio_course_bundle()`, `learn_lesson_state()`,
  `course_analytics_bundle()` + `learner_detail_bundle()`,
  `marketing_hub_bundle()` — SECURITY DEFINER, STABLE, auth pinned inside,
  Zod-parsed via `lib/supabase/rpcJson.ts`, loaders take the client as a
  parameter (counting-client testable, AC-PERF-07). Warm views: **1–2 data
  round trips** (were 10–24). Counts moved into SQL GROUP BYs (enrollments,
  sequences overview, findings); `learner_messages` latest-per-user via
  DISTINCT ON; learner-detail timeline switched offset→keyset (`?before=`);
  quiz attempts capped at 25 (+ exact `attempt_count`); marketing hub
  approvals/questions bounded to 20; approval previews now STREAM behind the
  shell (React `use()` + per-card Suspense) instead of blocking first paint.
- **Immutable snapshot cache (B5/C1):** `lib/learn/publicationCache.ts` —
  narrow RLS-scoped meta resolve (authorization never cached) + the
  DB-trigger-immutable body in the Next data cache keyed by publication id
  (`revalidate: false` is provably correct) + a bounded parsed-Zod memo. The
  full-snapshot fetch+parse that ran on every lesson view, every
  progress/quiz/homework POST, every analytics tab, and the student home is
  now 0 round trips warm. Imported-deck views moved off the lesson SSR
  critical path (lazy client fetch).
- **DB layer (C3, applied live):** hot SELECT policies rewritten from per-row
  `private.can_read_course(course_id)` calls to per-statement hashed
  semi-joins (blocks/lessons/modules/analytics_event/learning_events/
  change_set*/conversations/messages; EXPLAIN before→after: per-row filter,
  190 buffers → hashed SubPlan, 7 buffers); `course_reviews`' two permissive
  SELECTs merged; 37 FK/functional indexes added (incl.
  `course_publications(published_at) WHERE live+public`, social queue
  `(creator_id, updated_at)`, revision-budget + heartbeat covers), 6
  redundant prefix indexes dropped; `course_publications.lesson_count/
  module_count` persisted at publish (immutability-trigger-guarded,
  backfilled) so `marketplace_listings()`/`my_learning()`/
  `is_review_eligible` stop re-expanding snapshot jsonb per row;
  `social_post.regenerated_from_post_id` drift reconciled into migrations.
  `verify:publish:int` (50) + `verify:learn:int` (61) green post-swap.
- **Perceived performance (B):** honest `NavProgress` top bar (starts ≤100 ms
  on nav intent, trickles asymptotically, completes only on real route
  change; never a fake timer) + `IntentLink` hover/focus/touch full-route
  prefetch (80 ms debounce, ≤3 concurrent, 30 s TTL —
  `lib/perf/intentPrefetch.ts`) + `staleTimes {dynamic:30}` making the Router
  Cache the client data cache + preconnects to Supabase/Mux origins. All
  eight route skeletons geometry-matched to their real layouts (B2).
  Optimistic UI with tested rollback (B3): change-set Accept (instant
  pending-clear, snapshot-restore on failure), Reject ("reverting" chrome —
  doc revert stays server-authoritative; `suspendAutosaveForReject` ordering
  preserved), learner review submit/dismiss, settings portal radio
  (`lib/perf/optimistic.ts` machines). B6 View Transitions: N/A — stable
  React 19.2.4 ships no ViewTransition (evidence in the checkpoint report).
- **Assets (C4/C5):** `cacheControl: 31536000` on all five storage upload
  sites (UUID-immutable objects; was 1 h default); slide lookahead warms
  slides N+1/N+2 images (≤2 concurrent, saveData/2g-gated, session-deduped —
  `lib/learn/lookahead.ts`); learn-landing LCP cover `fetchPriority="high"`.
- **Also:** `PostEditor.tsx` un-binaried (raw NUL → `\u0000` escape).
- **Tests:** `verify:perf` (26 intent + 35 optimistic + 26 lookahead, in the
  `npm test` chain — 27 suites green), `verify:perf:browser` +
  `verify-perf-rt.ts` (AC-PERF-02..10), five per-RPC live smoke suites
  (25+19+21+50+12 checks) run at migration time.

## Dashboard creator identity band (edit-in-place), 2026-07-11 (follow-up)

The "about the author" editor moved to the TOP of `/dashboard`:
`components/dashboard/CreatorIdentityHeader.tsx` replaces the plain
PageHeader in BOTH branches (has-courses + zero-course onboarding). Avatar
uploads save IMMEDIATELY (hover the photo → Change; upload → avatar-only row
update → previous object removed; a failed row update removes the upload);
"Edit profile" swaps the text block for an inline name/headline/bio form with
counters; missing pieces render as dashed ghost prompts (the band IS the
completion nudge — the AttentionRail profile row and the OnboardingHero
settings link were removed as redundant). Pre-migration a headline/bio save
keeps the editor OPEN with the amber unlock notice (closing would display
text that never persisted). Persistence extracted into
`lib/profile/clientProfile.ts` (`uploadAvatarImage` / `saveProfileFields` /
`saveAvatarUrl` / `removeCourseAsset` / `isMissingColumnError`) — ONE
implementation shared with Settings' ProfileSettings (refactored to consume
it; behavior byte-identical) so the two surfaces can't drift. Adversarially reviewed (5
confirmed findings, all fixed): avatar-pick vs in-flight-save interlock (a
stale text save could persist a deleted avatar URL — the photo button now
guards `saving` too), the raw display_name is edited instead of the derived
email-prefix fallback (a fallback must never be silently persisted into
world-readable profiles — blank field forces an explicit name; /settings got
the same fix), a name-only pre-migration save now closes + flashes (the
unlock notice only shows when TYPED headline/bio failed to persist — both
surfaces), flash timers are ref-held/cleared, and errors/upload progress are
announced (role="alert" + sr-only status; the photo buttons use aria-disabled
+ guard so keyboard focus survives the file dialog). Suite:
verify-portal-browser section 9b (band renders, photo affordance,
edit-in-place save in both migration modes) — 39 checks total.

## Course covers + creator identity + landing redesign, 2026-07-11

Courses got real cover images, creators got a public identity (avatar +
headline + bio + card-safe stats), and the public `/learn/[slug]` landing was
redesigned into a proper conversion page. Full architecture doc:
`docs/creator-identity.md`.

- **Schema** (migration `20260711000000_course_covers_creator_identity.sql` —
  ⚠ written 2026-07-11; APPLIED to the live DB 2026-07-14 along with
  `20260708000000_user_roles_portal.sql`; apply IN ORDER; every consumer
  degrades gracefully until both land): `courses.cover_image_url`
  (live-mutable CARD metadata, deliberately never snapshotted — the M2 rule,
  so a creator can refresh the cover without republishing);
  `profiles.headline`/`profiles.bio` (CHECK caps 120/2000 mirroring
  `lib/profile/schema.ts`; `avatar_url` existed since the core schema —
  profiles is world-readable, so all three are PUBLIC by design);
  **`course_landing_extras(p_course_id)`** definer RPC (anon+authenticated;
  zero rows unless a live publication exists — unpublish hides the sections;
  returns cover + creator card fields + card-safe AGGREGATES only: distinct
  learners across ALL the creator's courses, live course count, review count,
  review-count-weighted avg rating, plus per-course student/review stats —
  never emails, never review bodies, never enrollment rows); `my_learning()`
  v3 + `marketplace_listings()` v3 with cover/creator columns APPENDED (never
  reordered). Types hand-spliced into `lib/database.types.ts`.
- **Pure libs**: `lib/images/resize.ts` (`fitWithin` never-upscale ·
  `centerCrop` · `extForMime` — jpeg/png/webp ONLY, SVG rejected as an XSS
  vector on a public bucket, GIF rejected [canvas would flatten it] ·
  `coverStoragePath` `{uid}/covers/{courseId}/{id}.{ext}` +
  `avatarStoragePath` `{uid}/avatar/{id}.{ext}` — uid FIRST, so the EXISTING
  per-user `course-assets` storage policies are the write gate; no new
  policies) · `lib/images/clientResize.ts` (canvas downscale, square
  center-crop for avatars, falls back to the ORIGINAL bytes on any decode/
  canvas failure) · `lib/profile/schema.ts` (`PROFILE_LIMITS` 80/120/2000,
  `CreatorProfileFormSchema`, `profileCompleteness` — blank strings count as
  missing) · `lib/learn/courseIncludes.ts` (`summarizeCourseContents` +
  `courseIncludesItems` computed from the publication SNAPSHOT, never draft
  rows — the numbers always match what a learner receives) ·
  `lib/learn/landingExtras.ts` (`fetchCourseLandingExtras` → null on ANY
  error/zero-rows/parse failure; the landing never 500s over an optional
  read).
- **UI primitives**: Card variants (`default`/`elevated`/`interactive`/
  `tinted` + tone), Button size `lg` + hover lift + per-variant focus rings,
  PageHeader eyebrow/tone + bigger serif title, Stat icon/tone chips;
  globals.css utilities `.font-display`/`.eyebrow`/`.paper-glow`
  (`--glow-color`)/`.grain` — ⚠ Tailwind v4 dev server must RESTART to emit
  newly added custom utilities (prod builds fine).
- **`/learn/[slug]` landing redesign**: warm glow hero, serif 5xl title, meta
  chips (+ learner count and rating when extras are present), "Created by"
  row linking `#instructor`; sticky elevated conversion card with an
  aspect-video cover (uploaded image, else the deterministic `CoverArt`
  gradient+initial fallback — `components/learn/CoverArt.tsx`, keyed off the
  course id, hydration-safe) — the 4 CTA states preserved ("Your progress"
  literal kept for the browser suite); "This course includes" derived list;
  "What you'll learn" = the plan's real `outcomes` as a checklist in a tinted
  card + prerequisites footnote; restyled `CourseOutline` (number medallions,
  sans titles, per-lesson type icon chips via `primaryType`, open-state ring,
  Expand/Collapse all); instructor section (`#instructor`: eyebrow + serif
  name + `InstructorCard` w/ avatar, headline, stats, clamped bio + Show
  more); `CourseReviewSection` eyebrow → brand-700; `generateMetadata` w/ OG
  cover image, deduped against the page render via react `cache()`; learn
  layout header widened to max-w-6xl; reshaped `loading.tsx`.
- **Covers on every card**: `CourseCards.tsx` media zones (ListingCard
  aspect-video, MyLearningCard aspect-[2/1]; title moved into the body;
  creator avatar row; CTA fills on hover; 7 accent gradients),
  CourseHealthCard cover thumb, CourseCardItem gallery cover, analytics
  course-picker cover thumb. Direct `courses` selects that name the new
  column retry WITHOUT it pre-migration (dashboard, analytics picker).
- **Settings is REAL** (was a `lib/data.ts` placeholder):
  `app/(app)/settings/page.tsx` + `components/settings/ProfileSettings.tsx`
  (avatar upload → client downscale → `course-assets` under the caller's own
  `{uid}/avatar/…` → `profiles.avatar_url`; display name/headline/bio with
  live counters + zod; PGRST204 missing-column retry + an amber "unlocks once
  the migration is applied" notice; live "How learners see you" preview;
  `data-ai-tool="settings-profile-form"`/`"settings-save"`) + `AccountCard`
  (email, plan badge, default-portal radio writing `profiles.role`). New
  **CoverImageCard** on the publish panel (16:9 preview, upload/replace/
  remove, saves immediately — the cover is NOT part of the snapshot; locked
  state pre-migration; a failed row update rolls the just-uploaded object
  back; `data-ai-tool="course-cover-upload"`/`"course-cover-input"`).
- **Polish**: login glow + elevated card; student home (learn paper-glow,
  eyebrow, continue-hero cover strip/wash + watermark, colored stat chips,
  two-tier section headings); explore/my-courses headers + learn-gradient
  active filter chips; dashboard (brand glow, Stat icons, brand eyebrows,
  AttentionRail "Complete your creator profile" row via
  `profileCompleteness`, OnboardingHero nudge); lesson page meta eyebrow
  above the h1; LearnLessonView sticky bar bg-white/90 + learn-tinted
  objective callout.
- **Tests**: new `npm run verify:identity`
  (`scripts/verify-creator-identity.ts`, 90 pure checks — sizing math,
  storage paths, mime gate, profile schema/completeness, includes summary,
  landing-extras degradation contract) chained into `npm test`. Browser
  suites pass in BOTH modes (pre-migration degraded + post-migration).

## Portal split + UI redesign (student portal · creator dashboard · agent UX · perf), 2026-07-08

Large-scale UX overhaul splitting the product into a **student portal** and a
**creator portal** with role-aware routing, plus a real-data creator dashboard,
learn-experience polish, an editor-agent chat overhaul, and a perceived-perf
pass. Full architecture doc: `docs/portal-split.md`.

- **Roles** (migration `20260708000000_user_roles_portal.sql` — ⚠ written but
  applied to the live project on 2026-07-14; all consumers degrade gracefully until
  it is): `profiles.role` ('creator'|'learner', a routing PREFERENCE not a
  security boundary), `private.handle_new_user` now stamps role from signup
  metadata AND fixes the display_name key mismatch ('display_name' vs
  'name'/'full_name' — every signup name was silently dropped before) +
  backfills; `my_activity_days()` definer RPC (streaks — the sanctioned
  learner read over author-only `learning_events`); `my_learning()` v2
  (lateral pub join: unpublished courses no longer vanish — new `is_live`
  flag; + `avg_rating`/`review_count`); `marketplace_listings()` v2 (rating
  fields). `lib/database.types.ts` spliced by hand.
- **Auth**: signup gained an "I'm here to learn / to teach" role picker
  (default inferred from `redirectTo`); sign-in with no `redirectTo` routes by
  role (learner → `/home`, creator → `/dashboard`).
- **Student portal** `app/(student)/` (`/home`, `/my-courses`, `/explore`) with
  its own editor-free shell (`components/shell/StudentSidebar.tsx`) and a new
  first-class **learn-blue accent ramp** (`--color-learn-*` + `.learn-gradient`
  in globals.css; Badge tone `learn`, Button variant `learn`,
  `components/ui/ProgressBar`). Home = continue-hero (snapshot +
  `buildCourseProgressSummary`, null continue = course done), streak/lessons/
  accuracy/in-progress stat band, my-courses grid, worst-first quiz review
  queue + homework-awaiting-review, and an explicitly-labeled offline **AI
  Tutor preview** chat (`components/student/TutorPanel.tsx`). Pure helpers in
  `lib/learn/studentHome.ts`. Portal switchers live in both sidebars; the
  middleware PROTECTED regex covers the new prefixes.
- **Creator dashboard** `/dashboard` rebuilt on real data (was lib/data.ts
  mock): one batched `.in(courseIds)` load (live pubs, enrollments, review
  rollups, open agent_findings, draft learner_messages) + spotlight-course
  funnel from `rollup_lesson_funnel`; honest empty states; revenue is an
  explicit coming-soon card (no fake numbers). Pure math in
  `lib/analytics/creatorHome.ts`. Course cards deep-link `/studio?course={id}`
  (the old page's bare `/studio` bug) and `/studio/{id}/analytics`.
- **Marketplace/Explore share one card set** (`components/learn/CourseCards.tsx`
  — MyLearningCard/ListingCard/StarRating/accentFor; `data-ai-tool`
  anchor kept); `is_live === false` renders an unlinked "No longer available"
  card.
- **Learn polish**: course landing outline → collapsible module accordions with
  per-module progress (`CourseOutline.tsx`); lesson blocks got type-identity
  icon chips + collapsible TEXT blocks (content stays MOUNTED — dwell/track
  lifecycles untouched); `CompletionChecklist` derives "what's left" from the
  server's own `lessonTrackables`; `LessonCelebration` animates on in-session
  completion with a Next-up CTA; sticky micro-progress pill; quiz perfect-score
  flourish. All `data-ai-tool` anchors preserved (browser suite compatible).
- **Editor agent chat UX** (client-side only, wire protocol untouched): fixed
  the lying spinner (mid-run `assistant_message` no longer ends the turn;
  `done` is the one terminal) and silently-dropped narration (new bubble when
  the last one settled); humanized `StatusStrip` (phase + streamed `detail` +
  running-tool label + 8s-silence heartbeat); complete 41-tool friendly-label
  registry `lib/ai/toolLabels.ts` with a drift-guard test; checkpoints have a
  Continue button, errors a Try-again; the plan modal survives Escape/backdrop
  (explicit Discard only); markdown-lite rendering in assistant bubbles.
  Marketing AgentPanel got 4 minimal render-only polish touches (commented
  `UI polish (2026-07-08)` for the parallel workstream).
- **Perf**: 9 route-shaped `loading.tsx` skeletons + per-group `error.tsx`
  (there were ZERO before), parallelized fetch waves (creator analytics page
  ~5→2 round trips; marketplace; learn pages), lazy-loaded shiki
  (`lib/course/slide/highlight.ts`), `next/dynamic` ReviewSlideIn.
- **Tests**: new `npm run verify:portal` (student-home 35 + creator-home 42 +
  agent-ux 89 = 166 pure checks) chained into `npm test` — full chain
  **1,297 passed / 0 failed**; build + lint green; verify:learn / verify:slides
  / verify:reject / verify:marketing:sync re-ran green after the touches.

## Learner-comms send resilience (retry + idempotency), 2026-07-07

A live send from the Stuck queue failed with an opaque "provider error" — the
row's stored error was just `fetch failed`: ONE transient transport drop (dev
machine behind a system proxy; Node's fetch connects directly and flickers)
permanently parked the message in `failed`, because the comms provider had
zero retries and the composer discarded the route's `detail`.

- **Provider retries** (`lib/comms/resendProvider.ts`): transport errors and
  429/5xx retry up to 3 attempts with 500ms/1500ms backoff; non-429 4xx (our
  request's fault — unverified domain, bad recipient) surface immediately,
  never retried. Injectable `fetchImpl`/`sleep` for pure tests.
- **Idempotency** (`types.ts` + `service.ts`): every send carries Resend's
  `Idempotency-Key` = the learner_messages id, so a retry after a LOST
  RESPONSE (or the author re-sending a failed row whose first attempt
  actually landed) can never double-send.
- **Actionable errors**: `describeTransportError` unwraps undici's buried
  `cause` (`fetch failed (ECONNRESET)` instead of `fetch failed`); the
  composer now shows the route's `detail` for provider errors instead of the
  bare reason code.
- **Tests**: 6 new checks in `verify:comms` (67 total) — retry-then-succeed,
  3-attempt exhaustion with the descriptive message, 5xx retry, 4xx
  never-retried, Idempotency-Key on every attempt, cause unwrapping.
  `verify:comms:int` re-ran green (46).

## Granular slide feedback (M10), 2026-07-07

Fourth milestone of the Engagement & Retention wave: a low-friction per-slide
reaction (👍 helpful / 👎 confusing + optional capped note) that rides the
EXISTING analytics pipeline end to end — the 10th learner event type in the
one Zod contract, the same batching client SDK, the same ingest RPC with
server-pinned user_id, zero new pipeline. Migration
`20260707030000_slide_feedback.sql`.

- **Contract** (`lib/analytics/events.ts`): `slide_feedback` = envelope +
  `blockId`/`slideId` + `reaction` enum + `comment` (≤500,
  `FEEDBACK_COMMENT_MAX_CHARS`, nullable — empty string rejected). Client-
  reportable (in `ClientBatchEventSchema`); mapped to real `reaction`/
  `feedback_comment` columns (the M3 typed-extras convention, both DB-CHECKed)
  by the recreated ingest RPC. **Idempotency contract:** append-only — a
  toggle emits a NEW event; **latest reaction wins per (user, slide)** is
  enforced in the rollup (`distinct on … server_ts desc`), never by mutating
  the log.
- **Rollup** `rollup_content_feedback` (per slide + per lesson — slide_id
  null = the lesson row summing its slides' per-(user,slide) latest
  reactions): distinct-learner helpful/confusing counts, `confusing_pct`
  (raw stat in SQL; the FLAG lives in TS — `feedbackOutlier`, ratio ≥ 0.4 at
  n ≥ 3, the questionFlags/dwellOutlier pattern), and a newest-first sample
  of non-null comments from the LATEST set (5/slide, 8/lesson — a superseded
  toggle's comment drops out, latest wins uniformly). Recomputed by
  `private.recompute_content_feedback`, wired into the two small refresh
  wrappers (nightly + manual; the big recompute stays unrestated).
- **Learner UI** (`LearnSlideDeck`): a thumbs pair under the deck reflecting
  the learner's CURRENT reaction (seeded by the narrow `my_slide_feedback`
  definer RPC — the caller's OWN latest reactions only; students still read
  no learning_events rows) so it reads as a toggle; the note field reveals
  only on tap-to-elaborate (a comment always rides a reaction) and sends
  through the same `track()` batching path. Author previews render nothing
  (`feedbackEnabled` = students only; `track()` is a no-op there anyway).
- **Dashboard — no separate tab**: the Content health tab's dwell-outliers
  card became the unified **"Slide health"** table — dwell outliers JOINED
  with per-slide feedback (one row set: views, median dwell, 👍, 👎, Skimmed/
  Stall/Confusing chips, rose-highlighted rows on the confusing flag, recent
  comments inline under each row) — and the Lesson drop-off table gained a
  per-lesson Feedback column. One content-health signal, not three surfaces.
- **Tests:** `verify:analytics` 68→**77** pure (contract accept/reject,
  comment cap + empty-string + bad-reaction, column mapping, feedbackOutlier
  matrix, migration drift guard) · `verify:analytics:int` 79→**89** live
  (ingest through the existing RPC, malformed rows rejected by the DB CHECKs,
  a 3-toggle sequence collapsing to ONE latest reaction per learner, comment
  sampling from the latest set only, lesson-level aggregation, idempotent
  re-run, author-only rollup RLS, own-reactions-only RPC) · full `npm test`
  (23 suites), lint, build green.

## Course reviews — creator-only (M9), 2026-07-07

Third milestone of the Engagement & Retention wave: learners who finish (or
nearly finish) a course rate it 1–5 with optional text; creators read reviews
on the analytics Overview. NO public display — `is_public` exists for a future
wave with no UI/API/query path. Reviews are DIRECT human input (never through
the change-set flow). Migration `20260707020000_course_reviews.sql`.

- **Schema**: `course_reviews` (rating `CHECK between 1 and 5`, nullable text,
  `UNIQUE (course_id, user_id)`, moddatetime `updated_at`) + prompt-dismissal
  state on `enrollments` (`review_dismissed_at`/`review_dismiss_count`) +
  `rollup_course_reviews` (per COURSE: count, avg, 1–5 distribution;
  author-select RLS, zero client writes).
- **Eligibility gated in SQL, twice**: `private.is_review_eligible` =
  enrollment `completed` OR progress ≥ 70% (`sum(learn_progress.pct)` over the
  live snapshot's lesson count — the exact `course_roster` formula; 70 is the
  codebase's existing "almost done" threshold, mirrored as
  `REVIEW_ELIGIBLE_PROGRESS_PCT` and drift-guarded). The gate lives in BOTH
  the `submit_course_review` RPC (upsert semantics — editing is a
  re-submission, never a second row) AND the RLS insert/update policies, so a
  forged direct client insert fails identically. user_id is pinned to
  auth.uid() everywhere; text trimmed + capped at 2000 chars server-side.
- **RPCs** (authenticated-only, anon revoked): `submit_course_review` ·
  `review_prompt_state` (one read: enrolled/eligible/review/dismissals +
  creator name — the pages never recompute eligibility in TS) ·
  `dismiss_review_prompt` (bumps the enrollment's dismissal state).
- **Learner UX** (`components/learn/CourseReview.tsx`): a **non-blocking
  slide-in card** (never a modal) on the lesson player near completion —
  1–5 stars are the only required input (accessible radiogroup, large
  targets); the comment box appears only AFTER a rating (progressive
  disclosure); submit REPLACES the form in place with a confirmation
  ("Thanks — this goes straight to {creator}", rating reflected back, edit
  link). "Maybe later" persists server-side; the pure
  `shouldShowReviewPrompt` (lib/learn/reviews.ts) re-surfaces after a 7-day
  gap, capped at 3 total asks — the decision runs in the slide-in's mount
  effect (react-hooks/purity bans Date.now() in render, including server
  components). The course landing gets a persistent "Your review" section:
  view + Edit (pre-populated) or a quiet inline form while
  eligible-and-unreviewed (learner-initiated space — not gated by the nag
  cap).
- **Creator dashboard**: `ReviewsCard` folded into the analytics Overview —
  average + star row, 1–5 distribution bars, count (from the rollup; "raw
  stats live in SQL"), and recent review text read live under author RLS,
  paginated via `?reviewsPage=` (the learner-detail timeline pattern).
  `refresh_course_analytics` / nightly `refresh_all_course_analytics` now
  also run `private.recompute_course_reviews` (the 20260703 precedent — the
  big recompute is never restated; only the two small wrappers were).
- **Tests:** `verify:analytics` 59→**68** pure (the shouldShow matrix:
  fresh/ineligible/reviewed/gap/re-surface/cap/defensive, prompt-state parse,
  SQL drift guard for eligibility % + rating bounds + text cap) ·
  `verify:analytics:int` 63→**79** live (ineligible rejected by RPC AND
  forged direct insert; the ≥70% PROGRESS branch and the COMPLETED branch
  both submit; rating bounds at RPC and DB CHECK level; upsert = one row +
  bumped updated_at; RLS matrix learner-own/author-all/stranger-none; the
  unenrolled author can't review their own course; rollup count/avg/
  distribution correct + idempotent + author-only; dismissals persist and
  ride the prompt state; anon revoked) · full `npm test` (23 suites), lint,
  build green.

## Inactivity nudge tuning (M8), 2026-07-07

Second milestone of the Engagement & Retention wave — the reduced scope the
Task-0 decision gate produced (the inactivity signal already existed
end-to-end: flag → filed finding → Analyst pickup → `stalled_nudge` template →
approval flow; no new template, `stalled_nudge` IS the check-in nudge).
Migration `20260707010000_inactivity_nudge_tuning.sql`.

- **Threshold 7 → 4 days** (dropout concentrates in week one) and the flag
  **renamed `inactive_7d_incomplete` → `inactive_incomplete`** (at 4 days the
  old name would lie; existing rows migrated, check constraint + TS type +
  `describeLearnerFlag` + dashboard renamed together). The learner-flag
  computation was **extracted into `private.recompute_learner_flags`** so
  future flag tuning never restates the big rollup function again;
  `recompute_course_analytics` 3a–3d are byte-identical.
- **Nudge guards at filing time** (`file_threshold_findings`): learner risks
  are no longer filed for learners who **opted out** of comms, are
  **suppressed** (M7 hard bounce/complaint), or have ANY `learner_messages`
  row for the course within **14 days** (`NUDGE_COOLDOWN_DAYS` — one check-in
  per silence; the old pipeline re-filed a fresh open finding every night once
  a draft flipped the previous one to 'proposed', so the same learner could be
  re-nudged run after run). Deliberate split: the dashboard Stuck queue still
  SHOWS every stuck learner (creator visibility + manual outreach stay
  unrestricted) — only the automatic draft-producing pipeline is guarded.
- **Dedupe-key mismatch fixed** (the Task-0 audit find): SQL filed
  `learner_<flagType>:<userId>` while TS `dedupeKeyForFinding` produces
  `learner_risk:<userId>` — the keys never collided, so Analyst adoption never
  fired for learner risks and one learner could yield several findings/drafts
  in a single run. SQL now files **ONE finding per learner** under the TS key
  (flavors merge; `repeated_quiz_failure`=high outranks inactivity=medium;
  summary clamped ≤480 chars so a filed row can never fail FindingSchema
  parse). Existing OPEN learner_risk rows were collapsed (newest kept, rest
  dismissed) and re-keyed in the migration.
- **Measurement hook (M7 pays off):** the Stuck queue rows now show the last
  check-in's delivery outcome ("Last check-in 3d ago · opened") from
  `learner_messages.delivery_status`, and Draft follow-up is disabled with an
  honest tooltip for suppressed learners (advisory — the send seam re-checks).
  The empty-state copy derives from `INACTIVE_DAYS` (no hardcoded "7+ days").
- **Drift guard retargeted**: the stuck constants' SQL now lives in the M8
  migration — `verify-analytics.ts` asserts THAT file encodes
  `INACTIVE_DAYS=4` / 2 / 0.60 / `NUDGE_COOLDOWN_DAYS=14`, plus the
  learner-risk key format mirror and the presence of all three guards.
- **Tests:** `verify:analytics` 57→**59** pure · `verify:analytics:int`
  55→**63** live (new M8 section: merged-key filing, one-per-learner,
  high-severity flavor precedence, 5-day silence trips the 4-day threshold,
  cooldown blocks → 15-day-old message unblocks, opt-out blocks, suppression
  blocks, guards-lifted refiles) · `verify:maintenance` 35 + `:int` 25 green
  (adoption now exercises the matched keys) · full `npm test` (23 suites),
  lint, build green.

## Learner comms — Resend delivery webhooks + suppression (M7), 2026-07-07

First milestone of the Engagement & Retention wave. Per comms record we now
know delivered / opened / clicked / bounced / complained, and a bad address is
suppressed before it can damage sender reputation. Full architecture + Resend
dashboard setup: `docs/comms-delivery-tracking.md`.

- **Correlation at send time** (`lib/comms/service.ts` + `resendProvider.ts`):
  every learner-comms send carries Resend `tags` (`send_source=learner_comms`,
  `message_id`, `course_id`, `user_id` — `learnerCommsTags`) and seeds
  `learner_messages.delivery_status='sent'` + the `delivery_events` trail.
  `provider_message_id` (already persisted) stays the primary attribution key;
  tags add the send-source filter + the send-race fallback.
- **Shared Svix verifier** (`lib/webhooks/svix.ts`): the marketing route's
  manual HMAC extracted into ONE function used by BOTH Resend webhook routes,
  now WITH the ±5-minute timestamp tolerance (replay protection) the original
  inline copy omitted — a real gap found by the wave's Task-0 audit. Manual
  Node crypto by explicit decision (runtime deps stay at the guarded 14; the
  muxClient precedent).
- **New webhook** `POST /api/comms/webhooks/resend` (own per-endpoint secret
  `RESEND_COMMS_WEBHOOK_SECRET` — Resend webhooks are account-wide, so this
  endpoint and the marketing one each ignore the other's events): raw-body
  read → Svix verify (401) / unset secret (503) → `lib/comms/webhook.ts`
  processing → 200 even for unattributable/foreign events (Svix must never
  retry-storm), 500 only on infrastructure failure (we WANT that retry).
- **Event contract extended in place** (`lib/analytics/events.ts`): five
  `comms_email_*` types in the SAME discriminated union / `learning_events`
  table, with a course-only envelope (publication/version/lesson NULL — a DB
  check keeps the full envelope mandatory for every learner type). Idempotency
  = `client_event_id` DERIVED from the retry-stable `svix-id`
  (`uuidFromSvixId`). The CLIENT batch schema composes only the learner nine —
  a comms event 400s at ingest, the ingest RPC independently rejects it, and
  the learner is attributed from the `learner_messages` ROW, never a tag
  (forged `user_id` tags are ignored). `emitCommsDeliveryEvent` reports
  inserted/duplicate/error (delivery events must not be silently dropped).
- **Atomic trail** (`public.apply_comms_delivery`, service-role-only RPC):
  `FOR UPDATE` lock; `delivery_status` climbs a rank ladder (none→sent→
  delivered→opened→clicked→bounced→complained) so out-of-order/concurrent
  webhooks never downgrade; trail entries dedupe by `svixId`, cap 50.
  `email.sent`/`email.delivery_delayed` are trail-only notes (no event minted
  — taxonomy stays clean). Side effects re-run on duplicate deliveries
  (idempotent) so a retry after a partial failure self-heals.
- **Suppression** (`comms_suppressions`, per-user, RLS-on ZERO policies — the
  quiz_answer_keys precedent): hard bounce (`Permanent` only; `Transient`/
  `Undetermined` never suppress) or complaint upserts it; `approveAndSend`
  re-checks AT SEND TIME → `{ok:false, reason:"suppressed"}`, row stays draft.
  UI: DraftList rows show delivery chips + a "suppressed: bounced/complained"
  badge (suppression map rides the author-gated GET /api/comms/messages);
  MessageComposer replaces Approve-&-send with the suppressed notice; the
  learner-detail Messages list shows delivery status; the activity timeline
  labels the five comms events (null-lesson safe).
- **Migration** `20260707000000_comms_delivery_tracking.sql` (+ types regen —
  which also picked up the live `social_post*` tables missing from the
  committed types).
- **Tests:** `verify:comms` 27→**61** pure (Svix verifier incl. tamper/replay/
  tolerance-boundary, event mapping incl. bounce taxonomy + url cap, uuid
  determinism, tag parsing both shapes + composition charset, contract
  extension + batch rejection + column mapping) · `verify:comms:int` 20→**46**
  live (webhook end-to-end: happy path, duplicate-svix-id-exactly-once,
  rank-monotone out-of-order, trail-only email.sent, author-reads/learner-
  reads-none RLS, soft-vs-hard bounce, suppression blocks the send seam,
  complaint, unattributable/foreign ignored, send-race tag fallback, forged
  user_id tag ignored, ingest-RPC + direct-RLS + delivery-RPC forgery surface).
  Full regression green: `npm test` (every pure suite), `verify:analytics`
  57 + `:int` 55, `verify:learn:int` 61, `verify:maintenance` 35 + `:int` 25,
  lint, build.
## Marketing Phase 1.5 M-A — Lesson Clip Repurposing: transcripts + moment engine, 2026-07-07

Milestone M-A of the clips PRD (guide: `docs/clips.md`). Creators (and the
agent) can now turn a lesson recording into ranked, validated clip-moment
CANDIDATES; rendering (Reap) lands in M-B, which is **gated on Task 0** — the
live smoke test is ready (`npm run smoke:reap` + `docs/reap-task0-findings.md`)
but **BLOCKED on `REAP_API_KEY`** (absent from `.env.local`).

- **Transcript acquisition** (`lib/marketing/clips/transcripts.ts`): cache
  (`lesson_transcript`, one row per lesson) → platform (Mux
  `video_assets.transcript_vtt` → length-weighted word interpolation inside
  each cue) → the injectable `TranscriptionProvider` seam (Reap fills it in
  M-B; a mock proves the path). Second request = zero provider calls.
- **Moment selection engine** (`selection.ts`): ONE mid-tier structured call
  (sequential small-tier map→reduce when the transcript exceeds
  `CLIP_TRANSCRIPT_MAX_TOKENS`) → Zod gate + exactly ONE repair (Phase 1
  semantics; deterministic flags can claim it, a rubric-only failure never
  wastes it) → deterministic checks (`validate.ts`: bounds, 20-90s,
  platform-cap pruning, §8.3 rubric bar, ≤20% overlap, numeric hook claims,
  caption clamp, the SHARED §17.2 safety lint via the new
  `social/lint.lintFreeText`) → the ONE small-tier validation call
  (standalone-coherence w/ ±8s adjust-or-drop [multi-segment NEVER adjusted]
  + hook integrity w/ first-supported-hook promotion) → persist + events.
  **`runSelectionCore` is DB-free and shared VERBATIM with the eval harness.**
  Selection is model-REQUIRED (typed 503); fail = typed error, NOTHING
  persisted, parameters kept.
- **Course-graph grounding** (`context.ts`): reuses the Phase 1 context
  assembler + a QUIZ-MISS section (`rollup_question_stats` filtered to the
  lesson, joined to draft quiz wording via the node-id invariant) — the
  vertical moat input generic tools can't have. Slide-sync input documented
  absent (no slide↔video alignment exists on this platform).
- **Versioned prompts** (`prompt.ts` + `fixtures/exemplars.ts`):
  `CLIP_PROMPT_VERSION` stamped on every candidate; byte-stable static prefix
  (role · §8.2 taxonomy · §8.3 rubric · §8.4 hook formulas · §8.5
  `CLIP_PLATFORM_SPECS` pacing · §8.6 negative constraints · 6 repo-fixture
  exemplars). **The eval harness immediately earned its keep:** clips-v1's
  live run scored 1 viable / 11 returned — the coherence validator was
  killing good spans over boundary sentence-fragments (model timestamps are
  interpolated guesses) and "this course" self-references. Fixes shipped as
  clips-v2: deterministic **sentence-boundary snapping**
  (`snapToSentenceBounds`, applied before validation) + a coherence
  calibration (judge REFERENCE DEBT outside the clip's time window; the clip
  carries its own footage, so "watch this" is fine; prefer proposing the ±8s
  adjustment) + selection told to score transcript-blind enthusiasm honestly.
- **Governance**: 3 tools (`tools/clips.ts` — `select_clip_moments` +
  `list_clip_moment_candidates` + `update_clip_moment_status`), ALL
  reversible-tier, zero approval cards. New gate entities:
  `clip_moment_set` (composite over `request_id` — rejecting a selection
  removes the whole candidate set; the transcript cache survives) +
  `clip_moment_candidate` (byte-for-byte single-row restore). Agent prompt
  gained a "LESSON CLIPS" section (funnel-balanced default proposal,
  rationale-not-scores, never claim a clip file exists yet).
- **DB** (migration `20260707100000_lesson_clips.sql`, applied + types
  spliced): `lesson_transcript` (no delete policy — cache) +
  `clip_moment_candidate` (delete policy for revert-of-create; the
  `social_voice_profile` precedent) + 5 snake_case event types on the single
  `analytics_event` stream (TS union extended together; drift regex-guarded).
  ⚠ the live DB carries unmerged-branch drift (`learning_events.
  feedback_comment` etc.) — types were spliced surgically, NOT full-regen,
  to keep this branch self-consistent.
- **REST**: `POST/GET /api/marketing/lessons/[lessonId]/clip-moments`
  (through the gate; typed 422/502/503 via `clips/routeHelpers.ts`).
- **Tests**: `npm run verify:clips` (**117** pure, in the `npm test` chain)
  · `npm run verify:clips:int` (**33** vs live Supabase — acquisition matrix,
  gate-staged selection + events, byte-for-byte + whole-set reverts,
  zero-survivor nothing-persisted, full RLS matrix) · `npm run eval:clips`
  (§20 harness: live/record/replay modes, recorded CI stubs + baseline in
  `lib/marketing/clips/fixtures/recordings/`).

## Marketing — the agent hand-wrote fake course URLs (`/courses/{id}`), 2026-07-07

Live incident #4 of the day: a CTA in a SENT broadcast 404'd at
`/courses/{courseId}/preview` — a route that doesn't exist anywhere in the
app. A DB query of `marketing_action` for this course showed the pattern
clearly: every `send_broadcast` call the agent made had hand-written a button
href guessing a REST-ish path from the raw course id (`/courses/{id}` and
`/courses/{id}/preview`), while its `send_test_email` calls correctly used
`{{ctaUrl}}` — because that tool's description happened to mention "merge
vars." `send_broadcast`'s description never did, and nothing taught the model
the real route map (`/learn/{slug}`, `/p/{slug}`) or that it doesn't know it.
Worse: the approval card's body preview showed only `[Open the course]` — the
button's actual destination was invisible, so nothing let the creator catch
it before approving.

- **Send-time rescue extended** (`resolveSendTimeButtonHref`,
  `lib/marketing/ctaDestination.ts`): a relative href that isn't one of the
  app's two real public destinations (`/learn/*`, `/p/*`) is now treated as
  fabricated — same rescue-to-ctaUrl path as a dead `"#"` href. This is the
  load-bearing fix: it protects EVERY send (broadcast, sequence, test)
  regardless of what authored the bad link, present or future.
- **Approval preview transparency**: `bodyPreviewText`
  (`lib/marketing/tools/email.ts`) now renders a button as
  `[Label → href]`, not just `[Label]` — a human reviewing the "Needs your
  attention" card can now actually see (and reject) a wrong destination
  before approving.
- **Root-cause prompt fix**: the system prompt gained a "LINKING TO THE
  COURSE" rule (`lib/marketing/agent/prompt.ts`) — the agent must use
  `{{ctaUrl}}`/`{{freeLessonUrl}}` for any course link and never hand-write a
  path; `send_broadcast`/`send_test_email`/`write_email_touch` tool
  descriptions repeat the same instruction locally.
- **Tests**: `verify:marketing:cta` 47 → **50**, including a full
  reproduction — `send_broadcast` with the EXACT fabricated
  `/courses/{id}/preview` href from the incident, asserting the approval
  preview shows the raw href and the mock-delivered email wraps the real
  `/learn/{slug}` link, never the 404 path. Pure resolution matrix also
  covers `/dashboard` and other non-`/learn`/`/p` paths, and confirms a
  fabricated path with NO resolvable destination still passes through
  untouched (nothing to rescue to). `verify:marketing`,`:email`,`:campaign`,
  `:autonomy`,`:agent` re-ran green; full build clean.

## Marketing — quoted RESEND_FROM + broadcast sender-identity gap, 2026-07-07

Follow-up to the previous fix, which made the failure VISIBLE for the first
time: "Resend: Invalid `from` field... — the request is still pending." Two
defects, one only reachable because of the other:

1. **A `.env`-style quoted value survives Vercel's env var UI verbatim.**
   `.env.local` has `RESEND_FROM="WiseSel <you@domain.com>"` — dotenv-style
   parsing strips those quotes locally, but Vercel's dashboard does NOT strip
   quotes from a pasted value, so the literal `"..."` characters reach
   `process.env.RESEND_FROM` and fail Resend's from-address parser (worked
   locally, broke only on the deployed domain). Fix: `cleanEnvValue` in
   `lib/marketing/services/resend.ts` trims + strips one layer of wrapping
   matching quotes; `composeFromHeader` applies it to `envFrom` unconditionally
   (defense at the one call site, not a Vercel-dashboard edit requirement). A
   second error branch for "Invalid `from` field" now names the exact composed
   header and the raw env value, so a still-malformed config self-diagnoses.
2. **`sendBroadcast` (the `send_broadcast` tool — exactly what's approved from
   the "Needs your attention" card) never loaded the campaign's sender
   identity at all**, unlike the scheduled-sequence tick. This meant every
   broadcast silently skipped the sender's display name, Reply-To, AND the
   CAN-SPAM-required mailing address in the footer — and any
   `{{ctaUrl}}`/`{{courseName}}`/etc. merge token in a broadcast body rendered
   as a literal unresolved token (no merge vars were ever built). This is WHY
   the bug only showed up on `send_broadcast`: with no sender identity's
   `fromName`, `composeFromHeader` fell straight through to the raw
   (quoted) env value instead of reconstructing a clean header. Fix:
   `sendBroadcast` now caches sender identity / CTA destination / locale
   PER CAMPAIGN (course-level contacts can span several) and passes the full
   merge-var context + sender fields into `deliver()`, matching
   `runSchedulerTick` exactly.
- **Tests**: `verify:marketing:campaign` 112 → **119** (`cleanEnvValue` +
  quoted-`composeFromHeader` matrix); `verify:marketing:email` gained 3 checks
  asserting a broadcast's mock-recorded send carries the sender's display
  name, Reply-To, and mailing-address footer. `:autonomy` (93), `:lists`
  (31), `:sync` (50) re-ran green; full build clean.

## Marketing — approvals resolve instantly + errors render in the card, 2026-07-07

Live incident #2 of the day: "Approve & send" appeared broken on BOTH
environments. Two stacked defects:

1. **Errors were invisible.** A failed approve (e.g. a provider config error
   in production) returned an error `ActionResult`, but the agent-chat card
   passes no `onResult` — the spinner just stopped with no reaction and the
   card stayed clickable. **Fix:** ApprovalCard/QuestionCard render the
   failure INLINE (rose alert with the real provider message + "still
   pending, retry"), so a misconfigured deployment now diagnoses itself.
2. **The approve action awaited the agent's full resume.** After the send,
   `approvePendingAction` ran the multi-turn wrap-up model run inline — and
   the marketing loop's `runTurn` had NO `timeoutMs`, so no abort signal was
   wired and the SDK timeout is silently ignored by the proxied undici fetch
   (providers/openai.ts): a stalled call hung the button FOREVER (the local
   "sends the email but spins permanently").

**Fixes:** (a) the marketing agent loop now sets a HARD per-call deadline
(`MARKETING_AGENT_TURN_TIMEOUT_MS`, default 120s) — covers the chat stream
too; (b) approve/deny/answer return the moment the effect is done (card
collapses instantly) and the agent's wrap-up moved to a background
`fetchAgentFollowUpAction` (fired by the card, decision derived from the ROW,
bounded at 180s) whose transcript lands via new
`attachActionFollowUp`/`attachQuestionFollowUp` writes on the approvalSync
store (first-writer-wins kept; `applyRemote` accepts a follow-up-carrying
copy filling a null); the AgentPanel replays it through the existing
subscription. Tests: `verify:marketing:sync` 42 → **50** (attach matrix +
remote fill-in); `verify:marketing:agent` (22) + `verify:marketing:autonomy`
(93) re-ran green; full build clean.

## Marketing — send-time CTA hrefs are authoritative, 2026-07-07

Live follow-up to the 2026-07-06 CTA work: a campaign's emails still landed
subscribers on the HOMEPAGE. Root cause — template bodies bake a literal
button href at generation time (`ctaPath ?? "#"` in email/templates.ts), and
send-time destination resolution only flowed through `{{ctaUrl}}` merge vars,
so a body generated before the course had a destination carried `"#"` forever
(the click route coerces `"#"` to `/`), and a pre-publish body kept sending
list traffic to the capture form after the preview went live. The documented
"publishing upgrades queued sends" promise only held for LLM bodies that used
`{{ctaUrl}}`.

- **`resolveSendTimeButtonHref`** (`lib/marketing/ctaDestination.ts`, pure):
  inside `prepareBodyForSend` (the ONE send-render pipeline — tick, broadcast,
  test send), every button href now resolves send-time-authoritatively:
  (1) an authored `{{freeLessonUrl}}` button stays on the capture page;
  (2) a DEAD href (`""`/`"#"`/`"/"`/unresolved merge token) is rescued to the
  current `ctaUrl` (then `freeLessonUrl`); (3) a baked landing-page href
  (relative or absolute) upgrades to the course preview once a live
  publication makes `ctaUrl` diverge; (4) anything else renders untouched.
- **Compliance sees what will send**: `review_campaign_compliance`'s broken-CTA
  check validates hrefs through the SAME resolution — a rescued href passes, a
  genuinely dead one (no destination anywhere) still blocks.
- **Tests**: `verify:marketing:cta` 26 → **41** — the pure resolution matrix
  (13) + two live regressions: a pre-publish sequence body renders post-publish
  to the wrapped ABSOLUTE `/learn/{slug}` URL, and a baked `"#"` CTA is rescued
  to the preview (never the homepage). `verify:marketing` (37),
  `verify:marketing:email` (34), `verify:marketing:campaign` (112) re-ran green.

## Marketing — email CTA destinations + site-URL guard, 2026-07-06

From a live incident: an automated email's CTA landed on vercel.com's 404.
Three stacked defects — the sending environment's `NEXT_PUBLIC_SITE_URL`
pointed at the Vercel DASHBOARD (`vercel.com/wisesel`), the `{{ctaUrl}}` /
`{{freeLessonUrl}}` merge vars the LLM copywriter is told to use were
hard-coded `null` at send time (model-written buttons rendered a literal
`{{ctaUrl}}` into the tracked link), and the click route called
`NextResponse.redirect()` with a RELATIVE path (which Next rejects → 500 even
with a correct domain).

- **The destination rule** (`lib/marketing/ctaDestination.ts`, new): email CTA
  → the course's public preview/enroll page **`/learn/{slug}`** whenever a
  LIVE publication exists, else the campaign landing page `/p/{slug}`.
  Mailing-list traffic goes to the CONVERSION surface — sending subscribers
  back to a lead-capture form is circular. `{{freeLessonUrl}}` keeps pointing
  at the capture page. Resolved at SEND time (scheduler, cached per
  course+campaign per tick) and at generation time (template button hrefs) —
  publishing a course upgrades every queued send without regenerating copy.
- **Merge vars are real now**: the scheduler, `send_test_email`, and the
  compliance review all resolve `ctaUrl`/`freeLessonUrl` through the same
  function (absolute URLs via the new `publicUrl()` in tokens.ts). The
  compliance CTA check validates button hrefs AS THEY WILL RENDER (merge vars
  applied first).
- **Site-URL guard**: `review_campaign_compliance` now runs `siteUrlFinding()`
  — unset / unparseable / `vercel.com` (the dashboard, never an app origin) =
  BLOCKING; localhost = warning (dev-only links). This class of misconfig now
  blocks the launch instead of shipping dead links.
- **Click route** resolves relative destinations against the request origin
  (`new URL(dest, origin)`); non-http(s) destinations neutralize to `/`.
- **Tests**: new `verify:marketing:cta` (26 — the site-URL matrix, click-route
  redirects incl. the relative-path regression, pre/post-publish destination
  flip via a real `publishCourse`, send-time render leaves no literal merge
  token, compliance wiring). Campaign suite updated: tsx doesn't auto-load
  .env.local so the suite now mirrors dev (`NEXT_PUBLIC_SITE_URL ??=
  localhost`), and the A3b missing-merge-var test creates its premise
  explicitly (destinations RESOLVE now, so `{{freeLessonUrl}}` is only missing
  when no landing page exists). templates.ts opt renamed `landingPath` →
  `ctaPath` (it may be either destination now).

## Marketing — Social Post Generator (Phase 1), 2026-07-06

The generation backbone from the approved PRD (`docs/prd/Social-Media-Post-
Generator-Marketing-Web.html`; guide: `docs/social-posts.md`): creators turn
real course content into 1–5 platform-ready **LinkedIn/Facebook** drafts —
grounded, voice-true, funnel-staged, manually published. Zero platform APIs,
zero email, zero scheduling (nothing fires from `planned_post_at`), zero
approval cards (every tool is reversible-tier).

- **Schema** (migrations `20260706120000` + `20260706120100`): `social_post`
  (versioned optimistic-concurrency writes; SOFT delete only — no delete
  policy), `social_post_batch` (first-class batch: grouping, audit,
  Idempotency-Key replay, daily-budget counting), `social_voice_profile`
  (derived + versioned; distinct from the email `voice_profile` rules, which
  feed its derivation), the transactional `social_create_batch` SQL function
  (SECURITY INVOKER — RLS applies; all posts commit or none), the private
  `social-post-images` bucket (own-folder RLS), and 13 new event types on the
  single `analytics_event` stream (TS union + DB check extended together).
- **Pipeline** (`lib/marketing/social/*`): context assembly (reuses
  `loadCourseMarketingContext`, token-budgeted), voice profile
  (derive-on-first-use, creator-tunable, `source='creator_edited'` guards
  regeneration), cache-stable prompt prefix + `PROMPT_VERSION` stamped in
  `ai_metadata`, ONE structured batch call (semaphore-capped, hard 3-minute
  ceiling — quality over speed), Zod gate + exactly one repair call,
  deterministic safety lint with a creator-context whitelist (flagged drafts
  repair-or-drop with surfaced reasons), transactional persist, per-draft SSE
  streaming, deterministic template fallback for the zero-key path.
- **19 agent tools** (`tools/socialPosts.ts`): 5 read/suggest + 14 reversible
  writes — the Cursor loop (list/get → versioned targeted edits →
  explain-why). Version conflicts teach re-read + re-apply; `rewrite_for_platform`
  and variants create NEW rows (originals never mutated); variants always ride
  a batch so the set reverts as one unit. Composite `social_post_batch`
  snapshotter restores post sets byte-for-byte; revert-of-create ARCHIVES
  (soft-delete-only invariant). Agent prompt teaches SOCIAL POSTS + the
  manual-publishing honesty contract.
- **REST** (`/api/marketing/social-posts/*`, `/api/marketing/social-voice-profile`):
  generate (SSE + Idempotency-Key), list/get/patch/delete, revise/tone/
  regenerate/variants/rewrite/status/performance/image/hashtags/alt-text/track
  — all mutations through `executeMarketingTool` → the gate (revert-log
  entries for UI edits; the revision budget counts the ledger). Typed errors:
  409 conflict / 429 budget / 502 generation-failed(stage) / 503 no-model.
- **UI** (`/marketing/social` + `components/marketing/social/*`): generator
  controls (source/platform/goal+auto-stage-chip/tone/count+balanced-mix/
  timing) that collapse after first use, streaming skeleton intake, filterable
  batch-grouped queue, full editor (counters from `PLATFORM_LIMITS` —
  imported, never copied; hashtag chips; AI actions; image upload/finalize
  with magic-byte validation + soft norm warnings; export cluster firing
  telemetry; performance one-tap form), voice-profile sheet, the ONE
  `ManualPublishNotice` component, error-with-retained-parameters + conflict
  toast states. Hub Explore nav entry.
- **Tests**: `verify:social` (127 pure — schemas/caps, funnel mix, every lint
  rule + whitelist, timing incl. the DST edge, exports, imageMeta, prompt
  stability, 19-tool registry snapshot, and the hardening greps: banned UI
  language, no social hosts, no scheduler, single-writer rule) — in `npm test`;
  `verify:social:int` (59 vs live Supabase + mock model — pipeline incl.
  repair/lint-drop/fallback, idempotency, rate limits, 409s at both layers,
  lifecycle + soft-delete-only, byte-for-byte reverts, full RLS matrix,
  storage finalize, agent turn end-to-end with zero pauses).
- ⚠ Hard-won: zod v4 **throws at runtime** on `.omit()/.extend()` over a
  refined schema (TS doesn't catch it — the build's page-data collection did);
  export the base object separately. And Node prefers supabase.co's IPv6 on
  this network — int scripts pin `dns.setDefaultResultOrder("ipv4first")`.

## Marketing — approval sync, stop controls, hub redesign, 2026-07-06

Three UX defects from live usage: (1) the SAME approval rendered in the agent
chat AND the hub inbox, and resolving one left the other stale + clickable;
(2) pause/cancel existed only as small builder-header buttons (and not at all
for individual sequences), so "there's no way to stop a sequence" was
effectively true; (3) the hub stacked 9 sections / 60–100+ controls with no
disclosure.

- **Cross-surface approval/question sync** (`lib/marketing/approvalSync.ts`):
  an in-memory zustand resolution store keyed by actionId/questionId +
  BroadcastChannel mirroring across tabs. `ApprovalCard`/`QuestionCard`
  subscribe by id — resolving ANY copy collapses every copy, first-writer-wins.
  Stale clicks now tell the truth: `approvePendingAction`/`denyPendingAction`
  return `alreadyResolved` ("Already handled — resolved elsewhere") instead of
  the old approve-throws / deny-silently-succeeds asymmetry; the stale card
  collapses to a neutral "Handled" line.
- **The resume is visible now**: approve/deny/answer server actions capture the
  resumed agent run's events (`emit` into `followUpFromEvents`, pure, in
  `agent/events.ts`) and return them as `ActionResult.agentFollowUp`; the
  resolution carries it through the sync store and `AgentPanel` replays it as
  transcript items — including a NEW approval/question card when the resume
  blocks again. Previously the resume ran headlessly and the chat went silent
  after every approval (the wrap-up contract was persisted but never seen).
  Migration `20260706000000`: `marketing_action.conversation_id` — the
  approval resume lands deterministically in the SAME thread the run paused
  in (was "most recent conversation", right only by accident).
- **Stop controls everywhere they're expected**: new `pause_sequence` /
  `resume_sequence` tools (reversible; resume refused while the parent
  campaign is paused/cancelled — the scheduler keys off sequence status, so
  that guard prevents "campaign paused but emails going out").
  `pause_campaign`/`resume_campaign`/`cancel_campaign` are now CAMPAIGN-WIDE
  (every sequence, matching the guardrail auto-pause — primary-only before,
  which stranded followup sequences); summaries state the held/stopped send
  count; resume clears `config.autoPauseReason` (the amber banner no longer
  outlives the pause it describes). UI: `components/marketing/
  LifecycleControls.tsx` (Pause/Resume/Cancel… — cancel renders its approval
  card in place) on the hub campaign card, campaign list rows, sequences
  list + detail; the builder Delivery card explains paused/cancelled states
  and hides "Process due sends" while paused. The agent system prompt gained
  a "STOPPING THINGS" block (prefer pause for an ambiguous "stop"; cancel is
  permanent + always carded; held ≠ lost).
- **Hub redesign** (`MarketingHub.tsx`): ask-bar hero → ONE "Needs your
  attention" zone (approvals + questions, count-badged, only when nonempty) →
  a work column (new `CampaignCard` with status/delivery/lifecycle controls +
  landing pages as a single card) + a quiet rail (compact Explore nav — the
  six fat engine cards became one list — then Recent changes and Agent
  autonomy as `CollapsibleCard`s whose disclosure persists via
  `lib/marketing/hubUiStore.ts`, zustand persist + `skipHydration`, the
  studio uiStore pattern). `AutonomySettings` gained an `embedded` variant.
- **Verify**: new PURE suite `npm run verify:marketing:sync` (42 — the
  follow-up fold, the sync store incl. broadcast no-loop + garbage rejection,
  and the lifecycle registry/prompt invariants), added to the `npm test`
  chain; `verify:marketing:autonomy` (93) + `verify:marketing:campaign` (112)
  re-ran green against live Supabase after the gate + lifecycle changes.

## Marketing — delivery-timing honesty (send-window visibility + agent wrap-ups), 2026-07-04

From live usage: a creator launched a campaign at 23:41 local, the agent said
"4 subscriber(s) will begin receiving the sequence", and nothing arrived — the
sends were correctly HELD by the default send window (9–11 UTC weekdays,
Amendment 12) but NOTHING said so, and the agent ended its run without any
summary of what had happened or what would happen next.

- **Pure window helpers** (`lib/marketing/scheduler.ts`): `sendWindowState`
  (open now? when does it next open — 15-min stepping, weekend-aware, 14-day
  horizon), `describeSendWindow` ("09:00–11:00 UTC, weekdays"),
  `formatWindowOpening`, and `sendTimingSentence` — the ONE sentence that keeps
  everyone honest ("Queued emails are HELD until the send window opens (…);
  next opening Fri, Jul 4, 09:00 (UTC)."). `withinSendWindow` exported; the
  private DEFAULT_WINDOW now aliases the types' `DEFAULT_SEND_WINDOW`.
- **Every summary that enqueues sends states the timing**: `launch_campaign`
  (preview AND executed — so the approval card warns BEFORE the creator
  approves; executed `data` carries `nextWindowOpensAt`), `activate_sequence`,
  `enroll_segment_in_sequence`.
- **Builder Delivery card** (`CampaignBuilder.tsx` + server-computed
  `sendWindowInfo` in `page.tsx`): a due-but-held state now renders an amber
  callout — "N queued emails are due but held until your send window opens
  (09:00–11:00 UTC, weekdays). Next opening: {local time} your time." The old
  copy hardcoded "default 9–11am weekdays" with no timezone (misleading for a
  non-UTC creator) and never said sends were being held. Window state is
  computed with the injected clock — react-hooks/purity forbids `Date.now()`
  in render even in server components.
- **Agent END-OF-RUN wrap-up contract** (`agent/prompt.ts`): never stop
  silently after tool calls — close every run with (1) what you did, (2)
  what's true now, (3) what happens next and WHEN ("Enqueued is NOT sent"),
  (4) what awaits the creator. The approve-resume message
  (`agent/resume.ts`) now explicitly demands that wrap-up with timing.
- **Tests**: campaign suite 101 → 112 (pure window-state/timing-sentence
  matrix incl. weekend skip + degenerate window; launch preview/executed
  summaries + `nextWindowOpensAt` asserted at the fixed clock); autonomy
  92 → 93 (prompt wrap-up directive). Full marketing set: **398 checks
  green**; build + lint clean.

## Fix — OpenAI transport proxy (agent "Request timed out."), 2026-07-03

Every real-model agent call (marketing agent AND studio content agent) died at
`{"tag":"openai_error","message":"Request timed out."}` after ~85–89s. Root
cause (verified with `curl` + the smoke test): on this machine
`api.openai.com` is reachable ONLY through the local Clash proxy, and the
OpenAI SDK's bundled undici fetch IGNORES `HTTPS_PROXY` — it connected
directly and hung until the transport deadline. This repo copy never received
the proxy shim the sibling App repo already had; ported it:

- `lib/ai/providers/openai.ts`: `resolveProxyUrl()` (`OPENAI_PROXY_URL` wins,
  else `HTTPS_PROXY`/`HTTP_PROXY`) + `makeProxyTransport()` — undici's own
  `fetch` + a `ProxyAgent` dispatcher with socket-level timeouts, passed
  TOGETHER and scoped to the OpenAI client only (global dispatcher untouched;
  Supabase and all other fetch stay direct). No proxy env ⇒ direct connection
  exactly as before (production unaffected). undici loaded via non-literal
  `createRequire` (devDependency; the bundler never resolves it). An
  `openai_client_config` log line states the ACTUAL transport per client.
- `scripts/smoke-openai.ts` + `npm run smoke:openai`: Phase A reproduces the
  direct-connection failure, Phase C proves the provider's scoped proxy works
  while the global dispatcher stays direct. Verified: A1 direct fetch failed
  (dead), C1 wrapper call answered in 2.8s through Clash.

## Marketing — audience list building + agent dock + freeform answers, 2026-07-03

Follow-up QoL pass from live usage: the agent (and the UI) couldn't put
EXISTING contacts on a list, the chat was buried in a card grid, and question
cards had no type-your-own-answer path.

- **Audience tools** (all reversible, all send nothing): `build_audience_list`
  (create + fill from existing contacts in one step — consent × funnel-stage
  filter, suppressed always excluded, confirmed-only lists are
  consent-confirmed at birth), `add_leads_to_list` (filter or explicit ids,
  already-members skipped), `remove_leads_from_list`. The `lead_list`
  snapshotter is now COMPOSITE (row + membership) — reverting any membership
  edit restores it byte-for-byte, fixing the silent `import_leads` revert gap;
  legacy bare-row snapshots still restore. Found + fixed along the way:
  `lead_list_member` had no UPDATE policy, so restore's upsert failed RLS
  (migration `20260703120000`). `removeLeadFromListAction` now routes through
  the gate (was the one direct-delete bypass). The agent's system prompt now
  teaches the capability explicitly.
- **ListBuilder UI** (`components/marketing/ListBuilder.tsx`): a prominent
  "turn your contacts into a mailing list" panel on BOTH `/marketing/leads`
  and `/marketing/audience` — live-counted consent × stage slicing, new-list
  or add-to-existing, revert hint on success.
- **Agent dock**: `app/(app)/marketing/layout.tsx` mounts a floating "Ask the
  agent" pill on every marketing page (hidden where a chat already owns the
  surface) opening a right slide-over with the same AgentPanel; the transcript
  survives close (panel stays mounted). The hub gets a front-and-center
  ask-bar + suggestion chips that seed the dock and auto-send
  (`agentDockStore`, `AgentPanel seed/onSeedConsumed`).
- **Freeform question answers**: every QuestionCard offers "Something else…"
  (`value: "__other__"`); the resume message hands the creator's words to the
  agent verbatim — allowed to redirect the plan, never coerced into an option.
- **Verified:** new `verify:marketing:lists` **31/31**; all 12 suites green —
  **386 checks total**; build + lint + tsc clean; 15-check Playwright pass
  (dock open/close/seed, list builder end-to-end → quiet revertable hub log,
  audience-page parity).

## Marketing agent — gate/autonomy redesign, 2026-07-03

The approval system rebuilt around one principle: LOUD only where a human is
load-bearing. Full design doc: `docs/marketing-autonomy.md`.

- **Reversible tier fixed (the core bug):** all 25 reversible tools used to
  stage blocking Accept/Reject cards with the same weight as the 10 real gate
  cards. Now they execute + land as a quiet, dismissible **activity log** with
  a one-click **Revert** for a configurable window (default 24h,
  `marketing_action.revert_expires_at`; refused after expiry, fail-closed;
  Dismiss = accept). Unconditional — not gated behind any mode.
- **Three autonomy modes** (per-course `marketing_autonomy_settings`,
  governing ONLY the irreversible tier): `manual` / `assisted` (default; no
  row needed) / `auto`. Auto evaluates an explicit creator policy through the
  PURE engine `lib/marketing/autonomy.ts` (allowlist + recipient cap + budget
  cap + allowed hours + first-send-to-new-segment via the new
  `marketing_segment_send` history); every unset field fails closed, the empty
  policy is inert, one failing guardrail routes to a card, and the full audit
  persists as `autonomy_decision`. **Hard-deny first** — `launch_campaign`,
  `cancel_campaign`, `send_consent_confirmations` never auto-approve.
  Assisted auto-logs owner-addressed test emails (foreign addresses stay
  carded) and resolves ambiguous targeting via a question before the card.
- **Clarifying questions** (`marketing_question`): model-raised (`ask_creator`,
  a narrow 2–5-option interaction tool the gate resolves) or gate-raised
  (`clarifyTargeting` hooks on send_broadcast / enroll_segment_in_sequence —
  null status over a mixed audience; `"all"` = explicit everyone so answers
  never re-trigger). Both pause the loop through ONE `agent_blocked {kind}`
  branch; `resumeAgentAfterAnswer` is the third resume path (same
  conversation, one turn; gate-raised answers tell the agent to retry the
  tool with the param resolved; user-path answers re-run the tool directly).
- **One-card approval** (`ApprovalCard`, shared by chat/hub/builder/leads):
  full inline preview (new `effectLabel` + `bodyPreview` on irreversible
  previews; pages re-run previews server-side so counts stay current),
  exactly Approve-&-effect / Edit (in-place param edit + re-preview) /
  Reject (+ optional note to the agent). Request buttons return the pending
  payload → the card renders where the creator clicked; the old two-location
  request→approve round-trip is gone. `approveMarketingAction` claims
  `pending→'approved'` atomically — double-clicks see "already resolved",
  failed executes release back to pending (retryable).
- **UI:** `components/marketing/{ApprovalCard,QuestionCard,ActivityLogEntry,
  AutonomySettings}.tsx`; MarketingHub gets Needs-approval cards, "The agent
  asked", the quiet Recent-changes log, and the autonomy settings section.
- **Verified:** new `verify:marketing:autonomy` **92/92** (pure invariant
  permutations first, then live: unknown-tool fail-closed + registry drift
  guard, hard-deny sweep, deny-never-executes, per-guardrail ladder,
  reversible-never-pends, revert window, governance language, pause/resume
  parity, approve race, segment history). Updated `:agent` 18→22,
  `:campaign` 99→101, `:email`/`:marketing`/`:landing-edit` adjusted for the
  revert-window clock injection. **Full marketing suite: 355 checks green**;
  `build` + `lint` + `tsc` clean; Supabase advisors show no new findings.
## Milestones 5+6 — maintenance agent (orchestrator + subagents) + learner comms, 2026-07-03

- **M5 subagent primitive** (`lib/ai/subagent.ts`): `runSubagent` reuses the
  agent loop with an arbitrary `allowedToolNames` allow-set + `persist:false`
  (nothing in the conversation tables — replay lives in `agent_runs.report`),
  then a one-shot strict-JSON verdict. **Global semaphore caps concurrent model
  calls at 2** (`withSemaphore` ModelClient decorator — uniform across loops
  and one-shots); ONE shared call budget (40) + token budget (300k) per run
  with graceful truncation (partial verdict > nothing; skipped findings stay
  open). Additive loop hooks only — every existing caller byte-identical
  (verify:ai:int 143/143 re-run green).
- **Analytics read tools** (`lib/ai/tools/analytics.ts`, 6 tools over the
  rollups — never raw event pagination) via a `ToolContext.analytics`
  capability (the `visuals` precedent): pre-loaded rollups + snapshot maps +
  a memoized learner-profile loader; compact capped JSON; NO learner emails in
  prompts. New sets `ANALYST_TOOL_NAMES` / `REMEDIATION_TOOL_NAMES` (authoring
  only — no structural/destructive/confirm-pausing tools).
- **The orchestrator** (`lib/ai/maintenance.ts`): Analyst (read-only loop) →
  InsightReport → dedupe/prioritize (adopts open threshold findings, severity
  desc, fan-out CAP 5) → Remediation SEQUENTIAL over the shared draft (each
  finding staging ONE change-set whose EVERY item carries the finding's
  evidence) ∥ Comms drafting `learner_messages` rows (template-grounded,
  model-personalized, deterministic fallback — NEVER sends). Run ledger =
  `agent_runs` (queued|running|completed|failed, report + budget_used);
  findings = `agent_findings` (open→proposed→accepted|dismissed, transitioned
  by the change-set Accept/Reject route; open-dedupe partial unique index).
- **`analyze` = the 5th intent** (regex first — "why are students dropping
  off in module 3?" scopes via `parseAnalysisScope` to that module's lessons);
  one additive `maintenance` AgentEvent member streams stage + findings.
- **Triggers ×3**: chat (SSE, unchanged route) · scheduled (weekly pg_cron
  queues `agent_runs` in-DB; `POST /api/ai/maintenance/cron` guarded by
  `Bearer CRON_SECRET` drains one run per invocation with the admin client —
  the analytics RPCs gained a service-role allowance for this) · threshold
  (`private.file_threshold_findings` after every rollup recompute files open
  findings — one per question, reasons aggregated; studio header shows an
  "N findings" badge; the agent panel's "Review flagged issues" chip runs an
  adopting analysis).
- **The evidence card** (`components/editor/agent/EvidenceCard.tsx` — the core
  product moment): severity-tinted WHY above every proposed change ("Q1: 64%
  incorrect over 41 attempts; distractor 'Demand increases' chosen 3× the
  key…"), metric chips, rendered in BlockFrame's pending chrome + the panel;
  evidence rides `change_set_items.evidence` (hydrate + realtime + the
  change_set event, so it appears live).
- **M6 learner comms** (`lib/comms/*`, standalone seam — the marketing branch
  stays untouched): provider iface + **Resend via `fetch`, NO SDK** (runtime
  deps stay 14; From-address pinned to RESEND_FROM, List-Unsubscribe header) +
  recording mock + env factory + HMAC opt-out tokens (purpose-prefixed,
  `MARKETING_TOKEN_SECRET`) + block renderer w/ compliant footer + 3 templates
  (stalled nudge / almost done / struggling-on-topic w/ lesson deep link).
  **`service.approveAndSend` is the ONLY caller of `provider.send`** and
  re-checks `enrollments.comms_opt_out` at send time (opted-out → the row
  STAYS draft). `learner_messages` (draft|approved|sent|failed, author-only
  RLS). Routes: messages CRUD + approve_send; `/api/comms/opt-out` (GET =
  confirm page — never flips on GET; POST = token-verified flag flip). UI:
  MessageComposer + DraftList (agent panel "Messages to review"), the Stuck
  queue's **"Draft follow-up" wired** (deterministic template prefill;
  disabled+honest tooltip when opted out), learner-detail message audit list.
  **No auto-send path exists — not even behind a flag.**
- **Safety rails asserted end-to-end** (verify:maintenance:int): no publication
  writes, no enrollment mutation, drafts only (comms mock records ZERO sends
  across a full run), budgets ≤ cap, Accept applies to the draft, Reject
  restores byte-for-byte, threshold adoption + dedupe index.
- **Tests**: `verify:maintenance` (35 pure — semaphore ≤2 in flight under 6
  concurrent calls, truncation, dedupe/cap, intent+scope, tool shapes) ·
  `verify:maintenance:int` (25) · `verify:comms` (27) · `verify:comms:int`
  (20 — opt-out at the seam) · `seed:fixtures` (the deliberately-bad quiz
  fixture) · **`npm test`** now chains every pure suite (~900 checks, green).
- **Docs**: `docs/publishing.md`, `docs/analytics-events.md`,
  `docs/agent-architecture.md`. Env: `NEXT_PUBLIC_SITE_URL`, `CRON_SECRET`
  (+ optional `COMMS_PROVIDER=mock`, `MAINTENANCE_*` budgets).

## Milestones 3+4 — learning-event pipeline + creator analytics dashboard, 2026-07-03

- **M3 event pipeline.** Append-only `learning_events` (9-type Zod discriminated
  union in `lib/analytics/events.ts`, camelCase wire ↔ snake DB via
  `mapEventToColumns`; UNIQUE `client_event_id` = idempotent replay). **Hybrid
  emission**: the browser SDK (`lib/analytics/client.ts` batching queue — 10s
  flush + hidden/pagehide keepalive flush, backoff retry, chunking, offline cap;
  `components/learn/AnalyticsProvider.tsx` owns DOM wiring + visible-only
  heartbeat; `SlideDwellTracker` excludes hidden-tab time) sends the engagement
  events through `POST /api/analytics/ingest`; the AUTHORITATIVE events
  (quiz_submitted / homework_submitted / lesson_completed) are SERVER-emitted
  from quizService/homework route/progressService keyed by stable row uuids
  (`lib/analytics/serverEmit.ts`) so tab-close can't lose them and retries can't
  double-count. `ProgressContext` gained `version`.
- **Hard-won RLS gotcha:** Postgres applies the SELECT policy to
  `INSERT … ON CONFLICT` rows — and students deliberately read none — so an RLS
  upsert can never be idempotent here. Ingest therefore goes through the
  SECURITY DEFINER **`ingest_learning_events` RPC** (pins user_id to auth.uid(),
  enforces enrollment + publication↔course in SQL, `on conflict do nothing`);
  the table's insert policy stays as defense-in-depth.
- **Rollups (migration `20260702050000`)**: `rollup_lesson_funnel` (started =
  events ∪ learn_progress backfill; completed cross-checks learn_progress;
  lag() drop-off), `rollup_question_stats` (n / pct_correct / answer
  distribution with the KEY bucket resolved from quiz_answer_keys at rollup
  time / **point-biserial discrimination in SQL**), `rollup_slide_dwell`
  (percentile_cont median/p90), `rollup_video_retention` (quartile counts),
  `learner_flags` (inactive-7d-incomplete + repeated-quiz-failure). Nightly
  **pg_cron** (`0 3 * * *`) + author-gated `refresh_course_analytics(cid)` for
  manual/dev refresh. All keyed by (course, publication, version) so republishes
  never mix. Thresholds mirrored in `lib/analytics/flags.ts` (verify asserts
  TS === migration SQL literals); `lib/analytics/stats.ts` mirrors
  percentile_cont + point-biserial for SQL↔TS agreement tests.
- **M4 dashboard** at **`/studio/[courseId]/analytics`** (server components over
  rollups + two definer RPCs `course_analytics_overview` / `course_roster` —
  the roster needs auth.users.email): four `?tab=` tabs — **Overview** (stats +
  hero lesson funnel + cumulative enrollments), **Content health** (drop-off
  table · video quartile retention · quiz item analysis [rendered only when the
  snapshot has quizzes; red flags: <40% @ n≥20, distractor ≥2× key,
  discrimination <0.1] · dwell skim/stall outliers — every flagged row
  deep-links to the editor block), **Learners** (roster → per-learner detail:
  progress map, `<details>`-expandable attempt history w/ per-question
  responses, paginated raw-event timeline on the indexed path, heartbeat time,
  flags), **Stuck queue** (why-flagged rows + DISABLED "Draft follow-up" w/
  tooltip — wired in a later milestone). First-class empty states everywhere
  (charts guarded — `Math.max(...[])`).
- **Entry points**: `/analytics` rewritten from mock → a real course picker;
  gallery cards + the editor top bar link into the dashboard; **editor
  deep-links** (`/studio?course=&lesson=&block=`) land via a new
  `DeepLinkFocus` in `StudioLoader` (opens the lesson, selects + scrolls to the
  block). `marketplace_listings` fallback re-branded ('A WiseSel educator').
- **Tests**: `npm run verify:analytics` (57 pure — contract round-trip/rejects,
  dwell timer visibility math, threshold + SQL-drift guard, point-biserial
  golden, queue batching/retry/4xx-drop/flush-on-unload) and
  `npm run verify:analytics:int` (55 vs live Supabase — idempotent replay, the
  full RLS matrix incl. RPC-pinned forged user_id + direct-table rejections +
  students-read-none + author-only rollups, server-emit keying + re-emit no-op,
  rollup outputs vs hand-computed fixtures incl. SQL===TS discrimination,
  refresh/roster/overview gating, cascade cleanup). verify:learn +
  verify:learn:int re-run green (the server-emit touches).

## Learner course-nav sidebar + WiseSel rebrand cleanup, 2026-07-02

- **Course contents sidebar in the lesson player** (`components/learn/CourseNavSidebar.tsx`)
  — collapsible modules → lessons with the current lesson highlighted, per-lesson
  progress (completed / in-progress % / not-started), and click-to-navigate, so a
  learner always sees where they are and can peek at upcoming units. Desktop = a
  sticky panel (collapsible to a rail); mobile = a "Contents" button opening a
  slide-over drawer. The player page (`app/(learn)/learn/[slug]/[lessonId]`) now loads
  full-course progress in one query (`buildCourseProgressSummary`) to feed both the
  sidebar and the current lesson's initial progress, and its header gained a
  "Module N · Lesson X of Y" line + a Completed pill. Two-column on `lg+`, single
  column with the drawer trigger below on mobile.
- **Rebrand cleanup (CourseGen Pro → WiseSel).** The rename was already done across the
  marketing site, app shell, login, and studio (via `components/brand/WiseSelLogo.tsx`);
  this pass caught the stragglers: the **learner header wordmark** (was a hard-coded
  `CourseGen*` — now `WiseSelLogo`), the **AI agent persona** string (`lib/ai/context.ts`),
  the OS-clipboard payload marker (`coursegen`→`wisesel`), the package name, and header
  comments / READMEs / CLAUDE.md. The GitHub repo slug (`kokomeam/coursegen-pro`) and the
  Obsidian vault folder are left literal (unchanged infra names); historical PRD docs +
  applied migration comments left as-is.

## Student learning runtime — /learn, grading, progress, marketplace (Milestone 2), 2026-07-02

Learners can now actually TAKE a published course. Verified by
**`npm run verify:learn` (55 pure checks)**, **`npm run verify:learn:int`
(61 checks vs live Supabase — RLS matrix + full service happy path + the
lost-update concurrency regression)**, and **`npm run verify:learn:browser`
(15 checks driving the real UI through Playwright: sign in → enroll → slides →
graded quiz → homework → mark complete → course completion → My learning →
author submissions review)** — plus build/lint/tsc and every existing suite
green (publish 59+50, ai 257+143, slides, video 154, reject, imports,
course-agent).

- **Schema (migrations `20260702030000_learn_runtime` + `030100` + `040000`):**
  `learn_progress` (one row per user/course/lesson; server-computed status/pct +
  a `progress_state` jsonb of viewed slides / video high-water / viewed blocks /
  markedComplete; **no client write policies at all** — the progress route is
  the only writer), `quiz_attempts` + `question_responses` (Milestone 3's exact
  column contract, ready for analytics; student reads own, author reads their
  courses', **no client inserts — a client can never write a score**),
  `homework_submissions` (student-inserted under RLS [own user_id + active
  enrollment], and a DB trigger makes review status the ONLY mutable thing —
  the author can't rewrite content, the student can't self-review),
  `private.is_enrolled`, and two SECURITY DEFINER read RPCs
  (`marketplace_listings`, `my_learning`) for the jsonb aggregations PostgREST
  can't compose. Homework files reuse the course-assets bucket's existing
  per-user-folder storage policies (tested).
- **lib/learn/\*** (Zod-first): `grading.ts` (pure per-kind grading — the only
  place responses meet keys; short answers normalized, multi-select set
  equality, kind-mismatch = answered-but-wrong), `completion.ts` (the FIXED,
  documented rule: all slides viewed / video ≥90% / every quiz ≥1 attempt;
  unready media never blocks; untrackable lessons get an explicit
  mark-complete), `progressService.ts` (server-only writer with **optimistic
  locking** — the browser suite caught a lost-update race between two slide
  reports; writes now retry-merge on conflict, and the client serializes its
  reports), `quizService.ts` (grade → record attempt N + responses → recompute
  progress; author preview grades but records NOTHING), slug resolution with
  `previous_slugs` redirects, access checks, learner media resolution
  (video MP4/captions + deck signed URLs via the admin client, strictly after
  the enrollment gate), and course summaries ("continue where you left off").
  Served snapshots are re-validated through the STRICT publish schema —
  a corrupted snapshot fails closed instead of leaking keys.
- **Routes** `/api/learn/{enroll,quiz,progress,homework,deck/[id],submissions}`
  (Node, user-scoped client + RLS wherever possible; admin only for grading,
  progress writes, and post-gate media). Grading returns per-question
  correctness + authored explanations — never the correct answer.
- **/learn (new public route group):** `[slug]` landing (outline, enroll CTA,
  sign-in round-trip via `redirectTo`, progress + Continue for enrolled,
  author-preview card, unlisted 404 copy) and `[slug]/[lessonId]` player —
  every block type rendered READ-ONLY: SlideStage in its thumbnail mode with
  keyboard/click navigation, the trim-aware video player (captions on, new
  additive `onProgressPct`), imported-deck page viewer with learner-scoped
  signed URLs + refresh, quiz taking, homework submission (text + file upload
  to the student's own storage folder), lecture/example/exercise/resource
  renderers. Zero editor chrome reaches a student.
- **Marketplace rebuilt on real data:** mock listings replaced by live public
  publications (deterministic warm-gradient thumbnails, Free pricing, module/
  lesson counts, creator names); "My learning" sits in the SAME tab with
  progress bars + Continue; a course card opens the /learn landing as the
  confirmation/preview screen with Enroll at the bottom. The old mocks remain
  only for the marketing page's decorative peek (noted in lib/data.ts).
- **Creator review:** a minimal "Learner submissions" list on the studio's
  Publish step (student name, text, file links, mark reviewed) —
  view + mark-reviewed only, per scope.
- **Found-by-test fixes:** unanswered questions no longer try to insert a null
  response row; the landing's "Continue" fallback no longer masks course
  completion; `question_responses.question_id` corrected to text (question ids
  are jsonb-embedded short ids, not row UUIDs).

## Snapshot publishing — versions, slugs, answer-key stripping (Milestone 1), 2026-07-02

The first piece of the publishing/analytics phase: a course can now go LIVE as an
**immutable snapshot** while the draft stays freely editable. Verified by
**`npm run verify:publish` (59 pure checks)** + **`npm run verify:publish:int`
(50 checks against live Supabase — full RLS matrix)**, plus build/lint/tsc and all
existing suites green (`verify:ai` 257, `verify:ai:int` 143, `verify:slides`,
`verify:video` 154, `verify:reject`, `verify:imports` 72, `verify:course-agent` 78).

- **Schema (migration `20260702020000_publishing` + `20260702020100`):**
  `course_publications` (versioned jsonb snapshots; slug + `previous_slugs` for
  redirect-safe renames; `content_hash`; persisted `linter_report`; partial unique
  indexes = one live per course, one live per slug), `quiz_answer_keys` (RLS enabled
  with **zero policies** — no client role can ever read it; verified even the author's
  client gets nothing while the service role sees the keys), `enrollments`
  (course-level; student-owned rows; insert gated on a live publication via
  `private.has_live_publication`). A **BEFORE UPDATE trigger makes publications
  immutable in the DB** (snapshot/version/hash can never change), and there is **no
  insert policy** — publishing only happens through the SECURITY DEFINER
  **`publish_course` RPC**, the one transaction that verifies authorship, locks the
  course row, bumps the version, retires the previous live row, inserts the
  publication + answer keys, and mirrors `courses.status`.
- **Snapshot pipeline (`lib/course/publish/*`, Zod-first, types inferred):**
  `snapshot.ts` builds the denormalized document with **node IDs preserved verbatim**
  (progress/analytics stay joinable across versions) and strips every quiz's correct
  answers/accepted answers/explanations into per-block keys; the published-quiz Zod
  schema is **strict**, so an unstripped question fails validation, and a deep
  `findAnswerKeyLeaks` scan runs before every publish as belt-and-braces. `hash.ts` =
  sorted-key stable stringify + WebCrypto SHA-256 (identical bytes in Node and the
  browser). `preflight.ts` = publish gate (errors block: untitled / no content /
  ungradable quiz questions; warnings overridable: empty lessons, pending AI images,
  unprocessed decks/videos, aggregated slide lint). `diff.ts` = concise
  added/changed/removed lesson+block counts via per-node hashing. `service.ts` =
  status/publish/settings orchestration shared by the API route and the integration
  test; an identical republish is detected by hash and does NOT bump the version.
- **API (`/api/publish`, user-scoped client, RLS end-to-end):** GET status
  (publication + preflight + draft-vs-live diff), POST publish (422 + report on
  pre-flight errors), PATCH unpublish / restore / set_slug / set_visibility.
- **Studio UI:** `PublishPanel` is real now — publication card (Live/Unpublished ·
  version · visibility · published-at), the public `/learn/{slug}` URL with copy/open/
  rename, a **live "unpublished draft changes" indicator** (the same snapshot+hash code
  runs client-side against the store doc as you edit), live pre-flight card, a review
  step with the diff summary + first-publish slug/visibility pickers + an explicit
  warnings acknowledgement, republish/unpublish/restore. The header **Publish** button
  (previously a no-op) now opens the step.
- **Slug model:** chosen at first publish (from the title, collision-suffixed against
  live slugs), stable across versions, renameable later — old slugs ride
  `previous_slugs` + historical rows so redirects stay resolvable. Uniqueness is
  enforced as "one live publication per slug" (deliberate deviation from a globally
  unique column, which would forbid v2 reusing v1's slug).
- **Learners are versioned-pinned by design:** editing the draft after publishing
  provably does not alter the published snapshot (asserted byte-for-byte in the
  integration test), and every future analytics event will carry
  `publication_id` + version.

## Video captions/transcripts (Mux auto-generated) + filmstrip trim, 2026-07-02

Two educator-side additions to the video block. Verified by **`npm run verify:video`
(153 checks, was 111)** + `npm run lint` + `tsc --noEmit`, other suites green
(`verify:ai` 28, `verify:reject` 17). Runtime deps unchanged (**still 14** — captions
render on the existing native `<video>` via a synced overlay, NOT Mux Player).

- **Auto-generated English captions by default.** `create-upload` requests
  `new_asset_settings.inputs[0].generated_subtitles` (the direct-upload shape omits the
  input `url` — verified against Mux docs). Generation is asynchronous and never blocks
  playback. Detected by the poll AND the **`video.asset.track.ready`** webhook (fixed
  `parseWebhookEvent` to route a track event by `data.asset_id`, since `data.id` is the
  track id). An on-demand **`/api/video/mux/generate-captions`** route (provider
  `requestGeneratedSubtitles`) covers pre-existing videos + retries.
- **Caption state + transcript.** New `video_assets` columns (migration `20260702010000`):
  `caption_status`/`caption_track_id`/`_name`/`_language_code`/`_source`/`_error` +
  `transcript`/`transcript_vtt`/`transcript_updated_at`. Caption METADATA is mirrored to
  the block (`VideoLessonBlock.captions`) through the validated `UPDATE_VIDEO_LESSON`
  patch; the transcript text stays on the row (kept off the course doc). Once a track is
  ready, `syncVideoAssetFromMux` fetches the public WebVTT and derives a plain transcript
  (`lib/video/captions.ts`) — the hook for future AI (summaries/chapters/quizzes).
- **Caption UI.** `VideoPreviewPlayer` gets a CC toggle + a synced caption overlay
  (respects the trim window); the manage panel gets a **Captions & transcript** section
  (Not requested / Generating / Ready / Failed + generate/retry + a read-only transcript
  preview). Extension points left clean: manual correction, WebVTT export, translations,
  re-uploaded tracks, transcript editing.
- **Filmstrip trim UI.** `VideoTrimEditor` rewritten from two sliders into an Apple-Photos
  double-ended **filmstrip** — a thumbnail strip (Mux image API for a ready asset, canvas
  frame-capture for a local clip) with draggable start/end handles that **seek the preview
  to the cut frame**. Commits on release. "Done trimming" → a filled brand **"Save changes"**.

## Video lessons — educator recording/upload block (Mux), 2026-07-01

A new first-class **`video` block**: educators record (camera / screen / screen+camera)
with browser-native APIs or upload a file, it's hosted by **Mux**, and it plays back in
the studio with non-destructive trim. Educator-side only for now (no student player yet).
Verified by **`npm run verify:video` (91 checks)** + `npm run build` + `npm run lint`,
all other suites green. Runtime deps unchanged (14) — playback is a native `<video>` on a
Mux MP4 static rendition, so no player library was added.

- **Document model:** `VideoLessonBlock` (`types.ts`) — `asset` (Mux ids + status +
  duration/aspect/thumb, NEVER bytes), `recording` (mode/layout/bubble/mic), `edit`
  (trim), `settings`. Added to the `BlockType` union, `LessonBlockSchema` (Zod), the
  `UPDATE_VIDEO_LESSON` patch (schema + reducer, the ONLY way the block changes),
  `factories`/`commands`/`manifest`. Persistence is free (the block payload rides in
  `blocks.content` jsonb; migration only widens the `blocks.type` CHECK).
- **`video_assets` table** (migration `20260701010000`, RLS author-only via
  `private.is_course_author`) is the source of truth for Mux status; the block mirrors a
  snapshot for instant render (exactly like `imported_deck` mirrors `deck_imports`). No
  storage bucket — Mux hosts the media; the recording uploads DIRECTLY to a Mux
  direct-upload URL (never through our server).
- **Provider seam** (`lib/video/provider/*`): a `VideoProvider` interface + a fetch-based
  Mux adapter (Basic auth + `node:crypto` webhook HMAC — no Mux SDK, one file). Service /
  status / access / URL layers in `lib/video/*` are pure + testable.
- **Routes** (`app/api/video/*`, Node runtime): `mux/create-upload`, `mux/asset-status`
  (client poll), `mux/webhook` (signed, admin-client, re-fetches the asset for
  robustness), and `[id]` DELETE (Mux + row cleanup). Secrets are server-only.
- **UI** (`components/editor/lesson/video/*`): `useVideoRecorder` (device enumeration,
  camera/screen capture, **canvas compositing** of screen + webcam bubble, MediaRecorder
  state machine, countdown, mic meter, pause/resume, deterministic track teardown),
  `useVideoUpload` (create → PUT with progress → status), `useVideoAsset` (poll + mirror),
  and the `VideoStudioModal` (mode → setup → record → review → upload; plus a manage/edit
  screen for a ready video) + the block card (empty / processing / ready-with-inline-player
  / failed). Friendly error states for every permission/hardware/support/upload failure.
- **New env:** `MUX_TOKEN_ID` + `MUX_TOKEN_SECRET` (server-only), optional
  `MUX_WEBHOOK_SIGNING_SECRET`; reuses the existing `SUPABASE_SERVICE_ROLE_KEY` for the
  webhook. Optional client `NEXT_PUBLIC_MUX_DATA_ENV_KEY` is a deferred extension point.

## Structure agent — repair/complete an EXISTING module (routing follow-up), 2026-07-01

A real prompt — *"currently module one is very unfinished, doesn't have title, has
empty slides, can you please complete it… intro econ class…"* — still created a NEW
`Module 8: Introduction to Economics…` instead of repairing **Module 1** in place,
and the review bar showed Slide/Content but no Structure. Root cause: the structure
short-circuits caught only delete/add/recreate/rename/move/reorder — NOT
repair/complete/fill phrases — so it fell to the classifier, which picked
`generate_module`. Fixed end-to-end; verified by **`npm run verify:course-agent`
(78 checks, +15)**, all other suites green.

- **Routing** (`lib/ai/intent.ts`): a new short-circuit BEFORE `MODULE_BUILD` —
  "complete / finish / fix / fill out / flesh out / improve" + an EXISTING-module
  reference (ordinal / "Module N" / "module one" / "first/current/this module"), OR a
  module described as "unfinished / incomplete / empty / missing a title / has empty
  slides", OR "make/turn Module N into …" → `structure`. An explicit "new / another
  module" opts back out (stays `generate_module`). `CLASSIFY_SYSTEM` rewritten:
  structure now includes *repairing/completing/filling an existing* module/lesson, and
  prefers structure over generate_module whenever an existing module is referenced.
- **`rename_module` op** (new): the structure vocabulary had no way to set a module's
  title — so "doesn't have a title" couldn't be satisfied. Added to the op union, the
  plan schema, the executor (`UPDATE_TEXT` kind:module), and validation; `diffStructure`
  already detects a module rename, so it stages + reverts for free.
- **Word/ordinal module resolution** (`targetResolution.ts`): `resolveModule` only
  handled digits — so "module one" / "the first module" / "the last module" resolved to
  *unsafe* and the repair was refused even after routing. Now resolves word numbers
  (one…ten) and ordinals (first/last).
- **Validation** (`structureValidation.ts`): a `wantsRepairModule` signal + a rule —
  repair stays IN the resolved module (rename it, touch its lessons, or regenerate its
  empty decks), never a foreign/new module.
- **Planner prompt** (`structurePlan.ts`): teaches repair-in-place; the snapshot now
  flags an untitled module (`⚠ NO TITLE`) so the model sets a title.
- **Edit-loop prompt softened** (`context.ts`): outline changes are the Structure path's
  job; the general edit loop must not create a new module/lesson (or duplicate a
  referenced one) unless explicitly asked this turn.
- **Guards + instrumentation** (`phases.ts`): a hard assert that a structure turn can
  NEVER increase the module count (it aborts + errors if it somehow does), plus
  `agent_route` (mode + module count + message head) and `agent_structure_turn`
  (intent, module count before/after, ops) logs so a mis-route is greppable.

## Course Structure agent — accurate lesson/module editing, 2026-07-01

The docked Content Agent treated COURSE-STRUCTURE requests as slide generation:
"Add a lesson to Module 3" built a deck in the **currently-docked** lesson (never
creating a lesson in Module 3); "delete the empty lessons" filled them; "recreate
Module 1" made a duplicate `Module 10: Module 1…`. A new **Course Structure agent
layer** makes the wrong CATEGORY of action hard or impossible — through tools,
routing, and HARD validation, not prompt text alone. Verified: `npx tsc --noEmit`
+ `npm run lint` (0 errors) + `npm run build` + **`npm run verify:course-agent`
(63 checks)**; the existing `verify:ai` / `verify:ai:int` (**143**) /
`verify:reject` (17) / `verify:slides` suites stay green.

- **Routing fix** (`lib/ai/intent.ts`): a 4th mode `structure`. The old
  `LESSON_INTO_MODULE` regex that sent "add a lesson to Module X" → `generate_lesson`
  (the bug) now routes to `structure`; "delete the empty lessons" + delete/recreate/
  rename/move/reorder of a lesson|module route there too (checked BEFORE the
  module/lesson content-build short-circuits). The classifier gained `structure`.
- **The agent** (`lib/ai/phases.ts` `runStructureAgentTurn`): PLAN a structured
  `CourseStructurePlan` (JSON) → HARD-validate it against the message's detected
  SIGNALS + a deterministic `CourseOutlineSnapshot` (a request can COMBINE actions,
  e.g. delete-empty + add) → execute the ops through the validated CoursePatch
  pipeline → persist via the **full reconcile** (the scoped agent reconcile never
  deletes/moves/renames an existing node) → stage a reviewable **structure
  change-set** → for each lesson the plan asks to (re)build, chain the existing
  PLAN→GENERATE deck pipeline. Ambiguous / unsafe targets become a clarification,
  never a guess. There is deliberately **no create_module op**, so "recreate Module
  1" can't mint a duplicate module — the bug is impossible by type.
- **Pure core** (`lib/ai/courseStructure/*`): `outlineSnapshot.ts` (the snapshot +
  a deterministic `isLessonEmpty`), `targetResolution.ts` (clear | ambiguous |
  unsafe — never a numeric confidence), `structurePlan.ts` (the model schema +
  "you are a course editor, not a slide generator" prompt), `structureValidation.ts`
  (the rule table: add ⇒ create_lesson; delete-empty ⇒ delete ONLY empty lessons;
  recreate ⇒ stay in the resolved module; every id must exist), `structureTools.ts`
  (emptiness + plan execution). New AI-callable tools `rename_lesson` / `move_lesson`
  + a `list_course_outline` read.
- **Full structural change-set** (migration `20260701000000`, applied live + types
  regenerated): `change_set_items` gained `node_type` ('block'|'lesson'|'module') +
  `node_id`, `block_id` made nullable, an identity CHECK. `diffStructure` records
  module/lesson create/rename/move/delete; `revertChangeSet` inverts them in
  dependency order (re-add parents before children; a deleted module restores its
  whole subtree byte-for-byte); a created/deleted node OWNS its subtree snapshot so
  blocks/lessons aren't double-staged. Block path stays byte-compatible.
- **Grouped review** (`AgentPanel`): the review bar now buckets pending changes into
  **Structure · Slide · Content** so structural edits are never buried in "N changes";
  created/renamed/moved lessons + modules get an amber pending-highlight in the
  outline sidebar (`getPendingNodes` → `hydratePendingNodes` → `usePendingNodeChangeSetId`),
  and Reject restores the previous structure.
- **Latent bug fixed along the way:** the existing AI `delete_module`/`delete_lesson`
  CONFIRM path applied the delete in memory but **never persisted it** (the scoped
  reconcile can't delete + it re-baselined to the post-delete doc). `resumeAgentTurn`
  now persists a confirmed delete via the full reconcile.

## Imported decks (PPT / PPTX / PDF) — upload + rail viewer, 2026-06-29

Educators can now bring an existing presentation into a lesson as a **slide deck**
without converting it to native editable slides. The "Slide deck" item in the
Add-block menu opens a **secondary chooser** — *Create new deck* (the unchanged
native flow), *Import existing deck* (upload), and a schema-ready, disabled
*Import from Google Slides* — so the user-facing category stays unified while the
internals fork. Verified: `npx tsc --noEmit` + `npm run lint` (0 errors) +
`npm run build` (all 5 routes register) + **`npm run verify:imports` (72 checks)**;
the existing `verify:ai` (28) / `verify:slides` (95) suites stay green.

**Option B — a new `imported_deck` block type** (a sibling of `slide_deck`, NOT a
mode flag on it). The Zod block union discriminates on `type`, so a new branch is
the established way to extend it and the native slide editor is untouched. The
block content is a denormalized snapshot keyed by `deckImportId`; it carries **no
storage paths** (those stay server-side, handed out only as signed URLs).

- **DB** (`supabase/migrations/20260629000000_deck_imports.sql`, applied live +
  types regenerated): `imported_deck` added to the `blocks.type` CHECK;
  `deck_imports` + `deck_import_pages` tables (RLS via `private.is_course_author` /
  a new `private.is_deck_import_author`); a **private** `deck-imports` storage
  bucket with owner-folder RLS. `lesson_id`/`block_id` are FK-free (the row is
  created before the block, and autosave churns block rows). The course autosave
  reconcile only touches modules/lessons/blocks, so the new tables are never
  orphan-deleted.
- **Service layer** (`lib/course/imports/*`, pure where possible):
  `deckImportValidation` (extension/MIME agreement — client MIME is never trusted
  alone — size bounds, filename sanitize, the status state machine),
  `deckImportStorage` (owner-first path builders + **signed-URL-only** access; there
  is no `getPublicUrl` call), `deckImportAccess` (auth + ownership guards),
  `deckImportService` (CRUD + the row→client `View` that mints signed page URLs),
  `deckImportJobs` (the enqueue/claim seam).
- **API** (`app/api/deck-imports/*`, Node runtime): `upload` (multipart → validate →
  store original privately → row → enqueue), `[id]` GET (live status + signed pages)
  / DELETE, `[id]/retry`, `[id]/replace`, `[id]/original` (signed download). Auth +
  course-ownership enforced on every route.
- **Worker** (`workers/deck-import/*` + `npm run worker:deck-imports`): a
  worker-compatible `processDeckImport(id)` that normalizes to PDF (LibreOffice
  headless), renders pages to PNG + thumbnails (Poppler `pdftoppm`), uploads
  artifacts, writes page rows, and marks `ready`/`failed`. **Heavy conversion never
  runs in a request handler** (the route only enqueues). Missing system binaries
  fail gracefully (friendly "preview tools unavailable" → `failed`, app stays up).
  Dockerfile + README document the system packages and the production-queue TODO.
- **UI** (`components/editor/lesson/*`): the `AddSlideDeckChoice` chooser, a
  drag-or-browse `DeckUploadButton` with a real progress bar, and the block surface
  — `ImportedDeckProcessingCard` (intentional shimmer), `ImportedDeckFailedCard`
  (calm retry/replace/download), and the custom `ImportedDeckViewer`: large central
  slide, vertical thumbnail rail (horizontal on narrow screens), prev/next +
  keyboard nav, page indicator, fullscreen (`ImportedDeckFullscreen`), signed-URL
  loading skeletons, graceful missing-page fallback. `useDeckImport` polls while
  processing and re-signs URLs on demand. No browser PDF chrome, no open-in-new-tab.

**Verification notes — works now:** end-to-end upload → private storage → row →
block insert → processing card → (worker) → ready rail viewer; retry, replace,
download-original, and delete (with storage cleanup); the native deck path is
unchanged; Google/OneDrive `source_type` + `source_external_id` are schema-ready.
**Remaining for production:** run the worker as a deployed service/container with
`SUPABASE_SERVICE_ROLE_KEY` + LibreOffice/Poppler installed; swap the poll-based
`enqueueDeckImportJob`/`claimProcessingDeckImports` for a durable queue and add a
worker lease for >1 worker (both documented in `workers/deck-import/README.md`); a
Playwright pixel pass on the viewer; and the actual Google Drive OAuth/Picker
(only the schema is in place here).

## The "missing content" rejection loop — DECISIVE fix (agent-null coercion), 2026-06-24

Proven from `slide_reject` logs (lesson b240a404): the slides were NOT missing
content — they were fully authored and rejected on rich-text **envelope
technicalities**. The agent emits `null` for an absent optional field (`runs: null`
for "no inline formatting", `marks: null`, `icon: null`, `detail: null`,
`example: null`, …) but the schema wanted `[]` / `{}` / absent. 7 of 8 slides per
lesson bounced this way and re-looped. Suites green (`verify:ai` · `verify:ai:int`
· `verify:visuals`) + tsc/lint/build.

- **`normalizeAgentNulls` (`lib/course/slide/clampStructured.ts`)** — a pure,
  recursive, LOSSLESS coercion run at the structured-slide tool boundary
  (`bestEffortTemplate`, so batch / set / add all get it): `runs: null → []`,
  `marks: null → {}`, and any OTHER null key → deleted (the agent's "absent"). `null`
  carries no content, so this changes encoding, never text. A genuinely-missing
  REQUIRED field still surfaces as a real error (an empty slide is never saved blank).
- **Schema tolerance (belt-and-suspenders, `structuredLayouts.ts`)** — the AI-input
  `rich()` slot's `runs` and a run's `marks` now `.nullish().transform(→ undefined)`,
  so a null can never hard-reject a slide even if the coercion is bypassed.
- **Cause 2 (diagram, secondary)** — `readDiagramFields` now reads a rich-text
  ENVELOPE (`{ text }`) as well as a plain string for title/caption/takeaways, so a
  diagram whose explanatory prose rides in `caption` isn't read as empty (which left
  `body` blank → a false `content.body.text: Too small` → the prose degrade now fills
  body from the caption sibling; no re-send loop).
- **Prompt nudge** — the GENERATE teaching bar now states: send `runs: []` (not null)
  when there's no formatting, `marks: {}` inside a run, and fill every required text
  field of the chosen layout.
- Safety nets kept: the per-spec re-send cap (`MAX_SPEC_BUILD_ATTEMPTS`) + the
  `slide_reject` / `authoring_turn` instrumentation (behind `AI_DEBUG_AGENT`).
- Tests: `verify-richtext-coercion.ts` reconstructs the ACTUAL log payloads (s1
  section_break, s2 comparison_columns with deep null runs/icon/detail, the diagram
  envelope) and asserts they build with text preserved byte-for-byte; the full
  8-slide log batch now builds `generated == planned (8/8)`; a genuinely-empty slide
  is still rejected.

## Content-agent reliability — scoped GENERATE input, plan-reasoning fix, hard transport deadline, resumable module loop, 2026-06-23

A multi-front fix grounded in server logs (checkpoint `01b49cc`). Suites green
(`verify:ai` · `verify:ai:int` · `verify:visuals`) + `tsc`/lint/`build`.

- **FIX 1 — GENERATE/REPAIR input is now SCOPED, so the plan can't be lost.** The
  driven authoring loop (`runConversationLoop`, `scopedInput`) no longer loads the
  conversation transcript at all (it had grown to ~854 messages for a module build,
  burying the plan and leaving the author working from a ~1.1K-char summary →
  `covered:0`). Each turn is rebuilt FROM SCRATCH out of: the system prompt + the full
  structured PLAN verbatim (in the developer context message) + the deterministic
  GenerationState (built / remaining specs) + this run's own tool I/O. New
  `buildScopedAgentInput` (`historyPolicy.ts`); there's nothing to compact, so the
  plan is present, intact, every turn. New log `agent_input_scoped`.
- **FIX 1.3 — slideSpecId stamping is GUARANTEED.** `add_structured_slides_batch`
  receives the plan's ordered spec ids (`ToolContext.planSpecIds`) and stamps each new
  slide with the model's id when it's a valid unclaimed plan spec, else the NEXT
  unclaimed spec in plan order — so `generated N / covered 0 / extra N` is impossible
  when slides correspond to specs. The edit path (no plan) is unchanged.
- **FIX 2 — no author-directive ever renders as slide content.** The diagram→prose
  degrade (`proseDegradeTemplate`) now builds the body ONLY from the model's real
  caption / takeaways, NEVER the `pedagogicalPurpose` / `altText` (author directives —
  the "Key idea: Show a concrete …" leak); a request with no real content fails to
  build (reported back) instead of authoring a directive. A plan slide spec that comes
  back "couldn't build (missing content)" twice is ABANDONED by the coverage driver
  (surfaced in the checkpoint) instead of spinning to the turn cap.
- **FIX 3 — a call can no longer exceed its timeout, and a lesson death can't kill a
  module.** `withTimeoutSignal` (`providers/openai.ts`) wires a real AbortController to
  the fetch (the SDK `timeout` was silently ignored by the proxied undici fetch — plan
  calls ran 11–18 min on a configured 180s); the ProxyAgent gets `connect` /
  `headersTimeout` / `bodyTimeout` ceilings; plan `maxRetries` drops to 1 (no 5× dead-
  socket retry); plan calls STREAM (keep the socket active). The module loop retries a
  lesson's rich plan ONCE with backoff on a transport death, else skips + surfaces it;
  each completed lesson is flushed immediately, and a partial module is never reported
  complete.
- **Lesson-plan reasoning runaway — the STRUCTURAL fix (not a cap).** Diagnosed from
  the logs: input was flat (~4.4K, cached), but output/reasoning ballooned 2.9K→23.5K /
  0.5K→20.7K across a module's lessons (latency 21s→11.5min→dead). Cause = the per-call
  reasoning burden, not accumulation. Fixes: lesson-plan effort **high→medium**; the
  SPLIT decision is now a **deterministic code rule** (`splitOverflowingSpecs`) instead
  of model reasoning, and `continuationOf` + `requiredElements` are **removed from the
  strict output schema** (fewer constrained fields per slide = far less reasoning to
  satisfy it); the numeric slide-count target is softened to depth-driven. The 16K
  output budget + the 180s hard deadline are SAFEGUARDS, not the cure.

## Method 1 — content-first planning + split-at-plan-time, 2026-06-23

The PLAN now finalizes a slide's CONTENT before its layout, and splits an
overflowing slide into two at plan time (no truncation, ever). Builds on commit
`48a92a2`. Suites green (`verify:ai` 181 · `verify:ai:int` 113 · `verify:visuals`
93 · `verify:slides` · `verify:reject`) + `tsc`/lint/`build`.

- **Content-first slide spec.** `SlideSpecSchema` (`lib/ai/outline.ts`) is reordered
  so `keyPoints` (the slide's finalized real content) precedes `layout`, and the
  prompt makes the model FINALIZE the points first, then pick the structured layout
  whose shape FITS them (and vary layouts across the deck) — instead of choosing a
  layout and hoping content fits. One plan pass, no extra round-trip.
- **Split decision at plan time (no truncation).** When a slide's points would
  genuinely overflow one card (cards auto-grow, so only real overflow), the model
  SPLITS into two slides rather than cram or drop any point:
  - **Continuation** (one idea, more points than a card holds): a new
    `continuationOf` field links the second slide to its parent; `normalizeContinuations`
    in `coerceOutline` stamps its title with " (cont.)" off the parent's base title and
    drops any point it repeats verbatim from the parent (an exact dup is not info — it
    lives on the parent), preserving every UNIQUE point. The GENERATE prompt has it
    carry the parent heading + a "continuing from …" cue and author ONLY its own points.
  - **Sub-topic split** (the points are two distinct sub-ideas): two slides with
    distinct descriptive titles ("Causes of X" / "Effects of X"), preferred over a bare
    continuation when the points naturally group.
- **Coverage unchanged.** A continuation is its own slide spec, so it counts toward
  coverage (no fit/repair loop reintroduced); GENERATE just fills the plan-assigned
  layout. `isContinuationSlide` exposes the relationship; the "(cont.)" title is the
  renderer's visual cue.
- Tests: `verify-outline.ts` (content-first field order, continuation stamp + dedup +
  zero-info-loss, sub-topic distinct titles, deck layout variety) and a `verify:ai:int`
  end-to-end split (plan card shows the normalized split; approving builds both slides,
  coverage passes, no repair).

## Stretching, fewer model calls, lighter validation, 2026-06-22

Adopt Gamma-style stretching (within the fixed 16:9 frame), kill the remaining
reject-retry loops, drop fit-driven validation, and cut redundant model calls —
without losing slide completeness. Revert point: commit `bcf3ff6`. Suites green
(`verify:ai` 170 · `verify:ai:int` 107 · `verify:visuals` 85 · `verify:slides`
incl. the new `verify:stretch` 19 · `verify:reject`) + `tsc`/lint/`build`.

- **STRETCHING — containers grow to fit (within the 16:9 frame).** The structured
  layouts were absolute-positioned boxes with `overflow:hidden` that CLIPPED heavy
  content. The clip-prone ones (`concept_example`, `comparison_columns`,
  `comparison_matrix`, `outline_list`, `prose`) are now FLOW layouts — a flex column
  (header → body that grows → footer); columns grow independently and stretch to the
  taller; the matrix grid uses content-sized (`auto`) rows; `outline_list` items flow
  in a column; `code_walkthrough` scales its font to the line count. No text container
  clips; the only guard kept is the existing horizontal break-word on long strings.
  (The user chose "fit within the fixed frame" over a variable-height-canvas rewrite.)
- **No more reject-retry.** Single-slide tools (`add_structured_slide`/
  `set_structured_slide`) now CLAMP like the batch (lenient + `clampStructuredTemplate`)
  — an over-long slot auto-shortens and saves, never bounces. **Diagrams** were the
  last reshape-and-retry path: `add_diagram`/`set_diagram` (and a `diagram` entry in the
  batch) are now best-effort — `lib/course/diagram/repair.ts` `repairDiagram`/
  `coerceDiagramBestEffort` fix the off invariants (slope, sort, dangling edges, missing
  weights) or fall back to a topic-matched template / minimal seed, so a malformed
  diagram is ACCEPTED + rendered, never bounced. The garbled "Had to reshape the make
  that change and retry" string is fixed (proper tool nouns; natural fallback).
- **Keep coverage, drop fit.** Repair now ONLY fills a genuinely MISSING slide spec or
  required quiz/homework block (`hasModelRepairableFailure`); a complete deck SKIPS
  repair. Duplicate specs + a missing recommended visual are now SOFT (reported, never
  repaired) — `ok` is computed from the hard-failure set only (`HARD_FAILURE_CODES`).
- **Cut calls / reuse data.** GENERATE/REPAIR can't re-fetch the course context /
  module list / lesson list (excluded from the toolset — they ride in the context +
  generation-state). The teaching bar now authors ALL of a lesson's slides in ONE
  `add_structured_slides_batch` (cap raised 4→24), not one segment per turn. REPAIR
  drops to MEDIUM effort (`AI_PHASE_MODELS.repair`); PLAN + the creative initial
  authoring stay high.
- **Concise authoring kept in the prompt.** Stretching removes crashes, not bloat —
  the teaching bar now says cards GROW to fit but to still write tight, scannable cards
  (short headings, 1–2-sentence bodies), putting depth across more slides.

## AI agent — strictness death-spiral fix, flush-on-exit, stop & live render, 2026-06-22

A second reliability pass. A module-generation run had spun for **10+ minutes and
persisted nothing** — the module had no data and the agent couldn't see it on a
follow-up turn. Root cause was a strictness death-spiral (valid slides rejected for
formatting → phantom coverage gaps → endless repair) compounded by **all persistence
happening once at the very end** (a kill before that lost everything). Fixed with
targeted changes; suites green (`npm run verify:ai` 170 · `verify:ai:int` 99 ·
`verify:visuals` 84 · `verify:slides` · `verify:reject`) + `tsc`/lint/`build`.

- **Clamp, don't reject (the death-spiral fix).** `add_structured_slides_batch` no
  longer bounces an over-length slot back to the model. A new schema-driven
  `clampStructuredTemplate` (`lib/course/slide/clampStructured.ts`) auto-shortens any
  over-length string / over-count array to its cap, **saves the slide**, and attaches
  a non-blocking `autoShortened` note. Only a slide MISSING required content (which
  clamping can't invent) comes back — so a valid slide can never be dropped for
  formatting, and "Added 0 slides" can't happen when any slide is valid.
  (`lib/ai/tools/structuredSlides.ts`.)
- **Coverage = a SAVED slide.** Because clamped slides save (stamped with their
  specId), coverage closes and REPAIR stops — no phantom gaps. Coverage is the
  saved-slide delta; a pass that saves zero new slides trips the no-progress guard
  rather than another repair pass.
- **No hard slide-count cap.** The PLAN's spec list is the length target. The
  `coerceOutline`/skeleton caps were raised to runaway-only safety rails
  (`MAX_LESSON_SLIDES` 14→40, `MAX_LESSON_SEGMENTS` 6→16, `MAX_MODULE_LESSONS` 8→20)
  so a legitimately long lesson/module is never truncated; token budget + the turn
  cap remain the operative limits. (`lib/ai/outline.ts`.)
- **REPAIR doesn't re-read the world.** The GENERATE/REPAIR toolset now excludes
  `get_course_context` / `list_modules` / `list_lessons` / `get_lesson` — the course,
  lesson, plan and authored-so-far set are already carried in the context message +
  generation-state every turn, so repair stops burning turns re-reading them.
  (`lib/ai/tools/index.ts`.)
- **Flush-on-exit — never discard partial work.** The lesson/module pipelines now
  reconcile to the DB **incrementally** (each authored batch persists at the turn it
  lands, via the driven loop; each lesson persists as it completes) and stage the
  change-set in a guarded `finalize()` that runs on **every** termination — completion,
  token cap, turn cap, no-progress guard, user Stop, or a thrown error. The module
  scaffold is persisted the instant it's planned, so a build that's killed mid-run
  still leaves the module + its built lessons in the DB (the "Module 5 has no data"
  fix). `reconcileAndStage` was split into a repeatable `reconcileDoc` + a one-shot
  `stageChangeSet`. Still ONE change-set per run. (`lib/ai/agentLoop.ts`,
  `lib/ai/phases.ts`.)
- **Stop button.** While a run streams, the composer's send arrow becomes a stop
  square; it aborts the request via an `AbortController`. The server sees the
  connection signal between tool turns, runs flush-on-exit, and returns cleanly; the
  input is freed for the next message. (`components/editor/agent/{AgentPanel,useAgentStream}.tsx`.)
- **Live rendering + autosave coordination.** A new `agentRunActive` flag pauses the
  browser autosave for the duration of a run (the agent persists server-side; a
  competing full-snapshot would race the reconcile and could orphan rows — the known
  hazard), and a debounced `scheduleLiveSync` (`lib/editor/liveSync.ts`) re-loads the
  doc into the editor via `syncLiveDoc` (no full re-hydrate — undo/selection intact),
  so the deck fills in as the agent authors it. A Supabase **Realtime** subscription
  on the staging table (`change_set_items`, `lib/editor/useChangeSetRealtime.ts` +
  migration `20260622010000_realtime_change_set_items.sql`) drives the same re-sync;
  it degrades gracefully if the publication isn't enabled. An **"Accept what's here"**
  affordance (the review bar's accept button while generating) lets the user gate out
  of a long repair loop early.
- **Investigation — the agent is NOT scope-limited.** The "I only have access to the
  current lesson" claim was a downstream effect of the data loss above, not a real
  scope limit: `runContentAgentTurn` loads the whole course tree, the edit path has
  the full structural toolset (`list_modules`/`create_module`/`create_lesson`), and
  `classifyIntent` already routes "build module N" → `generate_module`. So acting on
  an existing populated module works; only the empty/missing module failed. No scope
  changes made — the data-loss fix resolves it.

## AI slide generation — reliability, arc & live AI images, 2026-06-22

The big quality fix. Decks were coming out **incomplete** (a 10-slide plan shipped
3 slides — "Supply and equilibrium" never reached equilibrium), **inconsistent**
(one deck opened on a title, another cold-opened on a HOOK), and **visually
sparse**. Root cause was architectural, not prompting. Fixed across six
workstreams; all suites green (`npm run verify:ai` 162 · `verify:ai:int` 87 ·
`verify:slides` · `verify:visuals` 84 · `verify:reject`) + `tsc`/lint/`build`.

- **Coverage-driven GENERATE/REPAIR controller** (`lib/ai/agentLoop.ts`,
  `lib/ai/phases.ts`). The loop used to **stop the instant the model returned a
  no-tool-call turn** — a small model that "felt done" at 3/10 ended generation
  there, and a separate cold-start repair (capped 2×6 turns) burned ~3 min without
  catching up. GENERATE/REPAIR now opt into `driveToCoverage`: after each turn the
  loop computes plan coverage from the deterministic generation-state, and while
  specs remain it **injects a concrete "STILL TO BUILD …" nudge and keeps building**
  (turns scaled to the plan: `coverageMaxTurns`/`repairMaxTurns`). A **no-progress
  guard** (`AGENT_NO_PROGRESS_LIMIT`, 3) stops a stalled run instead of spinning.
  The driven loops no longer emit their own checkpoint — the validate/repair
  pipeline owns the ONE authoritative end-of-run checkpoint. Repair passes raised
  2→4 (`AI_MAX_REPAIR_PASSES`); the shared call budget 64→200 so module lessons
  don't starve.
- **High-effort authoring.** GENERATE/REPAIR default to **`high`** reasoning effort
  (was medium) with a generous `AI_GENERATE_MAX_OUTPUT_TOKENS` (24k) — the hardest
  phase finally gets the horsepower PLAN already had. (`lib/ai/modelConfig.ts`.)
- **Partial-success batch tool.** `add_structured_slides_batch` was all-or-nothing
  — one over-long slot rejected the WHOLE batch ("Had to reshape the slide layout
  and retry" churn). It's now `lenientArgs` (validates each slide in `execute`):
  every valid slide is SAVED and only the failures come back (with the exact slot)
  to re-send. The model schema stays strict. (`lib/ai/tools/{types,index,structuredSlides}.ts`.)
- **Title-opener + recap-closer arc.** Every full (non-micro) lesson now opens with
  a titled `section_break` and closes with a `recap`. The PLAN prompt asks for it;
  `ensureLessonArc` guarantees it in the pipeline AFTER the depth-floor re-ask (so
  the floor still measures the model's real content) and BEFORE approval — it
  prepends/appends the specs, re-ids, and re-derives segments (idempotent;
  `coerceOutline` stays pure). (`lib/ai/outline.ts`, `lib/ai/phases.ts`.)
- **Visuals, abundant but purposeful.** The planner bar was rewritten — dropped
  *"MOST slides need no visual"*; it now adds a visual wherever a learner would SEE
  the idea better (structure/process/relationship/comparison/timeline/worked
  example), uses `recommended` generously, and reserves `required`+`mustBeAccurate`
  for accuracy-critical diagrams. The GENERATE teaching bar BUILDS recommended
  visuals. `AI_VISUAL_MAX_PER_LESSON` 3→5.
- **AI image generation — now LIVE** (`AI_IMAGE_GENERATION_ENABLED` defaults true).
  For a concept no programmatic diagram fits, the new **`add_image`** tool generates
  an educational illustration (gpt-image-1 via the SAME OpenAI client + proxy:
  `ModelClient.generateImage`), **stores the bytes to the Supabase `course-assets`
  bucket** under the owner's folder (`lib/ai/visuals/storeImage.ts` — public URL on
  the slide, **never a blob/data URL**), and lands it as a first-class
  **`illustration` structured layout** (registry + strict schema + renderer +
  `SlideTemplate` union + dispatch — `IllustrationLayout.tsx`). Accuracy-critical
  figures still go programmatic; image generation is capped per lesson and routed
  through the planner's `visualIntent`, so it's purposeful, not spammy. The tool is
  an injected, side-effectful capability on the tool context (`VisualGenContext`),
  the one impure tool path. The mock provider gains a deterministic `generateImage`
  so the whole path (generate → store → slide) is tested with no key.
- **Tests:** new coverage-driver / no-progress / live-image-path checks in
  `verify-agent-integration.ts`; `ensureLessonArc` + partial-batch + add_image unit
  checks across `verify-outline.ts` / `verify-bounded.ts` / `verify-visuals.ts`;
  the `illustration` layout in `verify-structured-layouts.ts`.

## AI-assisted VISUAL pipeline — programmatic teaching diagrams, 2026-06-20

A visual is a TEACHING OBJECT, not decoration. Added a full visual pipeline whose
LIVE path renders **programmatic diagrams** — typed, deterministic data the
renderer draws as crisp SVG, so a teaching graph is **accurate by construction**
(a supply curve literally slopes up; a Dijkstra graph weights every edge),
editable, accessible, exportable, and persisted with **no blob URLs**. A diagram
is just a renderer-owned **structured slide layout** (`SlideTemplate` with
`layoutId: "diagram"`), so it flows through the EXISTING patch pipeline,
validate→repair loop, change-set staging/reject, and picker — **no new patch
actions, no new storage**. Verification: `npm run verify:visuals` (75 checks,
no key/DB) + `tsc` clean + existing suites green.

- **Diagram model** (`lib/course/diagram/*`, pure): a `DiagramSpec` union of **9
  kinds** — `supply_demand` (+ price ceiling/floor), `coordinate_plot`,
  `bar_chart`, `array_diagram` (two-pointers / sliding window / binary search),
  `tree_diagram`, `graph_diagram` (weighted/Dijkstra), `flowchart`,
  `number_line`, `venn` — plus a `VisualSpec` (pedagogical purpose + alt text +
  the reason it was added) and `DiagramContent` (title + caption + takeaways +
  spec + diagram). STRICT AI Zod schema (`schemas.ts`) with length/count caps and
  a `.superRefine` running the deterministic **`validateDiagram`** correctness
  check; a permissive STORAGE schema so loading never breaks. The AI tree node is
  FIXED-DEPTH (no `z.lazy`) so it inlines into OpenAI-strict JSON with no
  recursive `$ref`. A **template catalog** (`catalog.ts`, 19 named correct
  diagrams across econ/CS/math/business) seeds canonical visuals accurately and
  powers the router's "is there a programmatic template?" match (whole-WORD
  matching — `"bst"` can't match inside `"abstract"`).
- **Renderers** (`components/editor/slide/diagram/*`, pure → SSR/thumbnail/export
  safe): a shared SVG toolkit + 9 deterministic renderers (`DiagramView`) +
  `DiagramLayout` (the `diagram` structured layout — title + SVG + caption +
  optional takeaways column, `role="img"` + alt text + the machine-readable
  `data-ai-component="slide-visual"` envelope from spec §14). Auto-dispatched in
  `StructuredSlide`, auto-listed in the `LayoutPicker` "Structured" section.
- **Planning** (`lib/ai/outline.ts`): `visualIntent` upgraded from a bare string
  to a structured object (`required`/`role`/`reason`/`expectedVisualType`/
  `placement`/`priority`/`mustBeAccurate`) — tolerant coerce accepts the object
  OR a legacy string. The PLAN prompt gained visual-necessity rules (most slides
  need none; require one only when it materially improves teaching) and the old
  "explain drawings in prose" prohibition was REVERSED ("we render accurate
  programmatic diagrams — plan one when conventional").
- **Generation** (`lib/ai/tools/structuredSlides.ts`): `add_diagram` /
  `set_diagram` tools (a `templateId` seeds an accurate canonical diagram, or a
  custom `diagram` validated at the tool boundary); the `diagram` variant is also
  in the structured-slide batch schema. The teaching bar now tells the model to
  draw the picture a concept needs with `add_diagram` (still no AI/stock images,
  no fabricated chart data).
- **Validation/repair** (`lib/ai/validation.ts` + `phases.ts`): a new
  `REQUIRED_VISUAL_MISSING` hard failure — a slide whose plan REQUIRED a visual
  must carry one (accuracy-critical roles demand a real diagram/image; others
  accept any visual layout). The repair brief tells the model exactly which
  slides need a diagram and to prefer a `templateId`. Soft `VISUAL_SKIPPED` lint
  for recommended visuals. Human controls: an inspector **DiagramEditor** (view
  the spec + live validation, edit alt/caption/takeaways, swap template /
  regenerate, per-kind label editing, "make simpler") — change-set Accept/Reject
  already covers a diagram block.
- **Pipeline scaffold** (`lib/ai/visuals/*`): the full router-facing
  `VisualSpec`/`VisualAsset`, the source **router** (programmatic → AI-generated →
  web → manual, by priority), an image-prompt builder, and a flag-gated
  image/web generation seam — all matching the conservative **defaults**
  (`AI_VISUALS_ENABLED=true`, `AI_PROGRAMMATIC_DIAGRAMS_ENABLED=true`,
  `AI_IMAGE_GENERATION_ENABLED=false`, `AI_WEB_IMAGE_SEARCH_ENABLED=false`,
  `AI_VISUAL_VALIDATION_ENABLED=true`). AI image generation + web sourcing are
  Phase 3/5, scaffolded OFF; the programmatic path is the impressive, working one.

## Module SKELETON plan + lazy per-lesson rich planning — kill the module-plan timeout, 2026-06-19

Even after a lean schema + low effort, `generate_module` STILL timed out (~76s,
`rawLength:0`, before any timeout fired) — the model reasoned silently over the
whole-module plan and the connection dropped. Root cause: ONE call was doing two
jobs (unit map + every lesson's teaching contract). Redesigned so the first call
is tiny:

- **MODULE SKELETON → approve → per lesson: RICH plan → GENERATE → VALIDATE/REPAIR.**
  The first call (`ModuleSkeletonSchema`, `lib/ai/outline.ts`) returns only a
  COMPACT lesson MAP — per lesson: title, objective, rationale, prereqs, skills,
  estimatedMinutes, slide-range, suggested blocks, recommend quiz/homework — **no
  per-slide arrays, no speaker notes, no quiz content**. ~2.8 KB schema vs the old
  ~6 KB; returns in seconds. Each lesson's full contract (`LessonOutlineSchema`) is
  planned **LAZILY**, right before that lesson is generated (`runRichLessonPlan`,
  high effort, one small lesson) — so quality is preserved without one giant call.
  A lesson whose rich plan fails is **skipped + reported**; the rest still build,
  and a checkpoint lists what's left (`runGenerateModule` in `lib/ai/phases.ts`).
- **Ultra-lean FALLBACK** (`ModuleFallbackSchema`: title/objective per lesson + a
  count, no nested arrays): if the skeleton call **transport-fails**, the system
  retries ONCE with this tiny schema in **background mode**, then lets the user
  approve the rough map. Both fail → a clear checkpoint, never a hang.
- **Error categories, separated** (`modelClient.ts` `ModelErrorKind`; `openai.ts`
  `classifyError`): a transport **timeout** is no longer parsed as "invalid JSON".
  `agent_plan_fail` now logs `errorType` = `transport_timeout` | `model_error` |
  `transport` | `schema_error`; the empty timed-out body is never run through the
  JSON validator. The user sees "Module planning timed out before the model
  returned a plan. Try a smaller module request" — not a schema error.
- **Background mode + non-streaming plans** (`openai.ts`): plan calls are now
  NON-STREAMING (a plan needs reliability, not token streaming). `background:true`
  CREATEs the response then POLLs to completion (no long-held idle connection an
  proxy can drop) — opt-in via `AI_USE_BACKGROUND_FOR_PLANS`, and automatic for the
  module fallback after a timeout.
- **Instrumentation** (`agent_plan_request` before every plan call): planType
  (`module_skeleton`/`module_fallback`/`lesson_rich`/`lesson`), model, effort,
  timeoutMs, approxInputChars, approxSchemaChars, maxOutputTokens, background,
  streaming — so a future failure makes the cause (timeout vs schema vs model vs
  proxy) obvious from the logs.
- **UI** (`AgentPlanHost.tsx`): the module review card renders the lesson MAP
  (briefs + slide ranges + quiz/practice chips) with a note that each lesson's
  slides are planned just before it's built. `PlanOutline` module variant now
  carries `skeleton` (was the full outline).
- **Preserved:** bounded history, structured slide tools, batch generation,
  deterministic validate/repair, slideSpecId coverage, no default `gpt-5.5`,
  critique off, the approval gate, single change-set per module build.
- **Verified:** build + lint + tsc; `verify:ai` 64+**26**+27+32 (skeleton + fallback
  schema/coerce); `verify:slides` 17+8+67+23; `verify:reject` 17; `verify:ai:int`
  **76** vs live Supabase (+ skeleton→approve→per-lesson-rich-plan→generate,
  skeleton-timeout→fallback-in-background, and both-timeout→clear-message paths).
  No DB migration.

## Deterministic VALIDATE/REPAIR replaces heavy CRITIQUE — the plan is a contract, 2026-06-18

The heavy CRITIQUE pass was disabled (poor quality-per-cost). The reliability
problems it papered over — a deck finalizing with only 3 slides, a leftover
"Section title" placeholder, a failed batch silently skipping slides — are now
solved STRUCTURALLY: **PLAN → GENERATE → VALIDATE/REPAIR → (optional LIGHT
REVIEW) → STAGE**. Correctness is enforced by code, not by a model's opinion.

- **PLAN is the contract** (`lib/ai/outline.ts`): every slide spec now carries a
  pedagogical `role` (hook / worked_example / common_mistake / conceptual_check /
  edge_case / recap / …) + `kind` (`core` | `enrichment`), and the lesson carries
  a `microLesson` flag. The prompt gives explicit slide-count guidance (micro 3–4
  only on request · normal 6–10 · technical 7–12 · complex 9–14) and a "deepen,
  don't pad" checklist. A **depth floor** (`lessonDepthShortfall`, env
  `AI_MIN_NORMAL_LESSON_SLIDES`/`AI_MIN_TECHNICAL_LESSON_SLIDES`) re-asks ONCE when
  a non-micro plan comes back too thin — the PLAN-time half of the 3-slide fix
  (reuses the single repair-call slot in `runStructuredPlan` via a `postValidate`
  hook; a valid-but-thin plan is never lost if the deepen re-ask returns garbage).
- **No more placeholder decks** (`factories.ts`/`commands.ts`/`tools/structural.ts`):
  AI-created slide decks start EMPTY (`createBlock(…, {emptySlideDeck})`); the
  human AddBlockMenu keeps its starter slide. GENERATE now PRE-CREATES the empty
  deck and threads its `deckBlockId` into the context, so the model authors real
  slides into a known deck and never seeds a placeholder. `add_structured_slides_batch`
  takes a **nullable** `deckBlockId` that resolves to the lesson's deck (robust to
  a model that mis-cites the server-generated id; creates one if absent).
- **VALIDATE** (`lib/ai/validation.ts`, pure): after GENERATE, checks the doc
  against the plan — every spec built, no placeholder/empty slide, no duplicate
  primary spec, required quiz/homework present, deck not short of the contract,
  budget not exhausted mid-build. `lib/ai/slideDiagnostics.ts` is the leaf detector
  (precise placeholder/empty detection — a flat seed-only slide; a structured
  slide is authored content).
- **REPAIR** (`lib/ai/phases.ts`): hard failures are fixed — DETERMINISTICALLY
  first (strip placeholder/empty slides, drop junk/empty decks — no model), then a
  NARROW model pass handed ONLY the missing spec briefs + missing blocks ("fix
  these, leave correct slides alone"), re-validating each round up to
  `AI_MAX_REPAIR_PASSES`. If the contract still isn't met, it **checkpoints** with
  exactly what remains — a short deck is never presented as complete.
  `LoopResult.checkpointed` distinguishes "ran out of budget" from "model was done".
- **Generation state tracks remaining work** (`generationState.ts`): the bounded
  summary now carries the specs still to build, duplicates, placeholders present,
  slides missing a spec id, incomplete segments, and required blocks missing — so
  bounded history can't make the agent forget the rest of the contract.
- **Deterministic LINT + optional LIGHT REVIEW** (`lib/ai/lintGeneration.ts`,
  `lib/ai/lightReview.ts`): after hard validation passes, a no-model linter emits
  SOFT suggestions (thin slide, no speaker notes, example-planned slide with no
  example, quiz short of plan, …). An OPTIONAL **one-call** review (no tool loop,
  no regeneration, `gpt-5.4-mini`/medium) adds ≤3 suggestions — OFF by default,
  fired only when lint warnings cross `AI_LIGHT_REVIEW_LINT_THRESHOLD`. Neither
  blocks staging.
- **UI** (`events.ts`/`agentStore.ts`/`AgentPanel.tsx`): new `validate`/`repair`/
  `review` phases + `validation` ("Found 4 missing slides. Repairing…", "Final
  validation passed.") and `quality_report` events. The panel shows a calm
  validation line + a "Quality suggestions" card (warnings collapse behind a
  count; each review suggestion gets an "Ask AI to improve" action).
- **Config:** all default-ON for correctness, no premium `gpt-5.5` by default —
  `AI_VALIDATE_GENERATION` · `AI_REPAIR_HARD_FAILURES` · `AI_MAX_REPAIR_PASSES` ·
  `AI_LIGHT_REVIEW_ENABLED`/`_ON_LINT_THRESHOLD`/`_LINT_THRESHOLD` (`modelConfig.ts`).
  The legacy CRITIQUE path is kept behind `AI_CRITIQUE_ENABLED` (off) for parity.
- **Module-plan timeout fix:** "make all of module 3" failed with "The AI service
  hit an error" — diagnosis from the logs: the whole-module PLAN call **timed out**
  (`openai_error: Request timed out`) at ~77s, BEFORE our 120/180s timeouts — i.e.
  the model "reasons" for >75s producing **zero output** (`rawLength: 0`) over the
  giant per-slide outline, and the silent connection is dropped (server-side / a
  local proxy). Fixes: (a) the module plan is now a **DELIBERATELY LEAN** schema —
  `concept + layout + depth` per slide, NO per-slide keyPoints/notes/prerequisites
  (those were the bulk the model had to generate); the per-lesson GENERATE expands
  each concept. (b) **LOW effort** for the module plan (`AI_PHASE_MODELS.modulePlan`,
  env `AI_MODULE_PLAN_EFFORT`) — the single-lesson plan stays high; depth is built
  in GENERATE. (c) `runStructuredPlan` no longer **re-asks after a TRANSPORT error**
  (`finishReason === "error"`) — that was burning a SECOND timeout (the original
  2.6-min double-fail); it bails with the real provider message, now **surfaced to
  the chat** + the `agent_plan_fail` log (the PLAN path was swallowing the provider
  `error` event via `() => {}`). (d) a longer per-call PLAN timeout
  (`ModelTurnParams.timeoutMs`, `AI_PLAN_TIMEOUT_MS`=180s) as a safety net. Net: the
  module plan is now a small, fast call that returns in seconds.
- **Verified:** build + lint + tsc; `verify:ai` 64+20+27+**32** (new `verify-validation.ts`:
  placeholder detection, every hard-failure class, deterministic repair, depth floor,
  lint + review trigger); `verify:slides` 17+8+67+23; `verify:reject` 17;
  `verify:ai:int` **67** vs live Supabase (+ clean-validate, missing-spec repair,
  placeholder removal, and light-review-trigger end-to-end). No DB migration.

## Marketing studio — Email & sequences hub (Slice 5), 2026-06-22

You can now SEE what will be emailed, when, and to whom — before it sends.

- **Hub card → `/marketing/sequences`:** every sequence with its status, schedule
  (each touch's delay / trigger), subjects, and per-touch **sent / queued** counts.
- **`/marketing/sequences/[id]`:** each email **rendered exactly as it will send**
  (`renderEmailHtml` — the same renderer the real Resend path uses), with its
  preview text + send counts, plus a **recipients** table (who's enrolled and
  which email they're up to). "Edit with AI" links to the agent.
- **Persistence:** `loadSequencesOverview` (per-touch sent/queued from the outbox
  + enrolled counts) and `loadSequenceRecipients` (enrollees + current position).
- **Verified:** `verify:marketing:sequences` **10/10** (overview counts after
  enroll+tick, recipient positions, email renders with a working unsubscribe).
  `build` + `tsc` + `lint` clean. No migration/secret. Resend remains optional —
  the page shows a "mock mode" banner until `RESEND_API_KEY` is set.

## Marketing studio — account tier + course picker + overview (Slice 4), 2026-06-22

A creator/account tier above course scope: one audience across all courses,
overall analytics, and per-course campaigns side by side.

- **Migration (applied):** `20260622000000_marketing_account_tier.sql` —
  `audience_contact` (`(author_id,email)` unique; consent; global `unsubscribed_at`;
  RLS `author_id = auth.uid()`) + nullable `contact_id` on `subscriber` &
  `analytics_event` (+ indexes) + an idempotent backfill deriving contacts from
  existing subscribers and linking them. Reversible down-migration documented.
  Types regenerated; advisors clean.
- **Contact linking:** `ingest.captureLead` upserts the account-level contact and
  stamps `contact_id` on the per-course subscriber + events — so one person is a
  single identity across every course (lead on A, enrolled on B).
- **Global unsubscribe:** `globalUnsubscribe()` (shared by the unsubscribe route +
  tests) flags the contact and suppresses EVERY linked per-course subscriber
  (CAN-SPAM/GDPR-safe — the scheduler already skips `unsubscribed`). User-chosen
  default.
- **Account rollup:** `analytics.getAccountSummary(authorId)` — distinct audience
  (contacts) + funnel summed across the creator's courses + per-course breakdown.
- **UI:** `/marketing/overview` (total audience, account funnel, a card per course
  → its hub, master mailing list); the per-course hub gained a **course picker**
  + Overview link; `analytics`/`audience`/`agent` now accept `?course=` so the
  selection persists.
- **Verified:** new `verify:marketing:account` **10/10** (unified contact across
  courses, account aggregation, global-unsubscribe cascade). Full suite green:
  gate 37 · flow 18 · analytics 12 · email 34 · agent 18 · landing-edit 11 ·
  account 10 · swap 7 = **147**; `build` + `tsc` + `lint` clean.

## Marketing studio — observability + AI page editing (Slices 1–3), 2026-06-22

Made the landing loop real & observable, the funnel legible, and the page
editable by chat. (Diagnosis first found the recurring "ingest not configured"
was an UNSAVED `.env.local` buffer + a second checkout/server on :3000 — the
code was already correct; saving the key + restarting :3001 fixed it. Flow verify
now 18/18 incl. ingest.)

- **Slice 1 — observable landing loop:** `GET /api/marketing/health`
  (`{adminConfigured,emailMode}`) + clearer ingest 503; **Accept/Reject now give
  feedback** — actions return `{message, href, hrefLabel}`, the hub shows a toast
  + an artifact link, the item leaves "staged"; **authed draft preview**
  `/marketing/preview/[id]` renders the draft via the renderer in `preview` mode
  (no beacon, disabled form) so you can see a page before publishing.
- **Slice 2 — legible scheduling:** `/marketing/audience` shows each subscriber's
  lifecycle stage + sequence position + next send; author-scoped **test controls**
  (seed lead, advance scheduler ±days via a future `nowMs`) exercise the funnel on
  the mock provider; plain-language flow doc in `docs/marketing-suite.md`.
- **Slice 3 — conversational editing + typed design layer:** additive (jsonb, no
  migration) `LandingTheme` tokens (colorTheme/typePairing/density/buttonStyle) +
  per-section layout `variant` (hero centered|split|minimal, outcomes grid|list);
  `components/marketing-pages/design.ts` resolves tokens → literal Tailwind
  classes (renderer owns all layout — the agent never emits CSS). New reversible,
  gated tools `set_page_design` / `set_section_variant` (+ `update_landing_section`
  for copy); **split-view editor** `/marketing/landing/[id]` (agent chat + live
  draft preview, page-scoped agent, `router.refresh()` per turn).
- **Verified:** `verify:marketing:flow` 18 · `:email` 34 (+audience) · new
  `:landing-edit` 11 (design tokens + variant + content edits stage & reject
  byte-for-byte; agent path page-scoped) · gate 37 · agent 18 — all green;
  `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 5: real integrations swap (Resend + cron), 2026-06-19

The mock→real swap, behind one env var, zero contract changes.

- **`ResendEmailProvider`** (`lib/marketing/services/resend.ts`) — the ONLY file importing the `resend` SDK. Implements the same `EmailProvider` contract as the mock: renders the `EmailBody` to HTML + text (the pure renderers), sets a `List-Unsubscribe` header, returns the provider message id (no simulated engagement — real opens/clicks will arrive via Resend webhooks). Env: `RESEND_API_KEY`, `RESEND_FROM`.
- **Factory flip** (`services/factory.ts`): `createEmailProvider()` now returns Resend when `RESEND_API_KEY` is set, the mock otherwise — the single swap point. Tools, gate, agent, scheduler, and UI are untouched.
- **Cron**: the tick route gained a GET handler (Vercel Cron uses GET; external cron can POST with `x-cron-secret`); `vercel.json` schedules `/api/marketing/scheduler/tick` every 5 min. Guarded by `CRON_SECRET`.
- **Docs**: `docs/marketing-suite.md` (architecture, env, verify scripts, the swap); CLAUDE.md marketing section.
- **Verified:** `npm run verify:marketing:swap` **7/7** — no key → mock selected; key set → Resend selected; both expose the identical `EmailProvider` contract (zero downstream change). `build` + `tsc` + `lint` clean. Added runtime dep: `resend` (15 runtime deps total).

## Marketing Assistant — Phase 4: the Marketing Agent + Generate Kit + approval inbox, 2026-06-19

The assistant — it observes, generates, and stops at the gate.

- **Agent loop** (`lib/marketing/agent/loop.ts`) on the provider-agnostic `ModelClient` (same seam as the studio): **observe** (funnel + assets injected as a leading `developer` message — static system stays cacheable), **reason** (stream a turn with the marketing tool defs), **act** (every call through `executeMarketingTool` → the gate). Reversible auto-stages; reads execute; an irreversible call emits `approval_request` and **PAUSES** — the loop never sends/publishes on its own. Conversations reuse the shared `conversations`/`messages` tables (course-scoped, lesson_id NULL) with full history replay.
- **SSE** (`lib/marketing/agent/events.ts` + `app/api/marketing/agent/route.ts`, Node): `observation` / `assistant_delta` / `tool_start` / `tool_result` (status read|staged|pending_approval) / `approval_request` / `done{paused}`. OpenAI key server-only; 503s to a clean error event when unconfigured.
- **UI**: `components/marketing/agent/AgentPanel.tsx` (streaming chat with live tool cards + inline Approve/Deny) at `app/(app)/marketing/agent`. The hub gained a **unified approval inbox** — staged (Accept/Reject) + pending (Approve/Deny) from any surface (Generate Kit, cards, agent), labeled by action + flagged when the agent requested it — plus the **Generate Kit** batch button (`generateKitAction` runs the three reversible generators through the gate).
- **Verified:** `npm run verify:marketing:agent` **18/18** against live Supabase via the mock model client — observe step, reversible auto-stage, read tool, **irreversible pause** (page stays draft, one model call, pending action recorded), approve→executes, governance in the prompt, observe-as-developer-message, history persisted. `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 3: email + subscriber state machine + scheduler (mock send), 2026-06-19

The full email lifecycle, on OUR state machine — Resend (Phase 5) only ever moves bytes.

- **Subscriber state machine** (`lib/marketing/stateMachine.ts`): a PURE reducer over the event stream (`form_submit→lead`, `email_sent→subscribed`, `open/click→engaged`, `enrollment→enrolled`, `unsubscribe/bounce→terminal`). Active statuses only advance; terminals stick. `applyEventToSubscriber` materializes it; `isSuppressed` gates sends.
- **The engine** (`lib/marketing/scheduler.ts`): `enrollSubscriber/Segment` → `sequence_enrollment` + the first due `scheduled_send`; `runSchedulerTick` claims due sends, delivers via the provider, emits `email_sent` (+ deterministic mock `open/click`) into the single stream, advances each enrollment to the next touch (or completes it); `processEventTrigger` enrolls on a matching behavioral event; `sendBroadcast` is an inline one-off. **Idempotent** via the unique `(touch_id, subscriber_id)`; suppressed subscribers skip + their enrollment cancels.
- **Content**: `lib/marketing/email/templates.ts` (deterministic 4-touch launch + 2-touch followup, grounded in the course) + `render.ts` (pure text/HTML; Phase 5 can swap React Email) — every email carries a one-click unsubscribe.
- **Tools** (`lib/marketing/tools/email.ts`): reversible `generate_email_sequence` / `generate_followup` / `write_email_touch`; irreversible (gated) `activate_sequence` / `enroll_segment_in_sequence` / `send_broadcast` / `send_test_email`. Sequence sends are pre-authorized by the activate approval (the gate sits at activate/enroll/broadcast, not per-touch).
- **Routes**: `app/api/marketing/scheduler/tick` (prod cron trigger; service-role + optional `CRON_SECRET`; runs the same `runSchedulerTick` the tests drive) and `app/api/marketing/unsubscribe` (one-click, service-role).
- **Verified:** `npm run verify:marketing:email` **31/31** against live Supabase — pure state-machine transitions, generate→accept, write→reject (byte-for-byte), activate→approve→enroll→tick, clock-advance to the next touch, idempotent re-tick, unsubscribe suppression, event-triggered enrollment, and a gated broadcast. `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 2: analytics event stream + dashboard + observe, 2026-06-19

The single event stream becomes legible — to the creator AND the agent.

- **Aggregation (`lib/marketing/analytics.ts`).** `getAnalyticsSummary(courseId)` rolls the funnel (views → leads → email opens → clicks → enrollments) + rates + subscribers-by-status from `analytics_event` (cheap COUNT queries over the `(course_id,type)` / `(course_id,status)` indexes). Leads = distinct subscribers; enrollments = the materialized `enrolled` state. `queryAnalyticsEvents` returns a bounded, filtered slice.
- **Observe tools (`lib/marketing/tools/analytics.ts`).** `get_analytics_summary`, `query_analytics_events`, `get_subscriber_segments` — reads, added to `MARKETING_READ_TOOLS` (so they're in the agent's observe surface AND the generate phase). The dashboard and the agent now read the *same* numbers.
- **Dashboard (`app/(app)/marketing/analytics/page.tsx`).** A funnel view (renderer-owned bars), subscribers-by-status, and recent events — linked from the hub's now-live Analytics card.
- **Verified:** `npm run verify:marketing:analytics` **12/12** against live Supabase (funnel counts, rates, status breakdown, and all three observe tools), `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 1: landing page generate → publish → lead capture, 2026-06-19

The first user-facing slice: a creator generates a landing page from their syllabus, reviews it, publishes it (gated), and it captures leads at a public URL.

- **Slot-schema + renderer (renderer owns layout).** `components/marketing-pages/*` renders the typed `LandingSection[]` in the warm-editorial identity (hero/outcomes/curriculum/instructor/social_proof/pricing_cta/lead_capture/faq). Public route **`app/p/[slug]/page.tsx`** server-renders a PUBLISHED page via RLS (drafts 404), with `generateMetadata`.
- **Public lead-capture ingest.** `LeadCaptureForm` + `PageViewBeacon` (client) POST to **`app/api/marketing/ingest/route.ts`** (Node), which uses a **service-role admin client** (`lib/supabase/admin.ts`) to write `subscriber` + `analytics_event` rows on behalf of anonymous visitors — `lib/marketing/ingest.ts` validates the target page is published, idempotently upserts the subscriber (by `campaign_id,email`), and emits `form_submit` (+ `free_lesson_capture`) and `page_view` into the single event stream. Route 503s cleanly when the key isn't configured.
- **Studio Marketing hub** (`app/(app)/marketing/`): replaced the mock placeholder with a real hub — generate a landing page, review the **staged** change (Accept/Reject), **Publish** (→ approval gate: Approve/Deny), View live / Unpublish. Server actions (`actions.ts`) route the SAME shared tool layer + gate as the agent will. Sequence/analytics/agent cards are honest "Phase N" placeholders.
- **New env:** `SUPABASE_SERVICE_ROLE_KEY` (server-only) for the ingest write path.
- **Verified:** `npm run build` (both `/p/[slug]` + `/api/marketing/ingest` registered), `tsc` + `lint` clean, `npm run verify:marketing:flow` **7/7** generate→accept→publish→approve→public-read against live Supabase (ingest's 6 lead-capture checks auto-run once the service-role key is in `.env.local`).

## Marketing Assistant — Phase 0: the spine (schema · gate · tools · mocks), 2026-06-19

First slice of the Marketing Assistant suite (PRD: `docs/prd/Marketing-Assistant-Creator-Studio-Web.html`). The architectural spine everything else hangs off — **one typed tool layer, one event stream, one governance gate** — built mock-first so the whole loop works before Resend/cron exist.

- **DB (applied, user-approved):** migration `20260618000000_marketing_assistant.sql` — 9 author-scoped tables (`marketing_campaign`, `landing_page`, `email_sequence`, `email_touch`, `subscriber`, `sequence_enrollment`, `scheduled_send`, `analytics_event`, `marketing_action`), denormalized `course_id` + `private.is_course_author` RLS everywhere, jsonb payloads. Two deliberate departures: `landing_page` is **public-read when `published`** (the /p/[slug] route), and `subscriber`/`analytics_event` take author-only RLS with public writes reserved for a Phase-1 service-role ingest route. Types regenerated; advisors clean (no new RLS gaps).
- **The governance gate (`lib/marketing/gate.ts`) — a first-class, reversibility-graded primitive.** Every mutating tool routes `runThroughGate`: **read** executes (no ledger); **reversible** executes + snapshots the target BEFORE + stages an `auto_approved` row (Reject-able, atomic byte-for-byte restore via the entity registry); **irreversible** does NOT execute — it runs the tool's side-effect-free preview, records a `pending` row, and waits for `approveMarketingAction` (runs the real effect) or reject (deny). The `marketing_action` table is the unified staging + approval + audit ledger.
- **One shared tool layer (`lib/marketing/tools/*`).** `Tool<P>` + `reversibility`, behind ONE entrypoint `executeMarketingTool` (the same seam the batch button, cards, and agent will all call). Phase 0 tools: reads (`get_campaign_context`, `get_course_plan`, `list/get_landing_page`), reversible (`create_campaign`, `generate_landing_page`, `update_landing_section`), irreversible (`publish/unpublish_landing_page`). Zod params → strict JSON schema via the studio's `toStrictJsonSchema`. Tool sets `MARKETING_READ/GENERATE/ACTION_TOOLS`.
- **Slot-schema + deterministic generator.** `lib/marketing/types.ts` + `schemas.ts` define the typed landing-section union (hero/outcomes/curriculum/instructor/social_proof/pricing_cta/lead_capture/faq) with `.max()` caps as the validate→repair guard; `generators.ts` fills them truthfully from the course plan (the mock-first content engine; Phase 1 adds an LLM variant behind the same signature).
- **Mock→real seam.** `lib/marketing/services/*`: `EmailProvider` + `Clock` interfaces, a deterministic `MockEmailProvider` (records sends, returns reproducible simulated engagement), and an env-gated `createMarketingServices` factory (one Phase-5 branch flips to Resend; nothing else changes).
- **Verified:** `npm run verify:marketing` — **37/37** against live Supabase (gate routing, reversible stage+reject-restore byte-for-byte, irreversible pend→approve / deny, published public-read RLS, author-scope RLS). `lint` + `tsc` clean.

## Per-phase model · prompt-cache fix · reject↔autosave race (A/B/C), 2026-06-17

- **A — per-phase MODEL (not just effort):** `ModelTurnParams.model` + `LoopOptions.model` make the model a per-call parameter (provider falls back to `OPENAI_MODEL`/`DEFAULT_MODEL`). PLAN/CRITIQUE = `gpt-5.5`/high, **GENERATE = `gpt-5.4-mini`/medium** (the high-volume phase stays cheap), classifier = `gpt-5.4-mini`/minimal. `agent_phase` logs the per-call `{phase, model, effort}` (was logging the client default). Both strings confirmed valid live.
- **B — prompt caching fix:** the `~19.5K` stable prefix wasn't caching because `buildSystemPrompt` put the **variable** course/lesson context BEFORE the large static catalogs, truncating the cacheable prefix at the course title (and `cached_tokens` wasn't even logged). Fix: `buildSystemPrompt` is now **STATIC only** (role + catalogs + teaching bar); the variable course/lesson/outline moves to a leading `developer` message in `input` (new `buildContextMessage`), so the static system + tool schemas form one byte-identical prefix. `cachedTokens` added to `PhaseUsage` + the log. **Live spot check: ~98% of input cached on a repeat call** (10,752 / 10,994), vs effectively the role-only prefix before.
- **C — Reject ↔ autosave race + resilient autosave:** the "Course autosave failed: TypeError: Failed to fetch" around Reject was the debounced autosave (`coursePersistence.ts`) racing the reject's reconcile — a stale in-flight flush (un-reverted client doc) writing concurrently with the server revert (it's a transport-layer fetch failure, not an abort; reject merely provokes it). Fix: Reject now **suspends + aborts** autosave before the POST (`suspendAutosaveForReject` + an `AbortController` threaded into `reconcileCourseDoc` via `abortSignal`), and `hydrate` resumes + **skips re-saving** the reverted doc (already server state); the reject POST-failure path resumes too. Autosave failures now **auto-retry with backoff** (2 attempts) before surfacing `saveStatus("error")` — a transient blip no longer silently loses work. Server reject was already pending-only + atomic; Accept-all is untouched.
- **Verified:** build + lint + tsc; `verify:ai` 63+16; `verify:slides` 17+8+48+23; `verify:ai:int` **53** (+per-phase-model + cacheable-split assertions); `verify:reject` 17. No DB migration.

## GENERATE quality — bind to the planned layout + teach with depth (A–E), 2026-06-17

PLAN was solid but GENERATE rendered skeletal primitives: a planned `concept_example`/`key_concept` "Greedy intuition" slide came out as three TIP boxes of ~5 words. General (not one-slide) fixes:
- **Root cause:** PLAN speaks the **structured** layout vocabulary, but GENERATE authored via `write_slide_deck` whose enum is the **14 FLAT layouts only** → a planned structured layout became a flat `step_by_step` (3 `variant:"tip"` callouts). Nothing bound slide *i* to the planned layout, and the prompt mandated brevity ("a few words each", "no walls of text") with max-only slot caps (no floor).
- **A — model `gpt-5.5`** (`openai.ts` `DEFAULT_MODEL`; `OPENAI_MODEL` overrides). Per-call effort already PLAN high / GENERATE medium / CRITIQUE high; logs carry model+effort. Confirmed valid against the live API.
- **B — deeper PLAN** (`outline.ts`): prompts now DECOMPOSE a concept into building sub-steps (each weight-bearing one its own slide), mandate ≥1 worked example + a low-stakes check, sequence primitive→improved, and — new — a required `keyPoints[]` per slide carrying the **actual content** (the writer's brief), surfaced in `outlinePromptFragment` as a "cover:" list.
- **C — bind to the planned (structured) layout + plain first-class:** new **`prose`** structured layout (a real teaching text slide: title + substantive body + optional points) added via the esd pattern (8 structured layouts now). `OUTLINE_LAYOUTS` is all-structured (`prose` replaces the bare "text" fallback). GENERATE/CRITIQUE run a new **`GENERATE_TOOL_NAMES`** set — reads + structured slide tools + `create_block` + `write_quiz/homework/lecture`, **excluding `write_slide_deck` and the flat slide ops** — so a flat tip/text deck is impossible; the prompt says render the planned layout, upgrade only to a better *structured* layout, never silently downgrade.
- **D — depth floor** (`context.ts`): the GENERATE teaching bar now demands real teaching (full sentences/steps/worked example, expand the brief, fill slots), **bans skeletal/3–6-word slots**, and the conflicting brevity lines are removed (max caps stay). A `agent_thin_slides` heuristic logs under-filled structured slides (observability — modules have no critique).
- **E — CRITIQUE enforces A–D** (single-lesson builds): fail-and-revise on skeletal slides, layout≠plan-without-justified-upgrade, missing worked example, should-build-up; structured-tool fixes only; one bounded pass. **Module builds stay GENERATE-only** (your call) — B+C+D carry module quality.
- **Verified:** build + lint + tsc; `verify:ai` 63+16; `verify:slides` 17+8+**48**+23 (prose); `verify:ai:int` 49 (GENERATE toolset asserted structured-only); `verify:reject` 17. **Live spot check (gpt-5.5, routed via the proxy):** a Kruskal lesson planned 14 all-structured slides with keyPoints, decomposed greedy→cut property→algorithm→DSU→worked trace→check→correctness→runtime, with a `prose` slide + worked examples. No DB migration.

## Fix: "create a module" misrouted + generation went off-script (FK + no module), 2026-06-17

"Please create module 4 … only do the first 2 lessons" produced no module 4, a tangle of create/list/delete-lesson tool calls, and a save error `insert or update on table "lessons" violates foreign key constraint "lessons_module_id_fkey"`.

- **Root cause — router (`lib/ai/intent.ts`):** the `generate_module` short-circuit was gated by `&& !/\blessons?\b/i.test(msg)`, so ANY module request that mentions "lessons" (nearly all do) was disqualified and fell through to `generate_lesson`/edit. The dedicated module pipeline never ran. **Fix:** dropped that guard; added a narrow `LESSON_INTO_MODULE` check ("add a lesson to/in module X" → `generate_lesson`) that takes priority, else a module build → `generate_module`. Now "create a module … with N lessons" routes to the module pipeline.
- **Compounding cause — unconstrained generation (`lib/ai/tools/index.ts`, `agentLoop.ts`, `phases.ts`):** the GENERATE/CRITIQUE loops were handed the FULL toolset, so the misrouted model improvised — `create_lesson` (into the wrong/current module, since it defaults there), `delete_lesson`, etc. — churning the tree into an inconsistent state that failed the whole-doc reconcile (the FK). **Fix:** GENERATE + CRITIQUE now run with `authoringOnly` — restricted to `AUTHORING_TOOL_NAMES` (read context + write/edit slides/decks/quiz/lecture), EXCLUDING structural + destructive tools. The pipeline owns module/lesson creation; the edit path keeps the full toolset.
- **Tests:** `scripts/verify-outline.ts` gained routing assertions (module-with-lessons → module; add-lesson-to-module → lesson; short-circuits make no model call); the live `verify-agent-integration.ts` module case now uses lesson-naming phrasing and asserts the GENERATE toolset excludes `create_lesson`/`delete_*` and includes the authoring tools. `verify:ai` 63+16, `verify:ai:int` 49, build/lint/tsc green. No DB migration.
- **Known follow-up (NOT in this change):** the FK was reached because the agent's server reconcile and the studio's browser autosave both do **full-snapshot whole-doc writes on the same course with no coordination** — interleaved upsert/delete-orphans can transiently orphan a row. Constraining generation greatly narrows the window, but the real fix (pause autosave during an agent run, or scope reconcile to touched subtrees / serialize writes) is tracked separately.

## Fix: PLAN structured-output always failed ("couldn't produce a valid outline"), 2026-06-17

Every lesson AND module PLAN failed with the generic "couldn't produce a valid {outline|plan}" — even a tiny request. `verify:ai:int` passed only because the MOCK provider never exercises OpenAI's real structured-output path. Reproduced against the live API (routed through the dev proxy since the openai SDK / undici ignores `HTTPS_PROXY`).

- **Root cause (provider text extraction):** for a reasoning + structured-output (`text.format` json_schema) response, the OpenAI Responses API returns the JSON in the `message` output item but **`final.output_text` is empty** (live: `outputTokens 13589`, `reasoningTokens 11507`, yet `output_text.length === 0`). The provider read only `final.output_text` → empty → `JSON.parse` failed → the generic error. **Fix (`lib/ai/providers/openai.ts`):** new pure `messageTextFromOutput(output)` reads the `message` items' `output_text` parts directly; the turn now uses `messageTextFromOutput(...) || final.output_text || streamedDeltas`. Confirmed live: both lesson + module now return valid outlines.
- **Hardening (defense in depth, also justified by the live numbers):**
  - **Output budget:** the PLAN call now passes `maxOutputTokens` 32000 (was the 16000 default) so high-effort reasoning (~11k tokens observed) can't starve the JSON.
  - **Bounds-relaxed parse (`lib/ai/outline.ts`):** OpenAI strict mode strips `min/max/minItems/maxItems` from the schema, so the model is never told the floors/ceilings — rejecting on them locally just bounced a good plan. New `coerceOutline`/`coerceModuleOutline` parse types + enums (enums ARE API-enforced) and **clamp counts** (≥1 slide accepted, >14 truncated; lessons ≤8; empty-slide lessons dropped) instead of hard-failing; the "3–14 / length" guidance stays in `.describe()` + the prompt. Resume re-validation uses the same coercion (so an approved relaxed plan isn't re-rejected at approve).
  - **Real errors surfaced:** `runStructuredPlan` logs the true cause on failure (`finishReason`, reasoning/output tokens, raw head) and the user message now distinguishes "cut off" (incomplete) / "service error" from "invalid"; `openai.ts` captures the API error status + body verbatim.
- **Closed the test gap (`scripts/verify-outline.ts`, in `verify:ai`):** asserts the generated lesson/module response schemas obey OpenAI strict rules (no forbidden keywords; every object `additionalProperties:false` + complete `required`), the relaxed parse accepts a 1-slide/over-count/long-title outline and clamps, and `messageTextFromOutput` recovers JSON when `output_text` is empty. No DB migration.

## Phased agent — fix the bypass: module-level plan, 3-way routing, forced layering, prominent review, 2026-06-16

The phased pipeline shipped but a real request — "Add a search algorithm module … also counting and radix sorts" — bypassed it: it created a module + 4 lessons + 4 **basic** decks with **no plan card** (even with auto-approve OFF). Root cause (confirmed): the router classified "add a … module" as `edit`; the pipeline was **per-lesson only** (couldn't build a module); and **all non-pipeline content creation ran the un-layered loop**. Fixed end-to-end. Verified: build + lint + tsc green, `verify:ai` 63, `verify:ai:int` **47** (39 prior + 8 module-build), slides/reject unchanged.

- **A — 3-way routing** (`lib/ai/intent.ts`): `generate_module | generate_lesson | edit`. High-precision regex short-circuits for module/lesson builds (incl. "add a … module"), a small-add guard so "add a knowledge check / a slide / fix wording" stays on the fast `edit` path, and a rewritten 3-mode classifier (defaults to `edit`).
- **B — module-level plan** (`lib/ai/outline.ts` `ModuleOutlineSchema` = ordered lessons, each with its slide outline): the module request produces ONE plan card (module title + every lesson's outline), approve once → create the module + lessons → GENERATE each lesson (layered). **Per the cost trade-off, module builds skip CRITIQUE** (single-lesson generation still runs it); revisit if quality needs it. One reconcile → **one** change-set across the whole module; per-lesson progress via `phase.detail` ("Linked lists (2/4)").
- **C — no un-layered content path** (`lib/ai/agentLoop.ts`, `phases.ts`): the `edit` loop and the delete-resume loop now run `layered:true` (teaching bar + layout guide, no plan gate, still single-turn) — so any deck the fast path creates still meets the bar. The fast path stays fast (no PLAN/CRITIQUE).
- **D — prominent review** (`components/editor/agent/AgentPlanHost.tsx`): the plan review moved from a scrollable inline card to a **modal mounted at the shell level** (scrollable body + sticky Approve & generate / Discard, renders lesson vs module), so it can't scroll past and shows even if the panel is collapsed. `plan_outline` + `pendingOutline` are now discriminated (`kind: "lesson" | "module"`). Auto-approve stays OFF by default + honored server-side.
- **Instrumentation:** every `agent_phase` log now carries `layered`, and the `edit` path logs a phase line too — every run is traceable.
- New route entry `resumeGeneratePlan` (replaces `resumeGenerateLessonTurn`) dispatches lesson vs module on approve. No DB migration (outlines stay transient).

## Phased content agent — PLAN → GENERATE → CRITIQUE (per-call effort + sidebar phases), 2026-06-16

The single-turn content agent produced shallow decks (text + code + tip boxes, structured layouts unused, foundational concepts skipped, a whole lesson in ~30s). Effort was already `medium` — a process/prompting problem, not a knob. Fixed by giving ONE agent (gpt-5.4-mini) an explicit three-phase pipeline with **per-call reasoning effort**, a teaching bar + layout decision guide, and a fresh-eyes critique. Verified: build + lint + tsc green, `verify:ai` 63, `verify:ai:int` **39** (25 prior + 14 phased), `verify:slides`/`verify:reject` unchanged.

- **Per-call reasoning effort** (the seam): `ModelTurnParams` gains `effort?` + `responseFormat?`; `ModelTurnResult.usage` gains `reasoningTokens`. `providers/openai.ts` applies `params.effort ?? envDefault`, passes `text.format` json_schema for structured turns, and maps `reasoning_tokens`. The env value is now a fallback default only.
- **Auto-detect routing** (`lib/ai/intent.ts`): each turn is classified `generate_lesson` vs `edit` — a regex short-circuit for obvious "build a lesson/deck" phrasing, else a minimal-effort structured classification (defaults to `edit`). Small edits keep the existing single-turn loop untouched.
- **PLAN** (`effort:high`, structured output → `lib/ai/outline.ts` `LessonOutlineSchema`): emits a slide-by-slide outline (concept · prerequisites · layout · depth · notes), validate→repair (one re-ask). Manual approval by default — emits a `plan_outline` event and pauses (mirrors the delete confirm flow); an **auto-approve toggle** collapses the pause. The outline is **transient** — it round-trips client→server and is consumed by GENERATE/CRITIQUE; never persisted (no `courses.plan` change, no migration).
- **GENERATE** (`effort:medium`): the shared loop with a layered system prompt (teaching bar + layout decision guide + the approved outline appended at the end so the stable prefix still caches).
- **CRITIQUE** (`effort:high`, ONE bounded pass): a fresh-eyes critic prompt with the lesson's deck serialized **as data**; revisions go through the same ops tools. The whole pipeline reconciles once and stages **one** reviewable change-set (baseline = doc before GENERATE).
- **Sidebar phase indicator** (user-requested): new `phase` + `plan_outline` SSE events → `agentStore` (`phase`, `pendingOutline`, `autoApprovePlan`) → `AgentPanel` shows a PLAN/GENERATE/CRITIQUE badge, an inline outline-review card (Approve & generate / Discard), and an auto-approve checkbox.
- **Instrumentation**: one structured `console.log({ tag:"agent_phase", phase, model, effort, toolCalls, inputTokens, outputTokens, reasoningTokens, latencyMs, … })` per phase.
- **Loop reuse**: `runConversationLoop`/`loopContext`/`LoopContext` are now exported and take per-call options (`effort`, `outline`, `layered`, `systemOverride`, `maxTurns`, `deferFinalize`) and return `{doc, usage, toolCalls, …}`. Legacy callers pass no options → byte-identical. New `lib/ai/phases.ts` owns the orchestration (`runContentAgentTurn`, `runGenerateLessonTurn`, `runGenerateThenCritique`, `resumeGenerateLessonTurn`); new route `app/api/ai/agent/plan/route.ts` resolves the approval (mirrors `/confirm`).

## Fix: agent staging crash on a divergent docked lessonId (change_sets FK), 2026-06-16

The agent could apply a slide/block edit successfully and then fail staging with
`insert or update on table "change_sets" violates foreign key constraint
"change_sets_lesson_id_fkey"`. Root cause: `change_sets.lesson_id` was populated
from the **client-supplied docked `lessonId`** (`useEditorStore.activeLessonId`
→ request body → `agentLoop` → `createChangeSet`), never validated against the
DB. When that id was a client-only / not-yet-autosaved / stale lesson (no
`lessons` row), the insert violated the FK. The tool edit itself already
persisted (the full-doc `reconcileCourseDoc` runs *before* `createChangeSet`, in
a separate non-transactional call), so the change survived reload while staging
crashed and surfaced a red error on a successful edit.

- **Fix (`lib/ai/agentLoop.ts`):** coalesce the change-set's `lesson_id` to a
  server-validated value — trust the docked id only if `findLesson(doc, …)`
  finds it in the just-reconciled doc, else fall back to a changed block's
  lessonId (always persisted) or `NULL` (the column is nullable). The FK target
  now provably exists or is NULL.
- **Twin (`lib/ai/conversations.ts`):** `getOrCreateConversation` now stores
  `lesson_id` only if the lesson exists, else `NULL` — the same latent
  `conversations_lesson_id_fkey` would otherwise fire on the first turn of a
  thread opened on an unpersisted lesson.
- **Regression (`scripts/verify-agent-integration.ts`, now 25 checks):** an
  agent turn with a non-existent docked `lessonId` editing a block in a real
  lesson — asserts the tool succeeds, no error event, the change_set is emitted,
  and its `lesson_id` is coalesced to the real lesson (not the bogus id); plus a
  conversation opened on a non-existent lesson stores `lesson_id NULL`. Verified
  it reproduces the exact FK error when the fix is reverted. `change_set_items`
  has no lesson FK and its `lesson_id` comes from the diff (always valid), so it
  was never affected. No schema/migration change.

## Three more structured layouts — section break · concept→example · outline list, 2026-06-16

Added three renderer-owned structured layouts through the EXISTING pattern (no
new architecture): one registry entry + strict length-enforced Zod schema +
React component + discriminated-union variant + dispatch case each, auto-exposed
to the AI catalog and the manual "Structured" picker. Brings the registry to
**7** structured layouts. Verified: `npm run build` + `npm run lint` clean, 44
pure structured-layout checks + 23 agent-facing checks (`npm run verify:slides`),
17 reject/revert checks (incl. a new structured slide restored byte-for-byte),
63 AI tool/schema checks (`npm run verify:ai`), and a 10-frame Playwright
near-max overflow sweep (every slot at its limit + max item/step/sub-item counts,
all variants, both decoration levels — no clipping or overflow).

- **`section_break`** (refs 1–4 = one layout): a chapter/section transition — a
  numbered mono kicker, a big title, a short accent underline, and a one-line
  framing. Variants `standard` / `hero_numeral` (giant outline numeral) ×
  `titleStyle` serif/sans. Serif titles get renderer-owned **two-tone** coloring
  (accent on the last word). Decoration = kicker/base rules + corner concentric
  arcs + dot-grid.
- **`concept_example`** (refs 5–6 = one layout): an abstract rule/definition
  (left) paired with a worked example (right) whose body is a discriminated union
  — `steps` (2–4, numbered) OR `paragraphs` (1–3, prose). Renderer owns the "in
  practice" connector (solid for steps, dotted for paragraphs), the badges, the
  step number badges, and the optional footnote callout.
- **`outline_list`** (ref 7): a titled nested list serving both lesson objectives
  and a module table of contents — 2–5 items, each with 0–2 optional sub-points.
  Renderer owns the top accent bar, the rule, number markers, two-tone
  main-vs-sub coloring, indentation, and count-based type scaling/reflow.
- **Decoration is renderer-owned and dial-able.** Each layout carries a
  `decor` (`"full" | "minimal"`) knob — present in the PERMISSIVE storage schema
  and the inspector, but DELIBERATELY ABSENT from the strict AI tool schema, so
  the model can never request or position flair. The AI's contract is the slot
  structure only.
- **Reliability guard unchanged:** every text slot carries an enforced `.max()`
  + length hint; counts are bounded; the validate→repair loop bounces overflow
  before render. New `RichText` slots reuse the nullable-`marks.color` schema (no
  `received null` regressions). New layouts have NO `ITEM_BOUNDS` entry (now
  `Partial`) — the inspector dispatches to bespoke panels for them and keeps the
  generic item editor for the original four. No DB migration (jsonb).
- **Files:** `lib/course/types.ts` (+content interfaces, `DecorLevel`, union),
  `lib/course/schemas.ts` (permissive storage branches),
  `lib/course/slide/structuredLayouts.ts` (LIMITS + strict schemas + registry +
  input union), `components/editor/slide/structured/{SectionBreak,ConceptExample,
  OutlineList}Layout.tsx` + `common.tsx` (`twoToneTitle`, `Badge`, `EditableText`
  children) + `StructuredSlide.tsx` dispatch, `LayoutPicker.tsx` (thumbnails),
  `components/editor/inspector/StructuredContentEditor.tsx` (dispatcher + 3
  bespoke editors). AI tools (`add_structured_slide` / `set_structured_slide`)
  pick them up automatically via the shared input union.

## Module & lesson deletion — for the user AND the agent (with confirmation), 2026-06-16

Neither the creator nor the agent could delete a module or a lesson; now both
can, and every delete is gated by a confirmation. For the agent, the
confirmation is a HARD PAUSE: it proposes the delete, the studio pops the dialog,
and the run is frozen until the creator decides — then it resumes. Verified by
`npm run build` + `npm run lint`, 63 pure + 19 live-Supabase agent checks (incl.
pause→confirm and pause→cancel), and a 10-check Playwright run of the manual flow.

- **New patches** `DELETE_MODULE` / `DELETE_LESSON` (`lib/course/patches.ts`,
  pure reducers + `deleteModulePatch`/`deleteLessonPatch` commands) — the one
  validated way structure is removed, used by BOTH the UI and the agent.
- **Manual deletes** with a shared confirm gate: a reusable `ConfirmDialog`
  (`components/ui/ConfirmDialog.tsx`, portal + focus-on-Cancel + Esc) driven by
  an imperative `confirm()` store (`lib/editor/confirmStore.ts`, one
  `<ConfirmHost/>` in the app layout). Hover-revealed trash affordances on the
  outline sidebar (module + lesson rows), the CoursePage module cards, and the
  ModulePage (a header "Delete" + per-lesson rows) all route through
  `confirmDeleteModule` / `confirmDeleteLesson` (`deleteConfirm.tsx`) → the
  patch pipeline → autosave. Deleting the open module returns to the course home.
- **Agent deletes pause for confirmation.** New `delete_module` / `delete_lesson`
  tools (`lib/ai/tools/structural.ts`) return a `confirm` descriptor instead of
  applying. The loop (refactored into a shared `runConversationLoop`,
  `lib/ai/agentLoop.ts`) detects it, stages a placeholder tool output (keeping the
  conversation valid), emits a new `confirmation_request` event, and STOPS —
  no further tool calls run. The docked panel shows the same `ConfirmDialog` and
  freezes the composer. The decision posts to **`/api/ai/agent/confirm`**, which
  `resumeAgentTurn`s: applies (or skips) the whitelisted delete patch, rewrites
  the placeholder output to "confirmed/declined", and continues the model loop so
  the agent finishes or acknowledges. Deletes are excluded from the reviewable
  change-set (the confirmation IS the gate). The agent's docked-lesson context,
  history replay, and persistence all stay consistent across the pause.
- The system prompt gained a STRUCTURAL EDITS rule (deletes are destructive,
  user-confirmed, and never a stand-in for an in-place edit); the manifest lists
  the new actions.

## Course-root page, light-blue modules & null-mark hardening, 2026-06-16

Closed the "blank course has no clear way to add a module" gap, gave modules
their own colour, and killed a raw validation error that leaked into the agent
chat. Verified by `npm run build` + `npm run lint`, the AI suites (84 checks,
incl. a new null-mark regression), and a temporary Playwright run
(`scripts/verify-coursepage-browser.ts`, 7 checks) driving the real studio
against live Supabase.

- **Course-root page** (`components/editor/CoursePage.tsx`): the center column
  when the COURSE is selected. Mirrors `ModulePage` one level up — a prominent
  "No modules yet → Add module" empty state (the old fall-through showed a
  dead-end "No lesson selected"), and a list of module **preview cards** once
  populated. "Add module" creates + jumps straight into the new module (the
  same guided flow as add-lesson). Wired into `CourseEditorShell`
  (`selection.kind === "course"` → `CoursePage`).
- **Modules are light blue** (sky), distinct from the warm-orange course/lesson
  accent, for the colour variance the studio lacked. Applied to the outline
  sidebar's selected-module row + "Module N:" prefix, the `ModulePage` eyebrow
  (now a sky `Layers` kicker) + not-found state, and every `CoursePage` module
  card. Lesson/content actions stay orange — module identity vs. content reads
  apart at a glance.
- **Agent no longer leaks raw Zod dumps** (`lib/ai/agentLoop.ts`): a failed tool
  call now shows the user a calm one-liner (`friendlyToolError`) while the MODEL
  still receives the full detail to self-correct. The validate→repair guard is
  an internal safety net, not a message addressed to the creator.
- **Null run-marks are accepted + normalized** (the reported `set_structured_slide`
  error). Strict tool schemas advertise every optional key as nullable, so the
  model emits `marks:{color:null,…}` on emphasized runs; the structured AI input
  schema (`lib/course/slide/structuredLayouts.ts`) now uses a local run schema
  that `.nullish().transform()`s those nulls to "absent" — so the produced patch
  is CLEAN and the (untouched, strict) storage schema validates it. Schema
  generation switched to `io:"input"` (`lib/ai/schema.ts`) so the transform is
  representable AND the model is still told null is allowed. Regression-tested in
  `scripts/verify-agent-structured.ts` (accepts null marks, stores no `:null`).

## Slide layouts, primitives & generation, 2026-06-16

Expanded the slide system's vocabulary — more layouts and primitives, not busier
slides — and made the agent use them; hardened Reject. Verified by 4 new pure
suites (`npm run verify:slides` + `verify:reject`, 74 checks) + a temporary
preview page screenshot-checked at seed AND near-max content. New runtime dep:
`shiki` (the only one; deps now 14).

- **Reject is now atomic** (`lib/ai/changeSet.ts`): a new pure
  `revertChangeSet(doc, items, now)` builds the full inverse first and aborts the
  WHOLE revert (throw, stay `pending`) if any item can't invert — no more silent
  `continue`, no half-reverted decks. DELETE-op restores re-add at the original
  index. `scripts/verify-reject-revert.ts` proves byte-for-byte restore
  (create+update+delete, incl. a deck) + the atomicity abort.
- **Sticker primitive library** (`lib/course/slide/stickers.ts`): one pure
  registry (20 lucide-mapped ids) → a new `{type:"sticker",stickerId}` element
  (types/schemas/patches/manifest/factories/`elementFromPlaceholder`), rendered
  single-color in the slide accent inside a tinted circle (`StickerElement.tsx`,
  reusable `StickerGlyph`). Manual picker = Insert→sticker grid; AI inserts by id
  (`add_sticker`, enum-validated). Icon geometry never leaves the renderer.
- **Tokenized fonts** (Task 2): `ElementStyle.fontScale`
  (display/title/heading/body/caption) resolves to a per-theme `typeScale`
  (`themes.ts`) and WINS over legacy raw px; the toolbar + Design tab size
  controls are now token dropdowns (raw px retired from the UI, still rendered).
  New `display` family = Fraunces (editorial serif). AI tool `set_text_style`.
- **Renderer-owned structured layouts** (Task 3): a slide may carry
  `template:{layoutId,content}` (typed, RichText slots) that a dedicated
  component draws — owning arrangement, arrows, numbering, reflow — bypassing the
  freeform element canvas. Four, from cgref1–5: `process_steps`, `key_concept`
  (sans+serif variants + optional spine), `metrics_overview` (chart deferred),
  `code_walkthrough_steps` (Shiki, `lib/course/slide/highlight.ts`, JS engine).
  Registry `structuredLayouts.ts` holds STRICT length-enforcing Zod schemas (the
  reliability fix — an over-long heading bounces back before it renders) + seeds.
  Patches `SET_SLIDE_TEMPLATE` / `UPDATE_TEMPLATE_CONTENT` (path-addressed,
  re-validated); `SlideStage` branches on `template`; `LayoutPicker` gains a
  "Structured" section; in-place text edit + a structured inspector
  (`StructuredContentEditor.tsx`) for add/remove/reorder/sticker/variant/delta.
- **Agent uses the vocabulary** (Task 5): `add_structured_slide` /
  `set_structured_slide` (strict per-layout union schema → validate→repair on
  overflow), `set_text_style`, `add_sticker`; the system prompt
  (`lib/ai/context.ts`) gained the structured-layout + sticker catalogs and
  match-layout-to-content guidance.
- **Export-fidelity ledger:** structured layouts (renderer-owned components) +
  Shiki code are NOT yet PPTX-mapped — flagged for the export workstream; they
  cost more to map than flat layouts. The metrics chart is deferred to
  charts-as-data and is NOT faked.

## Slide agent — production tool surface + content contract, 2026-06-15

Turned the slide agent from "rewrites the whole deck into title+bullets and
leaks `**markdown**`" into a Cursor-style editor bound to the studio's OWN
renderer primitives (one source of truth — no parallel definition). Verified
with the real model: it varies layouts, writes bold that renders, and switches
ONE slide's layout without touching the others.

- **Layout registry, shared:** the agent now binds to `SLIDE_LAYOUTS` (the same
  14-layout registry the renderer + `applyLayoutToSlide` use), incl. each
  layout's `ai.bestFor/avoidWhen` — surfaced as a strict layout enum + a catalog
  in the system prompt (`lib/ai/tools/slideContent.ts`, `context.ts`).
- **Rich text kills the asterisk leak** (`lib/ai/richText.ts`): emphasis is
  STRUCTURED runs (`{text,bold?,italic?}`) → the studio's `TextRun[]` (renders
  as bold/italic), with a markdown→runs safety net so a stray `**` can never
  ship; bullet items flatten to plain (per-item runs are a studio cut).
- **Granular, id-addressed, non-destructive tools** (`lib/ai/tools/slides.ts`):
  `get_deck`, `get_slide`, `add_slide`, `update_slide`, `set_slide_layout`,
  `reorder_slides`, `delete_slide` — each wraps an existing slide patch and
  touches one slide. New additive `SET_SLIDE_CONTENT` patch (slide-level analog
  of `SET_BLOCK_CONTENT`). `write_slide_deck` is now per-slide layout + rich
  content and reserved for generating a FRESH deck.
- **Validate → repair → stage:** content is validated against the chosen
  layout's slots; failures return the message to the model to self-correct; all
  edits flow through the existing change-set staging.
- **No data-model change** (your "fix the wiring, not the model"): slot↔element
  mapping is derived from the slide's current layout; emphasis uses the existing
  `runs` model.
- **Verified:** `npm run verify:ai` (50 checks incl. layout choice, bold-as-runs,
  no-`**`-leak, non-destructive layout switch) · `verify:ai:int` (11) ·
  `verify-agent-live` (13, **real gpt-5.4-mini**: varied layouts, bold runs,
  get_deck→set_slide_layout, slide count preserved). build/lint/tsc green.

## AI Content Agent — first real AI (OpenAI), 2026-06-15

The first real AI layer: a Cursor-style **Content Agent** docked beside the
lesson editor. A creator types a request ("write a 5-slide intro deck and a
4-question knowledge check"); the agent streams its work, mutates the course
through tools, highlights every change for review, and discusses it.

- **Provider-agnostic core** (`lib/ai/*`): a `ModelClient` seam with the OpenAI
  Responses API behind it in ONE file (`providers/openai.ts`) + a deterministic
  `providers/mock.ts`. Server-side agentic loop (`agentLoop.ts`): stream a turn →
  run tool calls → feed results back → repeat (cap 12 + checkpoint).
- **Tools = the ops layer** (`lib/ai/tools/*`): read / structural / content
  writers, all mutating ONLY through the validated CoursePatch pipeline (new
  additive `SET_BLOCK_CONTENT` patch). Tool schemas are Zod → OpenAI-strict JSON
  Schema (`schema.ts`).
- **Change-set staging**: per-turn block diff (`changeSetDiff.ts`) → reviewable
  change-set (`changeSet.ts`); Accept clears, Reject replays the inverse. Editor
  shows an amber pending ring + inline Accept/Reject (`BlockFrame`) and a panel
  review bar; pending state survives reload (server-loaded).
- **Conversation persistence + grounding**: threads/messages in Postgres,
  replayed each turn (no provider-side state); a stable, cache-friendly system
  prompt built from the course plan + current lesson (`context.ts`).
- **Migration** (human-reviewed, applied): conversations / messages /
  change_sets / change_set_items, all RLS author-only.
- **Low-stakes assessments enforced structurally**: removed
  scores/passing/time/attempts/difficulty/points/due-dates from the quiz &
  homework types, Zod schemas, patches, factories, mock, manifest, and the
  studio UI — the schemas can no longer express a grade.
- **Server-only key**: `OPENAI_API_KEY` in `.env.local` (optional `OPENAI_MODEL`
  default `gpt-5.4-mini`). Routes run on the Node runtime, stream SSE.
- **Verification**: `npm run verify:ai` (34 checks — tools/schema/patch round-
  trip, no key) and `npm run verify:ai:int` (11 checks — full loop → tools →
  persist → change-set → accept/reject vs LIVE Supabase via the mock provider).
  `npm run build` + `npm run lint` green.

## C7 — rich text runs (34/34 cumulative — Part C complete)

- **Character-level formatting** for text, heading, and callout elements:
  the model gains `runs: TextRun[]` (`{text, marks: {bold, italic,
  underline, color}}`), with a reducer-maintained invariant —
  `concat(runs.text) === text` — so lint, AI rules, measurement, and search
  keep reading plain `text` completely unchanged. Updating `text` without
  runs clears formatting (a plain rewrite resets styling); old documents
  need no migration.
- **Marks are tri-state**: `bold: false` explicitly REMOVES the element
  weight (so un-bolding a selection inside a semibold heading round-trips;
  `execCommand` toggling surfaced this in verification).
- **Editing**: double-click opens a contenteditable overlay (no new deps);
  ⌘B/⌘I/⌘U format the live selection, and the toolbar's B/I/U + text-color
  swatches route to the selection while a session is open (whole-element
  styling otherwise — toolbar buttons/swatches now preventDefault on
  pointerdown so they never steal the selection). Blur commits ONE undo
  step: text + runs + auto-grow; Esc cancels. Commit serialization
  normalizes whatever the browser produces (b/strong/i/em/u, font-weight
  styles, `<font color>`, div/br breaks) into canonical merged runs.
- Bullet lists keep the plain one-item-per-line textarea (per-item runs =
  known cut). Other known cuts: links, per-selection font size/family,
  toolbar button states don't reflect the live selection yet, inspector
  text edits stay plain (and reset formatting). `document.execCommand` is
  deprecated-but-universal — accepted for this stage, isolated behind
  `richText.ts` for a future custom range implementation.
- **Verify**: double-click any text box, select a word, ⌘B — only that word
  bolds; select all, toolbar Italic — the selection italicizes; one undo
  reverts formatting + text together.

## C6 — real 2-point lines (30/30 cumulative)

- **Lines and arrows are now genuine segments**, not horizontal boxes:
  endpoint geometry lives as frame fractions (`points` on shape elements),
  so the frame stays the selection/snap/marquee AABB and move/resize keep
  working untouched. Old documents need no migration — absent `points`
  renders the legacy horizontal mid-line.
- **Endpoint handles**: a sole-selected line/arrow swaps the 8-handle resize
  box for two endpoint dots; dragging one keeps the other fixed, reshaping
  live (transient frame + points through the shared dragStore). Endpoints
  snap to the usual edge/center candidates (⌘/Alt bypasses); **Shift
  constrains the segment to 45° increments** (verified dx=dy=429.7).
- **One patch per reshape**: new `SET_LINE_ENDPOINTS` (absolute coords; the
  reducer derives a padded AABB — min 24px on the thin axis for a usable
  hit area — and frame fractions atomically). In the AI manifest.
- Arrowheads are now proper SVG markers that orient along the segment at
  any angle; viewBox matches the logical frame, so diagonals render
  undistorted. Stroke style (dash) and color carry over.
- Known difference vs GS: hit-testing/selection still uses the AABB, not
  the stroke; connectors (snap-to-shape anchors) deliberately deferred.
- **Verify**: insert an arrow → drag its end dot anywhere — a real
  diagonal; hold Shift — it clicks to 45° steps; one undo restores.

## C5 — equal-gap spacing guides + px chips (25/25 cumulative)

- **Equal-gap snapping** (Canva/GS): dragging an element (or selection bbox)
  between two row/column neighbors snaps to the point where both gaps are
  equal — per axis, only when no edge/center snap claimed that axis, same
  threshold and ⌘/Alt bypass as everything else. Pure math in `snap.ts`
  (neighbors = non-participants overlapping the moving frame on the cross
  axis).
- **Px measurement chips**: the two gap segments render with rose chips
  showing the gap in logical px, sized against the zoom so they stay
  readable at any scale (`GuideLine.label`).
- **Verify**: three shapes in a row with uneven gaps → drag the middle one
  toward the balance point — it clicks into perfect spacing with "170 ·
  170" chips (verified gaps 170.0/170.0 in the run).

## C4 — OS clipboard integration (23/23 cumulative)

- **Element copy is mirrored to the system clipboard** as a markered JSON
  payload (`lib/editor/clipboard.ts`): ⌘V falls back to it when the
  in-memory clipboard is empty — so paste now **survives reloads and
  crosses tabs**. Same-slide/+24 and in-place placement semantics carry
  through. Foreign/malformed payloads are rejected by the normal Zod patch
  validation; permission denial degrades silently to in-memory-only.
- **Plain text from anywhere pastes as a new text element** (GS behavior):
  copy text in any app → ⌘V on the canvas (or right-click → Paste, which
  centers it on the cursor).
- **The clipboard now holds ONE thing**: copying elements clears the slide
  clipboard and vice versa (previously both ⌘V handlers could fire and
  paste a slide AND elements in one keystroke); payload markers keep the
  two paste paths from misfiring cross-session. Context-menu Paste is
  always enabled (no-op when both clipboards are empty).
- Known limitation (documented in the module): a copy in another tab won't
  beat this tab's newer in-memory clipboard until reload.
- **Verify**: copy a shape → reload the page → ⌘V: it's back (+24). Copy a
  sentence from any app → ⌘V: a text element. Paste into a text editor
  after copying an element: you get the JSON payload (machine format).

## C3 — canvas zoom (20/20 cumulative)

- **Zoom 50–300%** on top of the fit-to-width scale: toolbar − / % / ＋
  control (the % chip resets), **⌘+ / ⌘− / ⌘0** (overriding browser page
  zoom inside the editor), zoom steps ×1.25.
- The canvas container becomes a **scroll viewport** when zoomed past 100%
  (native pan via scrollbars/trackpad); zoom changes keep the viewport
  CENTER stable. At 100% nothing changes visually (no scrollbars).
- All pointer math (drag, marquee, right-click paste point, guides,
  handles) now derives from the scaled stage's own rect, so it stays exact
  at any zoom + scroll — verified: a 120-screen-px drag at 156% moves
  exactly 120/scale logical px (185.8 vs 185.8 in the run).
- Logical coordinates are untouched — elements, patches, and the document
  never see zoom.
- **Verify**: toolbar ＋ twice → 156%, scrollbars appear, drag still lands
  precisely; ⌘0 snaps back to fit.

## C2 — text reflow everywhere + TEXT_CLIPPED lint (17/17 cumulative)

User-confirmed policy: **the box grows and reformats; text is never shrunk
to fit.**

- **Style commits reflow**: changing font size/family/weight, line height,
  letter spacing, or padding on a text-like element re-measures the content
  (same hidden-twin markup as the canvas) and grows the box in the SAME
  commit — one undo reverts style + height together. Wired into both the
  toolbar and the inspector Design tab.
- **Resize commits floor at content height**: a text box can't be committed
  shorter than its re-wrapped content — narrowing it grows it taller, from
  any path (drag handles, inspector W/H fields, multi-selection bbox
  resize). Shrinking the font later does NOT shrink the box back (grow-only).
  Known difference vs GS: group resize doesn't scale font sizes, so a
  narrowed text member grows instead.
- **New lint check `TEXT_CLIPPED`** (+ one-click "Grow box to fit"): catches
  boxes shorter than their content from paths the UI can't guard (AI
  patches, imports). Lint stays UI-free via a registered measurer (the
  editor shell registers it; SSR skips the check). Seed slide 3 now trips
  it deliberately (6 lint demos).
- **Measurer rebuilt on renderToStaticMarkup** — the old createRoot +
  flushSync version was illegal during render (lint runs in render), which
  silently returned wrong heights. Static markup is synchronous and
  render-safe; measurements are cached per element id + metrics key.
- **BUG FOUND & FIXED**: the quality-hint dropdown rendered UNDER the
  sticky slide toolbar (both z-30, toolbar later in DOM) — its Fix buttons
  were unclickable in the overlap. Panel raised to z-40.
- **Verify**: select a text box → inspector W = 240 → it grows taller as
  the text wraps; font size down — height stays; font size up — it grows
  (one undo reverts both). Slide 3's badge now shows "Text is taller than
  its box" with a working one-click fix.

## C1 — audit quick wins (10/10 checks, audit-suite.mjs)

- **BUG FOUND & FIXED: right-click collapsed multi-selections.** A
  right-click also fires pointerdown, which started a move gesture whose
  pointer-up ran the deferred-collapse — so context-menu actions on a
  multi-selection silently operated on ONE element. All gesture starts
  (element move, marquee, resize handles, bbox handles) are now gated to
  the primary button; right-click preserves the selection like GS.
- **#9 Multi z-order kept honest**: reorder actions now apply in
  z-aware order (front/backward → bottom-most first; back/forward →
  top-most first), so "Send to back" on a multi-selection moves the whole
  set with its internal stacking intact (verified: z 3<4 → 0,1).
- **#10 Marquee respects the entered-group scope** — rubber-banding inside
  a group selects only that group's members (was: silently exited to root).
- **#11 Select all**: ⌘A selects every visible, unlocked element on the
  slide (works with just the slide selected too); inside an entered group
  it selects only the group's members. Also a context-menu item.
- **#12 Paste placement (GS semantics)**: the element clipboard now records
  its source slide — pasting on ANOTHER slide lands in place, same slide
  offsets +24/+24, and context-menu paste centers the clipboard's bounding
  box on the right-click point (`canvasPoint` carried in the menu state).
- **#3b Rotation honesty**: `rotation` removed from the element schema —
  validated patches can no longer introduce rotated elements while the
  selection chrome / snapping / hit-testing are axis-aligned. The TS field
  and render path remain for forward-compat (legacy data still renders).
- **#16 Thumbnails memoized**: the reducer deep-clones the doc per patch,
  so identity-based memo can't work — thumbnails now compare a WeakMap-
  cached JSON snapshot per slide and skip re-render + re-lint when their
  slide didn't change.
- **#14 Undo verified, cap raised 50 → 100**: measured the doc at ~24 KB
  JSON (3 slides; a heavy 100-slide course projects to ~780 KB → ~76 MB at
  cap 100) — snapshots are fine until real-scale docs; inverse patches
  deferred to post-Supabase (comment in store.ts records the numbers).
- **#17 Export-fidelity ledger** recorded in CLAUDE.md (justify, shadows,
  dashes, triangle, nested groups, auto-height) for when PPTX export lands.
- **Verify**: right-click one of two selected shapes → Send to back —
  BOTH go behind, still stacked the same. Copy a shape, switch slides,
  ⌘V — it lands at identical coordinates. Right-click empty canvas →
  Paste — it lands centered under your cursor. ⌘A inside vs outside a
  group. Marquee while inside a group.

## B7 — A4: shadows, align-to-selection + distribute, text auto-grow (46/46 cumulative — Part A complete)

- **Shadows**: expressive `style.shadow` model (`{color, blur, offsetX,
  offsetY, opacity}`) with a preset UI — Design tab pills None / Subtle /
  Medium / Strong. Rendered as CSS `drop-shadow` on a body wrapper, so the
  shadow follows the actual pixels (glyphs, triangle geometry, image alpha)
  and the selection ring/handles never inherit it. Custom AI-set values show
  a "custom" note instead of silently mapping to the nearest preset.
- **Align to selection + distribute** (Arrange menu, multi-selections):
  align Left/Center/Right/Top/Middle/Bottom moves every UNIT (lone element
  or whole group closure — groups never tear) to the selection bounding
  box's edge/center; Distribute H/V (3+ units) equalizes the gaps between
  adjacent units, outermost units stay put (`lib/course/slide/arrange.ts`,
  pure math). One applyMany per action = one undo. Locked elements receive
  no moves. Mock AI understands "align these to the left" / "distribute".
- **Text auto-grow (Google Slides behavior, grow-only)**: while editing, a
  hidden twin of the REAL markup (callout label row, bullet gaps — textarea
  scrollHeight gets these wrong) measures the draft each keystroke and the
  overlay grows live; on commit `commitElementTextPatches` lands text +
  height as ONE undo step, capped at the slide's bottom edge. Manually
  enlarged boxes are respected (never shrinks). The inspector Content tab
  commits through the same path via a one-shot flushSync measurer
  (`measureTextLike.tsx`), so text edited there auto-grows too.
- **Undo sweep**: the cumulative suite's cleanup phases double as the
  one-undo-per-operation audit — every editor operation introduced in Part A
  (insert, drag, resize, group, ungroup, duplicate, paste, align, distribute,
  shadow, text+grow commit) reverses with exactly one undo. 46/46 checks.
- **Verify**: select the heading → Design tab → Shadow "Medium" → soft drop
  shadow appears (one undo removes). Double-click it, add 3 lines — the
  editor grows as you type; click away — the box keeps the new height; ONE
  undo restores both text and height. Select 3 shapes → Arrange →
  "Distribute vertically" → equal gaps; "Align left" → flush left edges.

## B6 — A3d: selection-bbox multi-resize (38/38 cumulative)

- **Multi-selections now have a real transform box** (Google Slides):
  one bounding box with 8 handles around all selected members
  (`MultiSelectionBox.tsx`); dragging a handle scales EVERY member
  proportionally about the opposite edge/corner — positions and sizes scale
  by one factor, so arrangements never shear.
- **Min-size floor**: the scale factor stops where the smallest member
  would drop below the element minimum (floors capped at 1, so an already-
  tiny member just can't shrink further without wedging the gesture).
- **Same modifier language as single resize**: Shift on a corner locks the
  bbox aspect ratio; snapping moves only the dragged edge(s) with the same
  6-screen-px threshold + guides; Cmd/Ctrl/Alt bypasses.
- Handles hide while ANY member is locked (the box outline stays); the box
  follows live during move gestures too, since it derives from the shared
  dragStore frames. One `applyMany` per gesture = one undo.
- Shared resize math (`rawResize`/`anchor`/`isCorner`) exported from
  `useElementDrag` instead of duplicated.
- **Verify**: shift-click two shapes → a box with handles wraps both → drag
  its SE handle: both scale together, spacing scales, guides appear near
  snap targets; one undo restores both frames.

## B5 — A3c: nested group / ungroup (34/34 cumulative)

- **Three new patches** (Zod-validated like everything else):
  `GROUP_ELEMENTS` splices a fresh group id into each member's `groupPath`
  at the current scope depth (validates ≥2 distinct units — so groups nest,
  Google-Slides style); `UNGROUP_ELEMENTS` removes one group id from every
  path (peels exactly one level); `DUPLICATE_ELEMENTS` clones a whole
  selection in ONE patch with group ids remapped, so duplicating a group
  yields a NEW group instead of clones silently joining the original.
- **`normalizeGroups` sweep**: after delete / ungroup / duplicate / layout
  application, group ids left with <2 units are dissolved automatically —
  no orphan "groups of one" can survive any operation.
- **Shortcuts**: ⌘G groups the selection, ⇧⌘G ungroups; ⌘D now duplicates
  via the one-patch path (one undo, clones re-selected, group preserved).
- **Surfaces**: Arrange menu gains a Group/Ungroup section (and now opens
  for multi-selections); context menu gains Group/Ungroup items (disabled
  when not applicable); paste (⌘V) now also preserves group structure via
  remapped ids; lone `DUPLICATE_SLIDE_ELEMENT` strips group membership (a
  single duplicated member must not join the source group).
- **Mock AI**: "Group these elements" / "ungroup" now work on
  multi-selections; manifest `allowedActions` extended to match.
- **Verify**: insert 3 shapes → shift-click two → ⌘G → click one: both
  select as a unit. Shift-click the third → ⌘G again: nested group of 3.
  Double-click a member: enters the outer group (inner pair selected);
  Esc walks back up. ⇧⌘G peels only the outer level. ⌘D on the inner pair:
  clones appear offset +24/24, selected, and grouped together. Right-click
  → Ungroup dissolves it. Every operation is exactly one undo step.

## B4 — A3b: marquee, multi-select, multi-move (25/25 cumulative)

- **Marquee selection**: drag on empty canvas rubber-bands a selection
  (intersection semantics, like Google Slides; hidden/locked excluded; plain
  click still selects the slide). Marquee rect renders live.
- **Shift-click** toggles whole *units* (an element, or its entire group
  closure once groups exist) in/out of the selection.
- **Deferred collapse** (GS behavior): pointer-down on a selected member
  never breaks the selection — dragging moves ALL members (uniform delta,
  bounding-box clamped, bbox-snapped, locked members stay put, one undo);
  a plain *click* collapses to the clicked unit on pointer-UP.
- **Group navigation scaffolding**: double-click descends into a group
  (selection scope), Esc walks up the ladder (members → enclosing group →
  slide). Double-click still opens the text editor when the element is the
  sole selection (edit gate via `soleSelected`).
- **Multi keyboard**: arrows/Delete/⌘D/⌘C/⌘X/⌘V all operate on the whole
  selection as single undo steps.
- **DOM/AI**: selected elements now carry `data-ai-selected` — agents (and
  the test suite) can read selection state straight from the DOM.
- **Verify**: marquee over several elements → drag one member → all move,
  one undo restores all; shift-click to build a selection; click one member
  → collapses to it.

## B3 — A3a: snapping + guides, aspect-lock, element clipboard, context menu (19/19 cumulative)

- **Smart guides + snapping** (`lib/course/slide/snap.ts`): dragging snaps
  edges/centers to slide edges/center and to every other visible element's
  edges/centers; rose guide lines (1 screen px) render during the gesture.
  Threshold ≈ 6 *screen* px converted through the stage scale, so snapping
  feels identical at any zoom. **Cmd/Ctrl or Alt bypasses snapping.**
  Keyboard nudges never snap. Resize snaps only the dragged edge(s).
- **Shift = aspect-lock** on corner resize handles (anchored at the opposite
  corner; with snapping the dominant axis snaps, the other re-derives).
- **Element clipboard**: ⌘C/⌘X/⌘V on selected element(s) — paste re-ids,
  offsets +24/24, and selects what was pasted. Stored in-memory (uiStore,
  not persisted, separate from the slide clipboard).
- **Right-click context menu** on canvas elements (Cut/Copy/Paste/Duplicate/
  Delete + z-order; multi-aware: acting on one member of a selection acts on
  all) and on empty stage (Paste). Esc/backdrop closes. Right-click selects
  the element under the cursor unless already selected (Google Slides
  semantics).
- **BUG FOUND & FIXED (real UX bug surfaced by verification): selection used
  to change the toolbar's height** — contextual buttons appeared, the
  toolbar wrapped to a second row, and the entire canvas jumped ~16px mid-
  interaction. Element actions now render permanently and disable without a
  selection (constant toolbar height, like Google Slides). Regression-checked
  (`dy=0.0`).
- **Verify**: drag a shape near the slide center → rose guide appears and it
  clicks into place; hold ⌘ to place it 4px off an edge freely; Shift-drag a
  corner handle → ratio locked; ⌘C/⌘V → offset copy; right-click → menu.

## B2 — A2: shapes as first-class objects (8/8 cumulative checks)

- **Shape picker** in the toolbar Insert group (replaces the lone
  rectangle-only button): rectangle, rounded rectangle, ellipse, triangle
  (new `ShapeKind` + SVG polygon renderer), line, arrow — each with
  kind-appropriate default frames (`addShapePatch` in commands.ts). Rounded
  rectangle = rectangle + 24px corner radius preset (not a separate kind;
  radius stays editable).
- **Stroke style**: `borderStyle: solid | dashed | dotted` added to the
  element style model/schema; renders via CSS border for boxes and
  `stroke-dasharray` for triangle/line/arrow.
- **Inspector Design tab — Stroke section** (all element types): stroke
  color swatches, width, style pills. Fill/radius/opacity were already
  present; shadow lands in B7.
- Shapes already shared select/move/resize via the element pipeline; they
  now also participate in everything later batches add (snap, multi-select,
  group) for free.
- **Verify**: toolbar ⬡ Shapes → insert each kind; select the triangle →
  Design tab → Stroke width 4 + "dashed" → dashed outline; every insert and
  style change is one undo step.

## B1 — A1: text alignment fixed; object alignment moved to Arrange (11/11 checks)

- **BUG FIX (P0)**: the toolbar's align buttons previously MOVED the text box
  (`moveElementPatch`); they were removed from the element group. Text
  alignment is now a proper text control.
- **Text toolbar** gains two popovers (enabled for text/heading/callout/
  bullet list): *Text alignment* — left / center / right / **justify**
  (new option in the model + schema) — and *Vertical alignment* — top /
  middle / bottom. Both write `style.textAlign` / `style.verticalAlign` via
  `UPDATE_SLIDE_ELEMENT`; the box frame is untouched (verified byte-identical
  left/top/width).
- **Arrange menu** (new toolbar dropdown, Google-Slides "Arrange > Align"):
  *Position on slide* — Left/Center/Right/Top/Middle/Bottom — moves the BOX
  via `MOVE_SLIDE_ELEMENT` (new `alignedY` helper in geometry.ts). Menu
  closes on action, like Slides. Align-to-selection + distribute land in B7.
- Inspector Design tab: justify option + vertical-alignment pills added for
  parity.
- **Verify (click-path)**: select the "Two Pointers" heading on slide 1 →
  toolbar ¶-align button → Center: the text re-centers inside its box while
  the box stays put (watch x/y/w/h in Design tab). Toolbar ↕ button → Middle:
  text drops to the box's vertical center. Toolbar "Arrange" → Left: now the
  BOX moves to the slide's left margin. One undo per action.

## B0 — Selection groundwork (foundation, no visible behavior change)

- **Selection model**: added multi-select kind
  `{kind:"elements", ids, slideId, blockId, lessonId, scope?}` and an optional
  `scope` (entered-group path) to single-element selections
  (`lib/course/types.ts`).
- **Group encoding**: `groupPath?: string[]` on every slide element (nested,
  Google-Slides-style; outermost group first) + pure navigation helpers in
  `lib/course/slide/groups.ts` (unit closures, scope checks, degenerate-group
  detection). No UI yet — lands in B4/B5.
- **Selection repair fixes** (`lib/course/store.ts`, `lib/course/queries.ts`):
  multi-selections shed deleted ids instead of being destroyed by the
  after-commit repair; FIXED pre-existing bug where deleting a selected
  element collapsed selection to *course* instead of its lesson.
- **Transient gesture store** `lib/editor/dragStore.ts` (deliberately separate
  from the persisted uiStore — pointermove-frequency writes must not hit
  localStorage). `useElementDrag` now writes per-participant frames there;
  dragging an element of a future multi-selection moves the whole selection,
  clamped by the selection bounding box (not per-element, which would shear
  arrangements). One `applyMany` per gesture = one undo step, as before.
- Mock AI: minimal handling for multi-selections (batch delete; group/align
  verbs arrive with the Arrange feature).

**Verify**: existing flows unchanged — drag/resize a single element, undo once
restores it; selection ring/handles as before. (Covered by the B1 Playwright
run.)
