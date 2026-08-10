# TUTOR-1 — Pedagogy tools (Amendment A3)

> The tutor's assessment surface: six generative-UI tools that turn a chat turn
> into a mastery observation. How they're invoked, how they render, how they
> grade, and what evidence they leave. Companions: `runbook.md` (flags/ops),
> `analytics.md` (the evidence rollup + misconception console), `streaming.md`
> (A2 — the turn wire the cards ride), `architecture.md` (the model/cost
> pipeline). Historical record: `docs/audits/TUTOR-1-A3-audit.md` (Wave 0) +
> the six `TUTOR-1-A3-wave{0..5}-checkpoint.md` (what shipped, deviations,
> rulings).

Amendment A3 shipped across six waves. Waves 0–1 audited and repaired the six
learner-facing defects (markdown rendered literally, a leaked rung badge,
duplicate "Show me" chips, an unconditional escape hatch, ASCII diagrams, and
"hello" answering the previous question — all closed; see the Wave-0/1
checkpoints and `grounding.ts`'s header). Waves 2–5 built the pedagogy surface
this document is the home for. This is the permanent replacement for the two
temporary build-contract docs (`a3-wave4-contract.md` + `a3-wave5-contract.md`,
now deleted).

## 1. The design thesis

Three rules, from the directive §2, that separate A3's assessment from the
tutor-IMPOSED quizzing it replaces:

- **Every assessment is a mastery observation.** A completed card is not a
  score; it is one `tutor_evidence_recorded` row on the same analytics stream
  the rest of the tutor writes, folded into the learner's mastery. The point of
  a check is the evidence, not the grade.
- **Every distractor carries a named misconception.** A wrong option is not
  "incorrect" — it identifies WHICH incorrect model the learner holds
  (`checkUnderstanding` enforces this at the schema level: a wrong option with
  no `misconceptionId` FAILS parse). This is what turns an opaque `Health-62`
  lesson number into "6 learners hold the insertion-order-preserved
  misconception" on the creator console — a specific, actionable finding
  instead of a percentage.
- **The tutor invites; it does not impose.** Assessment renders only when the
  learner asks (a practice request) or accepts an offered invitation. A model
  attempt to attach a quiz to an ordinary answer is DOWNGRADED to one quiet,
  dismissible invitation — never a widget the learner didn't ask for. This is
  the invocation policy (§3), enforced in code, never in the prompt.

## 2. The six tools

Two classes. **Class P** (presentational) executes on any turn including a
`question` turn and emits no evidence. **Class A** (learner-active assessment)
is governed by the invocation policy — it renders only on a
practice-request / invitation-accepted turn, and its completion emits evidence.
All six are `TutorTool`s in `lib/tutor/runtime/toolsA3.ts`, tier `read` (no DB
write in the tool — the card lives for the turn; the ROUTE writes evidence on
learner interaction), mounted into `TUTOR_TOOLS` (`tools.ts`) with mandatory
compile-enforced rows in `TUTOR_TOOL_TIERS` (`toolTiers.ts`). The five Class-A
tools are in `CLASS_A_TOOL_NAMES` (`invocationPolicy.ts`); `renderStructure` is
deliberately NOT (so the intercept never touches it — A3-12).

An assessment card is emitted as the model's tool ARGUMENTS (the data IS the
card — no internal model call), Zod-validated at the tool boundary. Each
Class-A tool mints a `cardId` (the evidence `completionKey` base) and leaves
`initiation` as a placeholder; the loop's `collectToolOutputs` sink
(`loop.ts`) stamps the real per-turn initiation before the card surfaces.
`conceptSlug` on every card is the concept node **uuid** (ruling R-1 — concepts
have no slug; the model echoes node ids reliably via L2 id tags). Cards ride
the settled `turn` SSE frame — `structures[]` and `assessments[]` on
`TutorTurnPayload` (`sseProtocol.ts` server Zod ↔ `tutorClientTypes.ts` zod-free
mirror, drift-guarded by `verify-tutor-client`) — never their own frame, and
AFTER `proseWithSpanMarkers` so the streaming prose extractor is unaffected.

### THE flat-top-level-object rule (a live-only failure the mock can't see)

Every tool's `params` MUST be a top-level `z.object`, never a bare
`z.discriminatedUnion`. The OpenAI function-calling API requires the tool's
`parameters` JSON Schema to be `type: "object"`; a top-level discriminated
union converts to `anyOf` with no top-level type, and the LIVE API rejects it
(`"got type: None"`, a 400) — invisible to the mock provider. Wave 4 hit this on
`renderStructure` (originally a discriminated union over `kind`) and refactored
it to a flat object: a `kind` enum + per-kind nullish body objects (the model
fills the matching body, leaves the others null; a missing/mismatched body
drops-and-flags). A runtime assertion in `verify-tutor-runtime` now pins every
tool's params to a top-level `type: "object"`, so this class of live-only
failure is caught in `npm test`. The live smoke — which exists to catch what
mocks can't — is what surfaced it.

### `renderStructure` — Class P

Replaces ASCII/monospace diagrams (the D-5 fix, completed) with real diagrams.
The model emits a compact per-kind structure as args; the tool maps the A3
`kind` onto a `lib/course/diagram` spec, gates it with `validateDiagram`, and
**drops-and-flags** an invalid one (`{ structure: { …, diagram: null }, error }`,
logged `tutor_structure_dropped`) — it NEVER throws / fails the turn (A3-24
discipline, the visual pipeline's real-data-only lesson). Kind → spec mapping
(`buildDiagramSpec`, `toolsA3.ts`):

| `kind`     | diagram spec       | note |
| ---------- | ------------------ | ---- |
| `tree`     | `tree_diagram`     | hierarchy / recursion; the arg tree is bounded to 3 levels (the strict JSON-schema converter can't emit a recursive `$ref`) |
| `graph`    | `graph_diagram`    | network / dependencies |
| `axes`     | `coordinate_plot`  | labeled coordinate plot |
| `timeline` | `number_line`      | ordered labeled sequence; positions default to 0,1,2,… when the model omits them. A true categorical-timeline renderer is a documented **[FWD]** |

Renders via `components/learn/tutor/TutorStructureCard.tsx`, which reuses the
pure, dependency-free, SSR-safe `DiagramView` surface (`components/editor/slide/
diagram/DiagramView.tsx`; `lib/course/diagram/{types,geometry,validate}`), sized
for the dock. The learn client imports the type-only diagram types +
`{geometry,validate}` + the renderer — NEVER `lib/course/diagram/schemas.ts`
(the Zod half; the PERF-1 zod-free learn-bundle rule). No evidence.

### `checkUnderstanding` — Class A

A single retrieval check (3–4 options), each option carrying `correct` + a
`misconceptionId` + `feedback`. The Zod `.superRefine` ENFORCES A3-13: **any
option with `correct === false` and a null/empty `misconceptionId` fails
parse** — and at least one option must be correct. Renders via
`TutorCheckUnderstandingCard.tsx` (a `radiogroup` with roving tabindex + an
optional confidence collector). Graded LOCALLY (formative; the answer key ships
on the card, the practiceItems precedent): `scoreCheckUnderstanding`
(`tutorClientTypes.ts`) returns the picked option's `misconceptionId` +
`feedback`; the card reveals that feedback (which NAMES the reasoning, never
"the answer is X" — A3-14). Evidence: `demonstrated` if the picked option is
correct, else `not_demonstrated` carrying the distractor's `misconceptionId`.

### `sequenceTask` — Class A

An ordering task (≥3 items) with a `correctOrder` (the `.superRefine` validates
it is a permutation of the item ids) and a `partialCreditRule`
(`exact | adjacent-pairs`). Renders via `TutorSequenceCard.tsx` (keyboard
up/down reorder, deterministic shuffle, no drag dependency). Graded LOCALLY by
the pure `scoreSequence` (server twin in `toolsA3.ts`) / `scoreSequenceCard`
(client, `tutorClientTypes.ts`) — **reconciled to ONE relative-order definition**
(§4 below): `exact` = every position right ⇒ demonstrated, else not; a single
misplaced element under `adjacent-pairs` earns `partial`, not a total failure
(the standard forgiving metric — A3-15). Evidence carries that outcome.

### `fadedExample` — Class A

A worked example for practice: the problem + 2–8 FULLY-worked steps (the model
authors every step AND its answer). The runtime — NOT the model — decides how
much is blanked, from the learner's stored mastery (§5). Renders via
`TutorFadedExampleCard.tsx` (non-blanked steps render worked; blanked steps
render labelled inputs; reveal on submit). Graded LOCALLY (`scoreFadedCard`):
all blanks right → demonstrated · some → partial · none → not_demonstrated.
Evidence carries the `fadeLevel`.

### `predictThenReveal` — Class A

Commit a prediction before the answer. Args: `setup`, `prompt`,
`acceptedAnswers[]` (1–4), `nearMisses[]` (0–4, each naming its
`misconceptionId` + `feedback`), `revealExplanation`. Renders via
`TutorPredictCard.tsx` (nothing reveals until the learner commits). Graded
LOCALLY (`scorePredictCard`, trim/lowercase): a prediction containing/equalling
an accepted answer → demonstrated; else the first matching `nearMisses[i]`
pattern → not_demonstrated + that misconceptionId + feedback; else
not_demonstrated with a null misconception. Then the reveal.

### `explainBack` — Class A

Self-explanation against a 2–5 point rubric — the ONE new interaction shape,
**SERVER-graded** (§6). "At most once per concept per session": the loop threads
`deps.explainBackConcepts` (node ids already explainBacked in the session
window, derived from history grounding), and the tool DROPS a duplicate
(`{ assessment: null, error: "already_explained" }`, logged). Renders via
`TutorExplainBackCard.tsx` (a labelled textarea → the `explain_back_grade` route
→ a criterion list with notes, met/not-yet, and NO pass/fail verdict — A3-17).

**Malformed items degrade cleanly (A3-18):** `renderStructure` drops-and-flags
(the turn still `ok`); a `checkUnderstanding`/`sequenceTask` with invalid args
bounces through the loop as `invalid_args` (the model re-authors, or the
invitation stands) — never a partial widget.

## 3. The invocation policy

`lib/tutor/runtime/invocationPolicy.ts` (pure, zero I/O) is the whole of it —
the three paths from directive §4, enforced in CODE, never the prompt. It
shipped in Wave 3 BEFORE any new Class-A tool existed (the directive's ordering
requirement), governing the legacy `generate_practice` prototype so the Wave-4
tools slotted into an already-governed surface.

**Three paths** (`TurnInitiation`):

1. **`practice_request`** — an unmistakable learner ask → the tool executes
   directly, the card renders, NO invitation.
2. **`invitation_accepted`** — the learner pressed an offered invitation → the
   tool executes, the card renders.
3. **`question`** — the default → a Class-A tool call MUST NOT execute; it is
   DOWNGRADED to at most ONE quiet invitation.

**The pre-execution downgrade-not-block intercept.** In the loop, beside the
tier gate, a Class-A tool call on a `question` turn never runs: the loop records
`pendingDowngrade`, feeds the model a plain synthetic tool result so it finishes
its prose turn, and logs `tutor_tool_downgraded` (wire/log-only — a persisted
counter would need the full union/CHECK/lock recipe; deliberate, revisit only if
dashboards need it). `applyInvocationPolicy` then strips model-emitted
`practiceItems`/`assessments` from a question turn and collapses to at most one
invitation naming the called tool. The generate-on-acceptance-not-offer property
(§5 of the directive) falls out structurally: an ignored invitation costs zero
model calls.

**The conservative `practice_request` classifier** (`detectPracticeRequest`) is
regex-ONLY, false-negative-biased per §4: it catches only unmistakable asks
("quiz me", "let me try one", the "Quiz me on this lesson" chip). Anything
ambiguous stays a `question` and at most earns an invitation. The two-stage
model fallback (`lib/ai/intent.ts` shape) is a documented **[FWD]**, deliberately
not built.

**Deterministic acceptance provenance.** Only an `invitation_accepted` claim
rides the wire (on the POST body); `question` vs `practice_request` is
SERVER-derived. `resolveInitiation` honors a claim ONLY when it matches the
IMMEDIATELY-prior assistant turn's stored invitation (same `toolName` + `nodeId`,
no learner turn between); a forged, mismatched, or stale claim fails TOWARD
`{ kind: "question" }` — the message under a pressed button is never trusted as a
typed ask. The invitation pill sends the deterministic `initiation` payload, so
provenance is a button press, never inference (A3-11).

**The two-ignore cooldown + discard.** The invitation lifecycle is DERIVED, not
stored, over the same trailing 30-min session window as `session.ts`
(`deriveInvitationState` reuses `deriveSessionState` verbatim — a 31-minute
silence resets it like every once-per-session behavior). An offer is stamped
into the assistant turn's `grounding.invitation` (the offered-marker); it is
ACCEPTED iff the next learner turn's `grounding.initiation` matches, IGNORED
once any later learner turn exists. Two consecutively-ignored offers activate
the cooldown (no third offer), reset by any acceptance or explicit practice
request. `effectiveCooldown` folds in the pending offer the CURRENT message
resolves, so the second brush-off suppresses the offer on THIS turn, not one
turn late. An unaccepted invitation is discarded on any other message (the
client renders invitations only on the final transcript turn while idle; the
server validates only against the immediately-prior offer).

**The escape-hatch attempt gate (A3-4/A3-5).** The "Just show me" hatch renders
only below rung 4 (`rung === 4` / null → hidden — the full answer is already
given) AND after the learner's first attempt on the active concept
(`shouldOfferEscapeHatch(rung, hasAttempted)` + `hasAttemptedFor`, fed by the
non-persisted session-attempts store slice — a refresh clears it, the
conservative direction). Completing any Class-A card records a session attempt,
so the hatch counts these too.

**The R-6 rung→tool map** (`RUNG_INVITATION_TOOLS`) is full data mapping A3 §4's
1–4 ladder onto the existing 0–4 rungs; `invitationToolForRung` resolves the
mapped preference filtered by `CLASS_A_TOOL_NAMES` (rungs 0–1/4 →
`checkUnderstanding`, rung 2 → `sequenceTask`, rung 3 → `fadedExample`), with
`generate_practice` the ultimate fallback.

## 4. The evidence spine

Every completed Class-A card persists ONE observation on the SAME
`learning_events` stream the rest of the tutor writes.

**`tutor_evidence_recorded`** — the 23rd event type on the one analytics
contract (migration `20260807100000_tutor_evidence_recorded.sql`, applied live;
ruling R-4 — snake_case, `tutor_%`-prefixed). Eight typed nullable columns
(`tool_name`, `outcome`, `misconception_slug`, `confidence`, `fade_level`,
`initiation`, `item_source`, `reviewed_item_id`) with three bidirectional
isolation CHECKs; `node_id` carries the concept uuid; envelope =
publication+version required, lesson OPTIONAL (a tutor conversation spans
lessons). The client ingest RPC and the R-9 author-select exclusion needed ZERO
changes — the existing `tutor_%` guards already reject browser-forged rows and
hide per-row evidence from creators. (⚠ `latency_ms` already existed, pinned to
model-call rows; the migration re-creates `tutor_call_check` with a
tool-evidence arm that frees it rather than adding the column — a deviation from
the frozen contract, intent preserved.)

**`recordToolEvidence`** (`lib/tutor/runtime/evidenceRecord.ts`) — THE single
append-only writer (ruling R-3; `learning_events` stays append-only, no
versioned UPDATE). It NEVER throws:

1. validate the input (typed `invalid_input` on a malformed field),
2. resolve `conceptSlug` against the course's `concept_nodes` — **merge chains
   walk to the survivor** (`resolveConceptNode`, bounded + cycle-safe);
   retired/absent/cyclic → `unknown_concept`, dropped-and-flagged
   (`tutor_evidence_dropped`),
3. normalize (`normalizeMisconceptionSlug`) + race-safe get-or-create the
   misconception registry row (best-effort — an unusable slug or a registry
   hiccup records the evidence with a null link; **evidence outranks label**),
4. append EXACTLY ONE row via the `upsertEvent` discipline, id =
   `tutorEvidenceId("toolev:" + completionKey)` — a **deterministic
   `completionKey`** (`"toolcard:" + cardId`) makes a replay a no-op.

A3-22: the module imports NOTHING from the tool-tier / approval surface —
evidence recording is an observation, never a governed side effect
(grep-asserted). Refold scheduling stays with the caller: the route fires the
same `sendTutorMasteryRefoldRequested` the other evidence endpoints fire on any
emission. Mastery folding is conservative v1 (`toolEvidenceWeight`: demonstrated
+1.0 / partial +0.5 / not_demonstrated −1.0 at practice_answer magnitudes;
confidence/misconception non-modulating — **[FWD]**).

**The `tutor_misconceptions` registry** — one row per (course, concept node,
model-proposed human-readable slug), UNIQUE `(course_id, node_id, slug)`,
versioned, author-SELECT-only RLS, service-role sole writer (the registry is
where REAL version conflicts live — `learning_events` stays append-only; the
A3-21 "409" test restates as idempotent-replay on the event + a real
version-conflict test on these rows).

**The double-floored rollup** — `tutor_misconception_rollup(p_course_id)`, an
author-gated SECURITY DEFINER RPC, is the ONLY creator read surface for
misconceptions (A3-23). It is cohort-floored ≥5 BOTH ways: a `(node, slug)` pair
held by <5 distinct learners is OMITTED, and a course whose cohort is <5 returns
NOTHING (the D-4 disclosure floor, applied inside the RPC). The A3 §6
"<20 ⇒ raw counts only" rule LAYERS ON TOP display-side — the RPC always returns
raw counts + `cohort_size`, and `misconceptionCountDisplay`
(`lib/analytics/misconceptions.ts`) decides. Rendered as the "Misconceptions"
section on the console's Analytics tab (`AnalyticsTutorTab.tsx`). Full detail:
`analytics.md` § Tool evidence (A3).

## 5. `fadeLevel` from mastery (A3-16)

The load-bearing rule of `fadedExample`: **the runtime derives how much is
blanked from the learner's stored mastery — never the model, never the turn
count.** Turn count is wrong because of expertise reversal (a strong learner
handed a fully-worked example wastes the moment); mastery is the right signal.

The tool reads the learner's decayed mastery for the resolved concept from
`deps.masteryByNode` (a `Map<nodeId, number>` the loop threads from
`gatherLearnerState().masteryRows` after L3, keyed by node uuid), then:

- `fadeLevelForMastery(p)` → `0|1|2|3` — no mastery (undefined/NaN) or p<0.25 →
  0 (fully worked) · <0.5 → 1 · <0.75 → 2 · ≥0.75 → 3 (independent problem).
- `blankStepsForFade(stepCount, fadeLevel)` → `round((fadeLevel/3)·stepCount)`
  trailing steps blanked (backward fading; level 0 → none, level 3 → all).

`fadeLevel` is fixed at authoring — the card MUST NOT advance it within a turn.
Both helpers are pure + unit-tested. `conceptSlug` IS the node uuid (R-1), so
the mastery lookup is a direct `masteryByNode.get(slug)`; an absent map/node →
undefined → fade 0 (the safe default: a learner with no signal never gets a
blanked problem). Merge-chain resolution stays at evidence time in
`recordToolEvidence`.

**THE precondition the Wave-5 live proof surfaced:** the model echoes the real
node uuid ONLY when the concept is ANCHORED to the lesson (an anchored node
rides L2 lesson context with its `(nodeId:)` id tag; an unanchored node is
filtered out of L2, so the model never sees its uuid and invents a slug). The
first live run tripped exactly this — a seeded node with no `anchors` produced a
fabricated slug (`bst-insertion`). Anchoring it fixed the run
(`conceptSlug=<real uuid>`, `fadeLevel=3`, all steps blanked) and resolved the
"invented slug" worry carried since Wave 3. Publish-time graph extraction
guarantees anchoring for real courses, so the tools' node resolution holds in
production.

## 6. `explainBack` grading (A3-17)

`explainBack` is the ONE tool graded on the SERVER — free text can't be
client-scored. Route action **`explain_back_grade`** (`app/api/learn/tutor/
route.ts`), access-gated exactly like `practice_answer`:

- A POOLED structured model call — `withPooledModel(createOpenAIModelClient(),
  { pool: poolFor("learner"), … jobType: "practice_gen" })`, the small tier,
  NEVER a fresh unpooled client (A3-20: item/grading generation never escapes
  `withPooledModel`; the ceiling is structural, not the number 2 — ruling R-5).
- Grades criterion **PRESENCE, not wording** (the system prompt says so
  explicitly: "grade on the PRESENCE of the idea, NOT on wording… a paraphrase
  that captures the idea IS present"). Returns `{ criteria: [{ criterion,
  present, note }] }`.
- Maps to an evidence outcome (`outcomeFromExplainBackGrade`, pure + exported so
  route and tests agree): all required criteria present → demonstrated · ≥1
  required present but not all → partial · none → not_demonstrated. Records ONE
  `tutor_evidence_recorded` row + fires the refold.
- **Formative-only** — returns `{ ok, criteria, outcome }` with NO pass/fail
  verdict field; the client renders criterion-level met/not-yet + notes only.
- **Fail-closed** — a model failure returns `{ ok:false, error }`, records NO
  evidence, and the card shows a plain retry. Never a fake grade.

## 7. [FWD] seams (built or documented, not yet live)

- **`reviewedItemId` / `item_source`** — the column + `item_source: "reviewed"`
  land now so the contract is stable, but a non-null `reviewedItemId` fails
  validation (pinned `z.null()` in `events.ts`). The reviewed-item bank + creator
  review (§5 of the directive) is the future consumer.
- **The `practice_request` model classifier** — the regex stage ships; the
  low-effort pooled `runStructuredCall` fallback (`lib/ai/intent.ts` shape) is
  documented in `invocationPolicy.ts`'s header, deliberately not built.
- **Categorical-timeline renderer** — `renderStructure`'s `timeline` maps to
  `number_line` (an ordered labeled sequence) today; a true categorical
  timeline renderer following the diagram per-kind pattern is a [FWD].
- **`store:true` chaining (R-2)** — the R-2 scoped reversal is LIVE: the main
  `tutor_turn` call ships `store: true` (Wave 4), so the `previous_response_id`
  chaining seam is exercised. But item generation rides IN-TURN args (reflecting
  the just-delivered explanation already in history) — a separately chained
  generation call is the documented refinement; `TUTOR_ENABLE_CHAINING` / L4
  replay stays OFF (textual replay unchanged; the P-3 privacy default holds
  otherwise).

## 8. Test map

| Suite | Kind | Covers |
| --- | --- | --- |
| `verify-tutor-runtime` | pure | the tool set (invocation intercept, the R-6 map, `applyInvocationPolicy` property test over ≥100 turns, `detectPracticeRequest` regex + near-misses); the flat-top-level-object param guard (11 tools); `fadeLevelForMastery`/`blankStepsForFade` matrices; `scoreSequence`; explainBack card-build + session-duplicate drop; A3-19 spy (a Class-A `execute` is NOT called on an intercepted question turn) |
| `verify-tutor-client` | pure | markdown render (A3-1), no rung leak (A3-2), citation dedup (A3-3), the escape-hatch gates (A3-4/A3-5); the client scorers `scoreCheckUnderstanding` / `scoreSequenceCard` / `scoreFadedCard` / `scorePredictCard` + the verdict-free `explainBackCriteriaView`; payload/parity greps; structural a11y asserts |
| `verify-tutor-evidence` | pure | `recordToolEvidence` internals: `normalizeMisconceptionSlug`, `resolveConceptNode` (merge chains, cycles), A3-22 (no tool-tier imports) |
| `verify-tutor-evidence-int` | live Supabase + mock model | A3-21 exactly-one-row + typed-columns-verbatim + idempotent replay; the registry get-or-create race → one row; the real version-conflict on registry rows; A3-23 rollup floors proven live |
| `verify-tutor-route-int` | live Supabase + mock model | the lifecycle legs: checkUnderstanding on an accepted turn → one `tutor_evidence_recorded` row (idempotent re-POST); a structure on a question turn (no evidence); a `fadedExample` on a high-mastery concept → `fadeLevel 3`; an `explain_back_grade` POST → criterion results + one evidence row; A3-20 (the grade path uses `withPooledModel`) |
| `verify-tutor-analytics-console` | pure | `misconceptionCountDisplay` (<20/≥20 boundary), the tab never inlines the comparison |
| `verify-tutor-stream-browser` (`verify:tutor:browser:stream`) | live browser + real model | streaming regression over the modified `TutorBody` (20/0) |
| **`verify:tutor:browser:cards`** (NEW — Wave 6) | live browser + axe | the deferred A3-25 card-render axe pass over the six *rendered* cards (needs non-deterministic model authoring in-browser; structural a11y was proven in the pure suites — this closes the "PARTIAL" from the W4/W5 checkpoints) |

Wave-2 also extended `verify-tutor-mastery` (tool-evidence weight pins) and the
`verify-tutor-stream-infra` 23-member union lock.

## 9. The rulings (R-1..R-6)

Requested at the Wave-0 gate (`docs/audits/TUTOR-1-A3-audit.md` §8; approved
unmodified). Each is load-bearing for the sections above.

| # | Decided | Why |
| --- | --- | --- |
| **R-1** | `conceptSlug` = the concept node's existing **uuid**; misconception ids are the human-readable slugs | No slug exists on concept nodes (id + title + aliases only); the model already echoes node ids reliably via L2 id tags — no parallel identifier system, no slug-vs-merge drift |
| **R-2** | Scoped reversal of P-3: `store: true` on `tutor_turn` foreground calls ONLY | §5's `previous_response_id` chaining needs the chained-from response stored; the delta is provider-side retention of content our DB already persists. `TUTOR_ENABLE_CHAINING` / L4 replay stays off |
| **R-3** | A named `recordToolEvidence` wrapping the append-only deterministic-id upsert | §6's "versioned-update repository function" cannot exist on an append-only event stream; the single-write-path idiom is the correct reading. A3-21's 409 test restates as idempotent-replay + a real version-conflict on the registry rows |
| **R-4** | Canonical event name `tutor_evidence_recorded` | The directive's dotted `tutor.evidence.recorded` breaks the stream's snake_case convention and every `tutor_%` pattern in SQL/tests |
| **R-5** | Assert the STRUCTURAL concurrency invariant (item gen never escapes `withPooledModel` / `deps.model`) + after-prose sequencing, not the literal "two-concurrent" | The 2-cap is the CREATOR pool; tutor turns ride the learner pool (default 8). The ceiling is `withPooledModel`, the single interception point |
| **R-6** | Map A3 §4's 1–4 invitation-tool table onto the existing 0–4 rung ladder, extend in place | The directive mandates extending the existing ladder, not a parallel policy: "1 Elicit" ⇒ rungs 0–1 · "2 Nudge" ⇒ 2 · "3 Scaffold" ⇒ 3 · "4 Resolve" ⇒ 4 |
