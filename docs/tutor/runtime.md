# TUTOR-1 — The Tutor Runtime (Wave 3)

> The live learner-facing tutor: a layered, cache-stable prompt; a bounded
> five-tool loop on `gpt-5.6-luna`; scaffolded, grounded, charter-governed
> turns; an SSE route that persists an append-only transcript and feeds the
> Wave-2 mastery engine in real time. Companions: `concept-graph.md`,
> `mastery.md`, `charter.md`, `architecture.md`.

## The layered prompt (`lib/tutor/runtime/promptLayers.ts`)

| Layer | Content | Stability |
| --- | --- | --- |
| L0 | The static core (`TUTOR_L0`, ≈1,628 tokens): identity, pedagogy, the rung ladder, grounding + span rules, five-tool docs, assessment integrity, safety | BYTE-CONSTANT — sent verbatim, alone, as the system message; the provider cache prefix. Any byte change bumps `TUTOR_PROMPT_VERSION` |
| L1 | `serializeCharter(charter)` | byte-stable per charter |
| L2 | `assembleLessonContext(snapshot, lesson, conceptNodes)` — lesson text (quiz STEMS only), concepts, position marker | byte-stable per (publication, lesson) |
| L3 | `assembleLearnerState` — own mastery w/ below-threshold flags, the root-cause line, titled review queue, session synopsis | per-learner (sits after the stable prefix) |
| L4 | `serializeHistory` (≤12 turns, drop-oldest-whole) — or `previousResponseId` when `TUTOR_ENABLE_CHAINING` is on (default OFF; P-3) | per-thread |

AC-T3.2 holds by construction: two learners on the same (publication,
lesson, charter) get byte-identical system+developer messages.

## The turn (`loop.ts runTutorTurn` → `service.ts` → the route)

One structured Luna call (30s per-turn deadline, learner pool) with a
bounded ≤3-round tool loop over EXACTLY five tools (`tools.ts`,
AC-T3.6): `get_lesson_context`, `get_mastery_summary`, `generate_practice`
(Luna; uuid `practice_item_ref`, `itemBankRef` null [FWD], the item RIDES ITS
OWN KEY — see below), `emit_evidence` (validates and RETURNS — the route emits),
`propose_escalation` (the one service-role write: a `consent_pending`
candidate). The output contract (`outputContract.ts`): marked prose
(`⟦g⟧`/`⟦s⟧` spans), citations (≤8), rung, evidence (≤4), optional practice
items (≤3), optional escalation proposal. Three live-conformance rules learned
from the first live smoke (every turn initially failed): optional contract
fields must ALSO be `.nullable()` (the strict JSON-schema converter makes
optionals nullable on the wire, so the model correctly emits `null` —
`practiceItems: null` was rejected by a Zod side that only accepted
`undefined`); L2 carries every id the model must echo back (`(lessonId: …)`
on the lesson line, `(blockId: …)` per block header, `(nodeId: …)` per
concept line, plus a cite-by-id instruction) — without ids in view the model
cites and tags evidence by TITLE, which grounding correctly drops; and a
model-mangled reference is a DROPPABLE CLEANUP, never a whole-turn failure:
the turn contract's evidence items accept any string `nodeId`
(`TurnEvidenceItemSchema`) and the loop filters non-resolving items against
the course's real concept nodes (flag `evidence_dropped`, mirroring
`citation_dropped`), while the frozen Wave-3 event schema still gates
EMISSION — only resolving uuids ever reach the analytics stream. The id tags
are deterministic snapshot values, so L2 stays byte-stable per (publication,
lesson) and no `TUTOR_PROMPT_VERSION` bump was needed (L0 untouched).

Practice items ride their own key (Wave 4, Contract 5). `generate_practice`
now AUTHORS the answer on each item — `correctChoiceIndex` (0..3) for an `mc`
item, 1–3 `acceptedAnswers` for a `short` one, and a one-line `explanation`
(all three `.nullable()` so a keyless or kind-mismatched item degrades to null
rather than fabricating one). The key rides the SSE turn payload because
practice is FORMATIVE and low-stakes: the client grades locally (mirroring the
`short_answer` trim/lowercase semantics of `lib/learn/grading.ts`) and reveals
the verdict + explanation only AFTER the learner answers, then POSTs
`practice_answer`. The frozen route contract is unchanged — it takes
`evidenceCorrect` FROM THE CLIENT — so the key here only decides the
learner-visible result; the graded course-quiz invariants (`quiz_answer_keys`,
server-only, stripped from every snapshot) are untouched.

Post-processing order: **scaffolding → grounding**. Scaffolding clamps the
opening rung per guidance style (socratic 1 / guided 2 / forward 3) and
forces rung 4 on an explicit "just show me" in every style. Grounding
(`grounding.ts`) resolves every citation against the learner's snapshot
(unknown block → dropped; unresolvable slide → block-level downgrade, the
R-13 convention), suppresses supplemental spans under strict canon, and
flags substantive-but-uncited prose as `ungrounded` — low confidence must
become an escalation proposal, never invention (AC-T3.5).

## The route (`POST /api/learn/tutor`)

`action: 'turn'` streams SSE: `{queued, position}` while the learner pool
waits → ONE `{turn}` payload → `{done}` (no fake token deltas — the turn is
a single structured call this wave). `practice_answer` / `self_report` /
`hint_request` are plain JSON. The access matrix gates everything:
`disabled` (no settings row or `enabled ≠ true`) · `author_preview` (typed,
friendly, and NEVER emits evidence) · `not_enrolled` · `ok`.

Persistence: the learner turn lands on receipt; the assistant turn
(content + grounding jsonb + rung + response_id) lands ONLY on completion —
an abort persists nothing assistant-side and the thread resumes. The
request signal threads to the pool acquire AND the model call; a whole-turn
deadline (`AbortSignal.any`) backstops it.

Evidence — the Wave-2 seam alive: each turn's `tutor_inference` items, and
each discrete practice/self-report/hint signal, server-emit with
deterministic purpose-prefixed ids (`wisesel.tutor-evidence.v1:` over
`evidence:{turnId}:{i}` / `practice:{ref}:{ordinal}` / …) — replays no-op —
and fire one targeted `tutor/mastery.refold.requested`. L3 reflects the
updated mastery next session.

## Session behaviors (`session.ts` — state DERIVED from history, stateless)

A **session** is the trailing window of thread turns whose inter-turn gaps
are each under 30 minutes (`SESSION_GAP_MS`). The root-cause interjection
offers ONCE per session (marker `root_cause_interjection` rides the
assistant turn's `grounding.sessionMarkers`; a declining reply suppresses
it for the session — AC-T3.7). Assessment integrity (D-5): with
`quizActive`, `concept_review_only` scaffolds and clamps to rung ≤3 (even
"just show me" defers, with charter-aware copy); `block` short-circuits
BEFORE the model — zero calls, zero evidence (AC-T3.8).

## Cost, pools, caching

Every turn's model call rides `withPooledModel` (learner pool, cap 8
per-instance, FIFO, abort-aware) — the single interception point that also
emits `tutor_model_call` telemetry (`jobType: tutor_turn`, learner
attributed). Cache posture: L0 alone as the system message keys the
provider prompt cache; measured ratios live in the Wave-3 checkpoint
(`smoke-tutor-cache.ts` — 10 turns incl. a deliberate 5-minute TTL probe).
