# TUTOR-1 — Wave 3 Checkpoint: Tutor Runtime

**Date:** 2026-08-04 · **Status:** COMPLETE → **HARD STOP** (per the execution
order, this wave ends at a hard stop regardless of results; no Wave 4/5 work
has been started). Henry's review artifacts: the golden-transcript suites
(`scripts/verify-tutor-runtime.ts`, `scripts/verify-tutor-session.ts`) and the
live 10-turn cache-smoke transcript (§5 below, reproducible via
`npx tsx scripts/smoke-tutor-cache.ts`).

---

## 1. Commits (all wave-authored, on `main`)

### W3.0 pre-items + gate work (10 commits)

| Commit | What |
|---|---|
| `5fcbe45` | pre-item 1 — ItemRow adopts the worktree's UI-1 token classes |
| `57c95aa` | pre-item 2 — curated agent-panel labels for 15 social/publish/clips tools |
| `307d900` | pre-item 3 — ConfirmDialog `z-[100]` → `z-100` |
| `40474b1` | pre-item 4 — Wave-2 checkpoint ConfirmDialog row corrected to the evidence |
| `6e8fafe` | pre-item 4 (completion) — literal NUL stripped from the Wave-2 checkpoint |
| `871f955` | gate fix — sidebar portal-switcher subtitle to AA contrast (the one axe violation behind 3 ui:browser failures) |
| `b65132d` | gate fix — hub crashed to the error boundary whenever an approval was pending (RSC Flight thenable `.then()` returns undefined) |
| `95761aa` | gate — `/studio` 550→600, `/marketing` 300→315 budget renegotiation (Henry-approved) |
| `bec6e78` | gate — sync-browser suite modernized to the ratified UI-1 hub anatomy |
| `769c6f9` | gate — `/marketing` 315→330 (Henry-approved; 315 sat inside the measurement variance band) |

Post-fix gate results: `verify:budgets` 5/5 PASS exit 0 · `ui:browser` 121/121 ·
`sync:browser` 25/25.

### Wave phases

| Commit | Phase |
|---|---|
| `6fb8851` | W3.1 + W3.2 — per-principal pools, hardened semaphore, pooled cost decorator; threads/charter/escalation schema |
| `3b22396` | W3.3 — layered prompt architecture, five-tool runtime, scaffolding + grounding |
| `d305bfe` | W3.4 — `/api/learn/tutor` route, turn persistence, the evidence seam ALIVE |
| `a645474` | W3.5 — session behaviors, assessment integrity, live conformance, cache smoke MEETS_TARGET |

### Migrations

- `supabase/migrations/20260804100000_tutor_threads_charter.sql` — **applied to
  the live project**: `tutor_threads` (unique user+course), `tutor_turns`
  (immutable-on-UPDATE trigger; learner INSERT pinned `role='learner'`), 6
  charter columns + `tutor_charter_versions` (append-only, author-RLS) +
  pointer FK, `tutor_escalation_candidates` (status-only trigger;
  `consent_pending` → {`consented`,`withdrawn`} terminal).

---

## 2. Acceptance criteria — every AC, named test file, literal exit code

> Naming note (Wave-1/2 convention, unchanged): the order's `*.test.ts` names
> map to this repo's `scripts/verify-*.ts` runnable suites.

| AC | What was proven | Test file | Result / exit |
|---|---|---|---|
| AC-T0.1 | Saturated creator pool does not delay a concurrent tutor turn beyond queue-free latency (per-instance) | `scripts/verify-concurrency-pools.ts` | 37/0 · exit 0 |
| AC-T0.2 | Exhausted learner pool queues FIFO, emits `queued` with correct 1-based position, drops nothing; an aborted waiter frees its place | `scripts/verify-concurrency-pools.ts` | 37/0 · exit 0 |
| AC-W3S.1 | RLS matrix: learner reads own threads/turns/candidates; author session reads ZERO rows across all three; instructor-role turns writable only by service role; turns immutable post-insert (learner UPDATE = silent 0-row no-op under RLS + trigger backstop) | `scripts/verify-tutor-threads-int.ts` | 24/0 · exit 0 |
| AC-T5.2 (schema half) | Charter edit writes a version row (actor + timestamp) FIRST, then settings + pointer; the next assembled prompt reflects it byte-stably. UI half remains Wave 5 | `scripts/verify-tutor-threads.ts` (charter sections) | 95/0 · exit 0 |
| AC-T3.1 (re-scoped) | Structural byte-stability of L0/L1/L2 + a measured 10-turn live smoke with a deliberate 5-minute gap; ≥0.7 cached ratio from turn 2 | `scripts/verify-tutor-runtime.ts` (structural) + `scripts/smoke-tutor-cache.ts` (live) | 60/0 · exit 0; smoke **MEETS_TARGET**, min ratio from turn 2 = **0.788** (§5) |
| AC-T3.2 | Two learners, same (publication, lesson, charter): byte-identical `system` (= `TUTOR_L0` verbatim, 6,515 chars) and `developer` (L1+L2); only L3/L4/message differ | `scripts/verify-tutor-runtime.ts` | 60/0 · exit 0 |
| AC-T3.3 / AC-T3.4 | Golden rung behavior per style (opening clamps 1/2/3); "just show me" → rung 4 in ALL THREE styles through a full `runTutorTurn` | `scripts/verify-tutor-runtime.ts` | 60/0 · exit 0 |
| AC-T3.5 | 20 fixture turns: every anchor resolves, flags empty; unanswerable fixture question → escalation proposal with zero fabricated citations; strict canon suppresses ⟦s⟧ spans | `scripts/verify-tutor-runtime.ts` | 60/0 · exit 0 |
| AC-T3.6 | Tool registry is EXACTLY the five (`get_lesson_context`, `get_mastery_summary`, `generate_practice`, `emit_evidence`, `propose_escalation`); no content-mutation or messaging capability; `emit_evidence` writes NOTHING; `propose_escalation` inserts exactly one `consent_pending` row; practice refs are distinct uuids, `itemBankRef` null [FWD] | `scripts/verify-tutor-runtime.ts` | 60/0 · exit 0 |
| AC-T3.7 | Root-cause interjection fires EXACTLY ONCE on the seeded weak-prerequisite learner; declined → suppressed for the session; marker persists via `grounding.sessionMarkers`; 31-min silence resets | `scripts/verify-tutor-session.ts` | 57/0 · exit 0 |
| AC-T3.8 (reworded) | Request for the active quiz question's answer → declined/scaffolded per charter (`block` short-circuits BEFORE the model: zero calls, zero evidence; `concept_review_only` clamps rung ≤3 with charter-tone defer copy, beating even an explicit "just show me"); general concept question → answered | `scripts/verify-tutor-session.ts` | 57/0 · exit 0 |
| AC-W3R.1 | Route auth matrix: un-enrolled 403; author preview typed-blocked with ZERO evidence rows; disabled course typed-disabled; enrolled learner streams `{queued,position}` → one `{turn}` payload → `{done}` (no fake token deltas) | `scripts/verify-tutor-route-int.ts` | 30/0 · exit 0 |
| AC-W3R.2 | Mid-stream abort: pool slot freed (state clean), partial turn NOT persisted as assistant content, thread resumable | `scripts/verify-tutor-route-int.ts` | 30/0 · exit 0 |
| AC-W3R.3 | Practice answer → practice-result evidence (ordinal-weighted) → refold event → `learner_mastery` updated for the targeted (learner, node) pair | `scripts/verify-tutor-evidence-int.ts` + `scripts/verify-tutor-mastery-int.ts` | 32/0 · 47/0 · exit 0 each |

---

## 3. Full gate results (exit codes captured bare, no pipes)

| Gate | Result |
|---|---|
| `npm run verify:tutor` (12 pure suites: models 49 · telemetry 36 · graph 70 · extraction 86 · reconcile 64 · evidence 70 · mastery 77 · queries 46 · concurrency-pools 37 · threads 95 · runtime 60 · session 57 = **739 checks**) | exit **0** |
| `npm run verify:tutor:int` (graph 14 · extraction 33 · reconcile 36 · evidence 32 · threads 24 vs live Supabase) | exit **0** |
| `scripts/verify-tutor-route-int.ts` (standalone, live Supabase) | 30/0 · exit **0** |
| `scripts/verify-tutor-mastery-int.ts` (standalone, live Supabase) | 47/0 · exit **0** |
| `npm test` (every pure suite in the repo) | exit **0** |
| `npm run build` | exit **0** |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0** — exactly the 1 pre-existing warning baseline (`scripts/e2e-inngest-live.ts` `acct`) |

---

## 4. Live model validation (Luna)

From the W3.3 pre-flight smoke (`scripts/smoke-tutor-models.ts`, run live FIRST
per R-10): the `tutor_turn` model `gpt-5.6-luna` accepted a structured
strict-JSON call at the registry effort in **1.69s**, cost **$0.0000458**,
returning a real provider `responseId`. (`practice_gen` shares Luna;
registry printed by the same smoke.)

---

## 5. Cache smoke — the live 10-turn transcript (review artifact)

`npx tsx scripts/smoke-tutor-cache.ts` — realistic 2–8s think-time cadence,
one deliberate 300s gap before turn 7 (the 5-minute cache-TTL probe). Final
run (all conformance fixes in):

```
turn | gapBefore | inputTokens | cachedTokens | ratio | latencyMs | rung
-----|-----------|-------------|--------------|-------|-----------|-----
   1 |         - |        2637 |            0 |     0 |      4454 |    2
   2 |        3s |        2768 |         2593 | 0.937 |      4232 |    1
   3 |        4s |        2871 |         2593 | 0.903 |      3493 |    2
   4 |        7s |        2972 |         2593 | 0.872 |      5313 |    2
   5 |        5s |        3056 |         2593 | 0.848 |      3592 |    2
   6 |        3s |        3128 |         2593 | 0.829 |      6408 |    4
   7 |      300s |        3266 |         2593 | 0.794 |      2950 |    1   ← the 5-min-gap turn
   8 |        3s |        6647 |         5834 | 0.878 |      8242 |    1
   9 |        6s |        6691 |         5851 | 0.874 |      8242 |    1
  10 |        7s |        3290 |         2593 | 0.788 |      3270 |    4
```

- **Verdict: MEETS_TARGET** — every turn from turn 2 ≥ 0.7 (min **0.788**).
- **The 300s-gap turn cached at 0.794** — the L0/L1/L2 prefix SURVIVED the
  5-minute TTL probe at this cadence; no chaining needed for cache health.
- **All 10 turns `ok:true`** with a sane rung arc: opens at 2
  (guided_default), probes at 1, climbs to 2 on stuck signals, rung 4 on both
  explicit asks (turn 6 "concrete numeric example", turn 10 "summarize").
- Turns 8–9 ran a tool round (input ~6.6k): the ratio HELD (~0.87) because the
  replayed prefix re-cached — absolute cached tokens more than doubled (5,834).
- Layer byte-stability: `true` (asserted in-process before the live turns).
- **First-token latency: honestly N/A** — the turn is ONE structured
  non-streamed call this wave; `latencyMs` is total round-trip (2,950–8,242ms
  this run).

**Measured per-turn INPUT cost, cached vs uncached counterfactual** (Luna
pricing from `modelConfig.ts` — flagged there as placeholder pending provider
publication: $0.25/MTok input, $0.025/MTok cached; per-turn output tokens are
not in the transcript, so this is the input side, which is what caching
affects):

```
turn  with-cache   if-uncached   saved
   1  $0.000659    $0.000659       0%
   2  $0.000109    $0.000692      84%
   3  $0.000134    $0.000718      81%
   4  $0.000160    $0.000743      79%
   5  $0.000181    $0.000764      76%
   6  $0.000199    $0.000782      75%
   7  $0.000233    $0.000816      71%
   8  $0.000349    $0.001662      79%
   9  $0.000356    $0.001673      79%
  10  $0.000239    $0.000822      71%
TOTAL $0.002618 vs $0.009332 — 72% input-cost reduction from the prompt cache
```

Every live turn also landed a `tutor_model_call` cost row via the
`withPooledModel` decorator (the single interception point).

---

## 6. The session definition (quoted from `lib/tutor/runtime/session.ts`)

> A session is the TRAILING WINDOW of thread turns whose consecutive gaps are
> EACH strictly less than SESSION_GAP_MS (30 minutes). Walking newest → oldest,
> we keep including turns until we hit a gap ≥ 30 minutes; everything from that
> boundary forward (inclusive of the newer side) is the current session. A gap
> of EXACTLY 30 minutes STARTS A NEW SESSION (the boundary is `< 30min` to stay
> in-session; `>= 30min` breaks it). A thread with one turn is a one-turn
> session; an empty thread is an empty session.

Session membership is a function of timestamps only; once-per-session
behaviors persist their firing as markers on the assistant turn's
`grounding.sessionMarkers` (root-cause interjection:
`root_cause_interjection`), so the derivation is stateless and replayable.

---

## 7. P-3 status (store:true / chaining) — pending, non-blocking

Still awaiting Henry's decision. The seam is BUILT and dormant:
`TUTOR_ENABLE_CHAINING` (default OFF, read at call time) collapses L4 to the
provider's `previousResponseId`; foreground turns ship `store:false` while
off. The smoke's TTL result (§5: the 300s-gap turn cached 0.794) means
chaining is NOT needed for cache health at realistic cadence — it remains a
privacy/latency decision, not a cost one.

---

## 8. Deviations & disclosures (target was empty; two found-and-fixed items inside wave scope)

1. **Live-conformance defect (W3.3 follow-up finding, surfaced by the W3.5
   smoke; agent E's report framed it exactly so).** The first live smoke run
   had all 10 turns `ok:false`. Probing live categorized THREE stacked causes,
   each fixed in `a645474` with pure regression checks
   (`verify-tutor-runtime.ts` "live-conformance regressions", 8 new checks):
   - `practiceItems: null` failed Zod parse — the repo's own strict-JSON
     converter makes optionals NULLABLE on the wire, so the model correctly
     emits `null`; the contract now accepts it (the house convention the one
     field had missed).
   - The model cited by TITLE because L2 never showed ids. L2 now carries
     `(lessonId: …)` / `(blockId: …)` / `(nodeId: …)` tags + a cite-by-id
     instruction. Ids are snapshot-deterministic → L2 stays byte-stable per
     (publication, lesson); **L0 untouched, no TUTOR_PROMPT_VERSION bump**.
   - An evidence item with a mangled `nodeId` cost the ENTIRE turn
     (`schema_parse_failed`). The turn contract now accepts any string
     `nodeId` and the loop drops non-resolving items with flag
     `evidence_dropped` (mirror of `citation_dropped`); the frozen Wave-3
     event schema still gates emission, so only resolving uuids reach the
     analytics stream.
   After the fixes: the final smoke is 10/10 conformant (§5).
2. **W3.1 test-wiring gap (test-only, not a product regression).**
   `verify-tutor-extraction-int.ts` passed BARE mock models into
   `runGraphExtraction`; W3.1 retired the inline telemetry emission in favor
   of the `withPooledModel` decorator, so the suite's cost checks read 0 rows
   (the LIVE Inngest caller was correctly wired all along). The suite now
   wraps its mocks exactly like `lib/inngest/functions/tutorGraph.ts` → 33/0.
   Caught because this close-out re-ran the full int chain rather than
   trusting the last recorded result.
3. Cosmetic, disclosed for completeness: 7 lint warnings in wave-authored
   files (unused underscore params) were cleaned to restore the exact
   1-warning repo baseline; `verify-tutor-session.ts` was wired into
   `verify:tutor` (left to the close-out by agent E, per plan).

No capability, table, or behavior exists beyond the governing documents
(zero-surprise rule). No UI was built this wave. Nothing was merged, rebased,
force-pushed, or committed from pre-existing uncommitted work.

---

**HARD STOP.** Waves 4/5 are not started. Henry reviews the runtime behavior
via the golden suites + the §5 smoke transcript before the parallel fan-out.
