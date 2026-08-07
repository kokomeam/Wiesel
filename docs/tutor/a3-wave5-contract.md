# A3 Wave 5 — frozen build contract (fadedExample · predictThenReveal · explainBack)

> Temporary build-coordination doc; folds into the Wave 6 docs pass. Both
> builders build to THESE shapes verbatim. These extend the Wave-4 tool +
> AssessmentCard pattern exactly (three new tools, three new discriminated
> AssessmentCard variants, tier `read`, in `CLASS_A_TOOL_NAMES`). ⚠ LESSON FROM
> WAVE 4: every tool's `params` MUST be a top-level `z.object` (never a bare
> `z.discriminatedUnion` — the OpenAI API rejects a non-object `parameters`;
> the runtime guard `every tool's params is a top-level type:object` now pins
> this, and the live smoke catches what mocks can't).

## The three tools (lib/tutor/runtime/toolsA3.ts — extend it)

### fadedExample (Class A) — A3-16 is the load-bearing rule
Args (flat object): `{ conceptSlug: string, title?: string|null, problem: string,
steps: Array<{ text: string, answer: string }> }` (2–8 fully-worked steps; the
model authors the COMPLETE worked example — every step + its answer).

**The runtime derives `fadeLevel` from stored mastery, NOT the model, NOT turn
count** (A3-16, expertise-reversal). The tool reads the learner's decayed
mastery for the resolved concept node from `deps.masteryByNode` (a
`Map<nodeId, number>` the loop threads from `gatherLearnerState().masteryRows`
after L3 is built — add the optional field to `TutorToolDeps`). Pure exports
(unit-tested):
- `fadeLevelForMastery(p: number | undefined): 0|1|2|3` — no mastery (undefined
  or p < 0.25) → 0 (fully worked); p < 0.5 → 1; p < 0.75 → 2; p ≥ 0.75 → 3
  (independent problem). A3-16: high mastery → 3, none → 0.
- `blankStepsForFade(stepCount, fadeLevel): number` — how many trailing steps
  are blanked: `Math.round((fadeLevel / 3) * stepCount)` (backward fading —
  level 0 → 0, level 3 → all). The tool marks the LAST N steps `blanked: true`.

Card: `{ cardId, toolName:"fadedExample", conceptSlug, initiation, fadeLevel,
problem, steps: Array<{ text, blanked, answer: string|null }> }` — a blanked
step ships its `answer` for local grading (formative); a shown step ships
`answer` too (the worked value, rendered inline). "MUST NOT advance fade level
within a single turn" — fadeLevel is fixed at authoring.

### predictThenReveal (Class A)
Args: `{ conceptSlug, title?, setup: string, prompt: string, acceptedAnswers:
string[] (1–4), nearMisses: Array<{ pattern: string, misconceptionId: string,
feedback: string }> (0–4), revealExplanation: string }`.
Card mirrors + `{ cardId, toolName:"predictThenReveal", initiation }`.
Client grading (formative, keys ship): normalize (trim/lowercase); a submitted
prediction that contains/equals an acceptedAnswer → `demonstrated`; else the
first `nearMisses[i].pattern` (lowercased) that the prediction contains →
`not_demonstrated` + that `misconceptionId` + its `feedback`; else
`not_demonstrated`, misconceptionId null. Then reveal `revealExplanation`.

### explainBack (Class A) — A3-17, the ONE new interaction shape (SERVER grading)
Args: `{ conceptSlug, title?, prompt: string, rubric: Array<{ criterion: string,
required: boolean }> (2–5) }`.
Card mirrors + `{ cardId, toolName:"explainBack", initiation }`.
"At most once per session per concept": the loop threads
`deps.explainBackConcepts: Set<string>` (resolved node ids already explainBacked
in the session window, derived from history grounding.assessments) and the tool
DROPS a duplicate (returns `{ data: { assessment: null, error:
"already_explained" } }`, logged — the loop skips a null assessment).
Offered only when mastery is strong (L0 guidance — not a hard gate).

**Grading is SERVER-side (free text → semantic rubric-presence), a new route
action `explain_back_grade`:**
```ts
body = { action: "explain_back_grade", courseId, publicationId, version, lessonId?,
  cardId, conceptSlug, text, rubric: [{ criterion, required }], initiation }
```
The route: access-gated like practice_answer; a POOLED structured model call
(`withPooledModel(createOpenAIModelClient(), { pool: poolFor("learner"), cost:
… jobType: "practice_gen" })` — reuse the small tier; NEVER a fresh unpooled
client — A3-20) grades presence PER criterion: returns `{ criteria: [{ criterion,
present: boolean, note: string }] }`. **MUST grade on PRESENCE of the idea, not
wording** (say so in the grading system prompt). Outcome for evidence: all
`required` criteria present → `demonstrated`; ≥1 required present but not all →
`partial`; none → `not_demonstrated`. Then `recordToolEvidence` (completionKey
`toolcard:{cardId}`, toolName explainBack, that outcome, misconceptionId null,
fadeLevel null) + the same refold. **Returns `{ ok, criteria, outcome }` — NO
pass/fail verdict field; the CLIENT shows criterion-level met/unmet + notes ONLY
(A3-17).** On a model failure: return `{ ok:false, error }` (the card shows a
plain retry; no evidence recorded) — fail closed, never a fake grade.

## Wiring (mirror Wave 4 exactly)
- `TUTOR_TOOL_NAMES` 8→11; `TUTOR_TOOL_TIERS` +3 `read`; `CLASS_A_TOOL_NAMES`
  += all three. `firstNodeIdFromArgs` already reads `conceptSlug` (Wave 4) — no
  change. R-6 map: rung 2 may now also offer `fadedExample` (per the directive
  ladder: rung 2 = sequenceTask/fadedExample level 2–3; rung 3 = fadedExample
  level 0–1) — keep the map data faithful to the directive §4 table, resolving
  to implemented tools.
- Loop `collectToolOutputs`: fadedExample/predictThenReveal/explainBack → the
  assessments sink (a null explainBack assessment is skipped). The sink already
  stamps `initiation`. The settled return already forces `assessments: []` on a
  question turn.
- sseProtocol `AssessmentCardSchema`: extend the discriminated union with the
  three variants. Client `TutorAssessmentCard` mirror likewise (zod-free).
- Payload/route assembly unchanged (assessments array already carries them).

## Client (components/learn/tutor/, new files + TutorBody dispatch)
- `TutorFadedExampleCard.tsx` — shows the problem + steps; non-blanked steps
  render worked (text + answer); blanked steps render an input; on submit, grade
  each blank locally (trim/lowercase vs the step's answer) → outcome (all blanks
  right → demonstrated · some → partial · none → not_demonstrated) → reveal the
  answers → POST tool_evidence with `fadeLevel` (the card's) → recordSessionAttempt.
- `TutorPredictCard.tsx` — setup + prompt + a prediction input; on submit, grade
  via the pure matcher → reveal outcome + revealExplanation (+ the nearMiss
  feedback when matched) → POST tool_evidence with misconceptionId → attempt.
- `TutorExplainBackCard.tsx` — prompt + a textarea; on submit, POST
  `explain_back_grade`; render the returned criterion list (met ✓ / not-yet ○ +
  note) with NO pass/fail verdict (A3-17); a model failure shows a plain retry;
  → recordSessionAttempt on a graded result. Latency in an event handler.
- Pure client scorers in tutorClientTypes.ts (zod-free, unit-tested), agreeing
  with any server twin: `scoreFadedCard(card, filledAnswers)`,
  `scorePredictCard(card, prediction)`.
- A11y (A3-25): labelled inputs, textarea with an accessible label, no positive
  tabindex, no framer-motion, no Date.now/Math.random in render.

## Prompt (ONE L0 bump → tutor-v5)
Add the three tools to `== YOUR TOOLS ==` + a terse teaching line: use
`fadedExample` for worked-example practice (the tutor sets how much is blanked
from the learner's mastery — author the FULL worked steps); use
`predictThenReveal` to make the learner commit a prediction before the answer;
use `explainBack` (sparingly — at most once per concept per session, and only
when the learner's mastery is already strong) to have them self-explain against
a rubric. Bump `TUTOR_PROMPT_VERSION` "tutor-v4" → "tutor-v5"; update the
verify-tutor-runtime pin + L0 section-inventory + tool-count/CLASS_A assertions.

## Tests
- verify-tutor-runtime: A3-16 (`fadeLevelForMastery` matrix — none→0, high→3, the
  three thresholds; `blankStepsForFade` — 0→0, 3→all, proportional; a
  fadedExample tool exec with a stubbed masteryByNode → high-mastery node blanks
  all steps, no-mastery node blanks none); predictThenReveal card builds;
  explainBack card builds + the session-duplicate drop; A3-19 (spy: a Class-A
  tool exec is NOT called on an intercepted question turn — structural); tool
  param top-level-object guard already covers the new tools (11 now). Update
  version/inventory/count/CLASS_A pins.
- verify-tutor-client: `scoreFadedCard` + `scorePredictCard` matrices; the
  ExplainBack criterion-render helper (no verdict); a11y structural asserts;
  payload-parity unchanged (assessments already listed); frame-reducer fixtures
  ok.
- verify-tutor-route-int: a fadedExample on an accepted turn for a seeded
  high-mastery concept → fadeLevel 3 in the card; an explain_back_grade POST
  (mock model returns criteria) → criterion results + exactly one
  tutor_evidence_recorded row with the mapped outcome, idempotent; A3-20
  structural (the grade path uses withPooledModel).
