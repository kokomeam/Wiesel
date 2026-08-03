# TUTOR-1 — The Mastery Engine (Wave 2)

> Per-learner, per-concept knowledge estimates folded deterministically from
> the evidence stream. Pure math + SQL — **Wave 2 makes zero model calls** (a
> grep guard in `verify-tutor-mastery.ts` enforces it). Core:
> `lib/tutor/mastery/*`. Companions: `docs/tutor/concept-graph.md` (Wave 1),
> `docs/tutor/architecture.md`.

## The model — Bayesian Knowledge Tracing (4-parameter)

Per (learner, course, concept node), `p_learned` = P(L), the probability the
concept is learned, updated per evidence item (`lib/tutor/mastery/bkt.ts`):

- Correct observation: `P' = P·(1−S) / (P·(1−S) + (1−P)·G)`
- Incorrect observation: `P' = P·S / (P·S + (1−P)·(1−G))`
- Learning transition after every observation: `P'' = P' + (1−P')·T`
- **Weighted observation** (weight w ∈ (0,1]): `P_new = w·P'' + (1−w)·P_prev`
  — the fully-updated posterior blended with the prior, so weak evidence
  moves the estimate proportionally.

Defaults (course-level, env-overridable via `TUTOR_BKT_*` —
`lib/tutor/mastery/config.ts`): **P(L₀)=0.25 · P(T)=0.20 · P(S)=0.10 ·
P(G)=0.20**. Guessing at 0.20 ≈ a 4-5-option MC baseline; slipping at 0.10
keeps one careless miss from cratering a solid estimate.

## Evidence weights (`weights.ts`) — and why

| Source | Direction | Weight | Rationale |
| --- | --- | --- | --- |
| Quiz detail / practice answer, attempt 1 | from correctness | **1.00** | The cleanest signal: a first attempt measures knowledge |
| … attempt 2 | from correctness | **0.50** | Retry contamination begins: partial answer-memory |
| … attempt ≥3 | from correctness | **0.15** | (A1.2) a third try mostly measures memory of the item, not the concept — weighting prevents grind-to-mastery inflation |
| Historical detail-less attempt (block-level) | score ≥ 60% | **0.30 × ordinal** | Pre-deployment attempts have no per-question detail; a block score is a blunt instrument spread across the block's anchored nodes — the cold-start signal, deliberately weak |
| Hint rung 0–1 | positive | 0.10 | Productive struggle — sought a nudge, kept working |
| Hint rung 2–3 | negative | 0.15 | Needed substantial scaffolding |
| Hint rung 4 | negative | 0.30 | The answer was given — strong non-mastery signal |
| Self-report | learner's claim | 0.25 | Honest but noisy self-assessment |
| Tutor inference weak / moderate | metadata direction | 0.10 / 0.25 | The Wave-3 side-channel; capped low — a model's impression never outweighs assessment |
| Content `completed` | positive | 0.10 | Finished the material |
| Content `rewatch` / `scrub_back` | negative | 0.05 | Mild struggle signals |
| Derived `dwell_over_median` | negative | 0.05 | NOT an event — computed in the refold when a slide's dwell > 2× the cohort median (`rollup_slide_dwell`) |

Ordering principle: **assessment > behavioral; negative behavioral weighs
less than positive assessment** — behavior nudges, answers decide.

## Decay (`bkt.ts decay`)

`decayed_p = P(L₀) + (p − P(L₀)) · 2^(−days / halfLife)` where
`halfLife = H₀ · (1 + ln(1 + evidenceCount))`, H₀ = 30 days
(`TUTOR_DECAY_HALFLIFE_DAYS`), days measured from `last_positive_at`.
Estimates decay toward the prior (never below it, never above the undecayed
value); volume-scaled half-life means well-evidenced mastery fades slower.
Computed lazily on read (the refold stamps `decayed_p` at `computed_at`) and
**materialized nightly** so queue/aggregate surfaces stay fresh without
per-request math.

## The refold (`refold.ts` + `loader.ts` + `writer.ts`)

A deterministic fold of the ordered evidence stream per (learner, course) —
idempotent by construction (Amendment R-22): same evidence in, byte-identical
`learner_mastery` out. Sources gathered by the loader: `quiz_attempt_detail`
(per-question, from deployment forward) · historical detail-less
`quiz_attempts` (block-level, weaker — see cold start) · the five evidence
event types · slide-dwell vs cohort medians. Evidence is ordered by
`(at, sourceId)`; quiz attempt ordinals are **derived** from `(created_at,
id)` per (user, publication, block) — never a stored mutable counter.

**Lineage-aware** (`lineage.ts`): evidence referencing retired/split/merged
node ids resolves through Wave 1's lineage — merged sources map to the
survivor (factor 1); split parents map to each child with the recorded
**0.75** confidence factor multiplying evidence weight; chains resolve
transitively (depth-guarded); ids that resolve to nothing active are silently
dropped. This makes the refold pure AND lineage-correct simultaneously
(AC-T1.7b).

Writes: full-replace per (learner, course) via the service-role writer.
Concurrency needs no lock — output is deterministic and the Inngest functions
serialize per (user, course) by concurrency key.

## Scheduling (Branch A — Inngest)

- `tutor-mastery-refold` on `tutor/mastery.refold.requested` {userId,
  courseId} — defined and handled NOW; **emitted by Wave 3's evidence routes
  later** (Wave 2 wires client emission for nothing — the sequencing-honesty
  rule).
- `tutor-mastery-nightly` (cron 04:00): refolds active pairs (new evidence
  since `computed_at`, or mastery >24h stale — decay materialization), then
  materializes the graph-query result tables.

## Graph-aware queries (`queries.ts`)

Pure TS, golden-mirrored (the `lib/analytics/stats.ts` pattern), materialized
nightly into result tables; read RPCs are trivial SQL over materialized rows:

- **weakest_nodes** — (1 − decayed_p) × (1 + transitive prerequisite
  dependents): low mastery with high downstream leverage first.
- **root_cause** — the DEEPEST below-threshold ancestor over prerequisite
  edges (threshold `TUTOR_MASTERY_THRESHOLD` = 0.6): "you're stuck on C
  because A never landed."
- **review_queue** — decay-gap (p_learned − decayed_p) × downstream
  importance, below-threshold boosted; ranked per learner into
  `mastery_review_queue`.

Edge direction convention: source = the prerequisite, target = the dependent.
Traversals are cycle-tolerant (the DAG is write-path-enforced; readers stay
defensive).

## Privacy — the strict regime

`learner_mastery`: ONE policy (learner reads own rows); `mastery_review_queue`
+ `mastery_course_aggregate` + `quiz_attempt_detail`: RLS on, ZERO policies.
Learner surfaces read through own-row definer RPCs (`my_review_queue` — which
joins concept titles, disclosing only the learner's own queue's concepts —
`my_quiz_detail`); creators see EXCLUSIVELY the cohort-floored
`concept_mastery_aggregate` (floor **5**, applied inside the SQL; below the
floor: `suppressed = true` and every value INCLUDING the count is null; zero
learners: no row). `MASTERY_MIN_COHORT` in config.ts is the TS mirror, regex
drift-guarded against the migration. The legacy `quiz_attempts` posture is
untouched — the strict regime governs only the new mastery surfaces.

## Cold start (day one, and every new course)

No backfill of per-question detail is possible (historical attempts carry
none). The engine is useful from day one anyway: historical block-level
attempts fold as weaker evidence (0.30×), dwell/heuristics contribute, and
detail accrues from deployment forward. The student home's "Worth a review"
consumes `my_review_queue` **when rows exist** and falls back to the existing
quiz-heuristic otherwise — a learner with zero evidence sees exactly what
they saw before Wave 2.

## Tuning guide

Every knob is env-based (config.ts): raise `TUTOR_BKT_PG` for
guessing-heavier assessment formats; shorten `TUTOR_DECAY_HALFLIFE_DAYS` for
skill-perishable domains; the ordinal weights and hint-rung weights are the
first levers if grind-inflation or hint-avoidance appears in the field.
Changing any weight changes refold OUTPUT ONLY on the next refold — history
is never rewritten in place, just re-derived (rerun-safe by R-22). The
pure-suite goldens pin every default: a silent edit trips
`verify-tutor-mastery.ts`.
