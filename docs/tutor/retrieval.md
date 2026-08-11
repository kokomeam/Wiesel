# Tutor retrieval — scope policy, expansion, τ (TUTOR-1 Amendment A4)

How the tutor decides **which course content to ground a turn on**: eligibility,
tiered retrieval, the four expansion codes, the calibrated relevance threshold τ,
and the `[FWD]` `source_tier` seam. Companion: `threading.md` (conversations),
`docs/audits/TUT-A4-audit.md` (the Wave-0 audit).

Code: `lib/tutor/retrieval/*` (chunker, embedStore, retrieve, eligibility,
conceptLessons, expansion, forward, scopePolicy, citationLabels, config). Wired
into the turn in `lib/tutor/runtime/loop.ts`; the DB is `tutor_chunks` +
`tutor_retrieve_chunks` (migrations `20260810140000`, `20260811100000`).

## The index (Wave 2)

At **publish**, each live publication is chunked and embedded ONCE into
`tutor_chunks`, keyed by `publication_id` (the immutable snapshot). The unit is
the **slide** for slide decks and the **block** for non-deck text blocks (quiz /
lecture / example / homework / exercise / resource); `imported_deck` + `video`
carry no in-snapshot prose and are skipped. Every chunk stores its `lesson_id`,
`block_id`, `slide_id?`, `text` (prefixed with a `module › lesson` heading), an
`embedding vector(1536)` (text-embedding-3-small), a generated `tsvector`, a
resolvable `display_anchor` `{lessonId, blockId, slideId?}`, and
`source_tier = 'canon'`.

Embedding fires via the `tutor/chunks.embed.requested` Inngest event (creator
pool — never the learner pool). It is **idempotent by publication**: an unchanged
republish (same publication row) re-embeds nothing.

**Hybrid retrieval** (`tutor_retrieve_chunks`, a SECURITY DEFINER RPC): a
pgvector cosine arm (hnsw) fused with a `tsvector` lexical arm
(`websearch_to_tsquery`) by **reciprocal rank fusion (k=60)**, so exact
terminology a pure-vector search misses ("2-3 tree", "LLRB", "amortized") is still
surfaced. The eligible-lesson filter runs **inside** the SQL, never as a
post-filter. The RPC returns each chunk's raw cosine **similarity** (the τ signal —
see Calibration).

Query embeds go through an **un-pooled** client (the route passes
`createOpenAIModelClient()` as `embedModel`) so retrieval never contends with the
interactive tutor chat pool.

## Eligibility (the scope boundary)

A lesson is **eligible** for retrieval iff the learner has **completed** it
(`learn_progress.status = 'completed'` — the reusable predicate) **or** it is the
**active** lesson. Nothing else — never lesson ORDINAL position. A learner who
jumped ahead has few eligible lessons, and that is correct.

`eligibility.ts`: `loadCompletedLessonIds` (best-effort; any error → empty set,
the conservative direction) + `computeEligibleLessons` (active ∪ completed).
Every retrieval query is filtered to this set, so an **incomplete lesson is never
retrieved from** (property-tested over 100 generated queries).

## Tiers

- **Tier 1 — the active lesson.** Always retrieved. Budget 6 chunks
  (`TUTOR_RETRIEVAL_TIER1_BUDGET`).
- **Tier 2 — completed lessons.** Retrieved ONLY under one recorded expansion
  code. Budget 4 chunks (`TUTOR_RETRIEVAL_TIER2_BUDGET`).
- **Tier 3 — none.** No source of model-knowledge exists in A4 (see
  `source_tier` below).

## Expansion — the four codes

Tier-2 retrieval is permitted only under one enumerated, event-logged condition
(`expansion.ts`, priority-fused — the most intentful signal wins; no code fires
into an empty completed-lesson pool):

| Code | Fires when |
|------|-----------|
| `explicit_request` | the learner asks to compare / combine / relate / review across topics, or names other material (`EXPLICIT_REQUEST_RE`) |
| `multi_concept_span` | the question maps (lexically) to concepts in **more than one** lesson, ≥1 of them completed |
| `prerequisite_gap` | the concept graph shows a **weak/absent prerequisite** of an active-lesson concept (`rootCause` over the prerequisite DAG + the learner's mastery), covered by a completed lesson |
| `insufficient_local_context` | **every** Tier-1 result falls below τ — the active lesson lacks the answer locally |

Every expansion emits **`tutor.retrieval.expanded`** carrying the code, the
lessons drawn from, and the tier counts. Expansion never occurs without a code
(invariant-tested).

## τ — the relevance threshold, calibrated

`insufficient_local_context` and the provenance gate (below) compare a Tier-1
chunk's **cosine similarity** to τ. τ is env-configurable
(`TUTOR_RETRIEVAL_TAU`).

**Calibration** (`scripts/calibrate-tutor-tau.ts`, Wave 5) ran a **32-query
labeled corpus** through the REAL hybrid retrieval over **cs61b** (the largest
live course, 259 chunks, real text-embedding-3-small embeddings):

| Class | n | mean sim | min | max |
|-------|---|----------|-----|-----|
| sufficient (active lesson answers it) | 16 | 0.596 | 0.506 | 0.683 |
| insufficient (answer elsewhere / off-topic) | 16 | 0.190 | 0.016 | 0.325 |

The classes separate cleanly with a **wide gap (0.325 → 0.506)**; τ ∈ **[0.33, 0.50]**
gives **0% false-expansion AND 0% missed-expansion**. The default **τ = 0.40** sits
mid-band for robustness to distribution shift.

> **Design note (why similarity, not the RRF score).** An earlier draft gated τ on
> the RRF fused rank score. Calibration showed that score **clusters at ~1/61 for
> both relevant and irrelevant queries** — the vector arm always returns a rank-1
> nearest, and the lexical arm rarely stacks on the *same* chunk — so no τ on that
> scale separates them (≥87% false-expansion). The RPC now returns the raw cosine
> similarity (migration `20260811100000`), which is the calibratable signal.

Re-run the calibration on real production transcripts once retrieval accumulates
data: `npx tsx scripts/calibrate-tutor-tau.ts` (embeds cs61b, sweeps τ, reports
the false/missed rates, cleans up).

## Behaviors

- **Forward material** (`forward.ts`): a question whose concept lives ONLY in an
  incomplete lesson → the tutor NAMES where it's covered (by lesson **title**,
  never an id) and declines to teach it ahead of time; it never retrieves the
  forward lesson and never answers it from model knowledge.
- **Retrieval failure** (`scopePolicy.retrievalFailure`): nothing relevant across
  eligible tiers AND no forward material → the tutor states plainly the course
  doesn't cover it and offers to raise it with the creator (the escalation path);
  it never answers from its own knowledge.
- **Provenance** (`hasCourseSupport`, A4-20): a course attribution is legitimate
  only when ≥1 retrieved chunk clears τ. The turn is instructed to attribute to
  the course only what a retrieved passage supports; any UUID the model echoes is
  scrubbed from the prose (`redactInternalIds`).
- **Contradiction** (`routeContradiction`, A4-19): when the model flags that the
  retrieved course content conflicts with what it would assert, the tutor FOLLOWS
  the course and emits **`tutor.contradiction.detected`** into the escalation loop
  for creator review — evidence, not a runtime failure.

## Prompt integration + token delta (Wave 4)

When a turn is retrieval-grounded, the developer message drops the whole-lesson
**L2 dump** for a SHORT lesson header (title + objective); the retrieved passages
carry the content. The per-turn token delta is logged (`tutor_token_delta`) and
surfaced on the result. A retrieval-empty turn keeps the full L2 (no regression).

Citations get a server-resolved **label** (lesson title · "slide N") so the
"Go there" affordance names its destination; at most **one** navigation affordance
renders per message, only with a resolvable anchor.

## The `[FWD]` `source_tier` seam

Every chunk carries `source_tier text not null default 'canon'` with a CHECK that
**only `'canon'` is storable** — `'adjacent'` (model knowledge as content) is
reserved but **unreachable** in A4. Enabling it in a future amendment would
require: (1) widening the CHECK to accept `'adjacent'`; (2) a Tier-3 source that
generates/labels adjacent content; (3) a provenance rule distinguishing canon
from adjacent in the learner-facing output; (4) a charter knob (the existing
`course_canon 'strict'|'open'` is the natural gate). None of that exists in A4 —
the seam is a column + a CHECK, nothing more.

## Metrics

| Metric | Before | After |
|--------|--------|-------|
| Prompt tokens per turn — lesson grounding (median) | ~2,000 (whole-lesson L2, Wave-0 measured; capped at ~2,500, truncating 66% of cs61b lessons) | short header + Tier-1 retrieval; instrumented **875 → 74** on a synthetic lesson; ~900–1,400 for cs61b's real slides — a **30–55% reduction**, and relevance-ranked + cross-lesson-capable (which the truncating L2 dump was not) |
| Expansion rate (% of turns) | n/a (no retrieval pre-A4) | on the calibrated corpus, `insufficient_local_context` = 100% recall / 0% false-positive at τ=0.40; the real-turn rate depends on the learner's completed-lesson pool + question mix — measured in production via `tutor.retrieval.expanded` |
| Turns citing a lesson other than the active one | n/a | measured in production via the labeled citations' `lessonId` ≠ active (the instrumentation is live) |
| Embedding cost per course publish | n/a | **cs61b (largest, 259 chunks) ≈ $0.002** (text-embedding-3-small, measured); whole library ≈ $0.02–0.04; once per immutable publication, **zero on unchanged republish** |

## Tests

- `verify:tutor` → `verify-tutor-retrieval.ts` (chunker/anchors/padToDims/SQL
  assertions), `verify-tutor-scope.ts` (eligibility property test, the four
  expansion codes, forward/failure/contradiction/provenance, loop injection),
  `verify-tutor-wave4.ts` (L2→retrieval + token delta, id redaction, labels,
  single nav affordance, derived chips).
- `verify:tutor:int` → `verify-tutor-retrieval-int.ts` (embed-every-lesson,
  idempotency, hybrid lexical-only match, in-query lesson filter, source_tier),
  `verify-tutor-scope-int.ts` (real completion→eligibility, scoped turn, expansion).
- `scripts/calibrate-tutor-tau.ts` — the τ calibration harness (real or `--mock`).
