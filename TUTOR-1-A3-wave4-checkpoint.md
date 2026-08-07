# TUTOR-1 — Amendment A3, Wave 4 Checkpoint: Core tools

**Date:** 2026-08-08 · **Status:** Wave 4 COMPLETE → **HARD STOP.**
Three generative-UI tools land into the Wave-3 governed surface:
**`renderStructure`** (Class P — real diagrams instead of ASCII, the D-5 fix
completed), **`checkUnderstanding`** (Class A — retrieval practice where every
wrong option names a misconception), **`sequenceTask`** (Class A — ordering
with forgiving partial credit). No new dependencies (the diagram surface is
reused pure), no migration (Wave-2's `tutor_evidence_recorded` + registry
carry the evidence), one L0 bump (`tutor-v4`). The design thesis is now real:
a wrong answer identifies WHICH incorrect model the learner holds.

## 1. In-scope acceptance criteria → proofs

| AC | Criterion | Proven by | Result |
| --- | --- | --- | --- |
| A3-12 | `renderStructure` unaffected by gating; renders inside a question turn | `verify-tutor-runtime` (loop-level: a scripted renderStructure call on a question turn → structure passes through, assessments forced []) + **LIVE smoke**: "show me a BST of 1–7" → a validated `tree_diagram` on a question turn | **PASS** |
| A3-13 | `checkUnderstanding` rejects any incorrect option lacking `misconceptionId` | The Zod `superRefine` makes it a PARSE failure (unit-tested both ways) + **LIVE**: the real model returned 4 options, exactly one correct, **every** distractor labeled (`bst-always-logarithmic`, `bst-never-logarithmic`, `bst-root-lookup`) | **PASS** |
| A3-14 | Selecting a distractor → feedback naming that misconception, not a generic correction | `scoreCheckUnderstanding` returns the picked option's `misconceptionId` + `feedback`; the card reveals that feedback (not "the answer is X"); client-suite matrix + live feedback-length check | **PASS** |
| A3-15 | `sequenceTask` adjacent-pairs awards partial credit for one misplaced element | The pure scorer (server `scoreSequence` + client `scoreSequenceCard`, **reconciled to ONE relative-order definition** — see §5) — matrix incl. the middle-transposition case that split them, both → `partial` | **PASS** |
| A3-18 | A malformed generated item is discarded and the invitation re-renders; no partial widget | `renderStructure` drops-and-flags (invalid OR missing body → `diagram: null`, logged, turn still ok — A3-24); `checkUnderstanding`/`sequenceTask` invalid args bounce through the loop as invalid_args (the model re-authors or the invitation stands) | **PASS** |
| A3-24 | No ASCII/monospace structural diagram from any tutor path | L0 `== FORMATTING ==` now ROUTES tree/graph/timeline/axes to `renderStructure` (the Wave-1 "describe in prose" stopgap replaced for these shapes); the tool is the sanctioned channel | **PASS** |
| A3-25 | Every interactive component keyboard-operable + a11y-clean | radiogroup/radio + roving tabindex (checkUnderstanding), `<ol>` + labelled Move up/down buttons (sequenceTask), `<figure>`+role=img (structure); no positive tabindex, no framer-motion, latency in a mount effect — proven by the client-suite STRUCTURAL a11y assertions + the browser axe pass on the live panel. A dedicated axe pass on a *rendered* card (needs a non-deterministic model authoring in-browser) is deferred to Wave 6 hardening — noted, not claimed | **PARTIAL (structural PASS; card-render axe → Wave 6)** |

## 2. What was built

**Server (`lib/tutor/runtime/toolsA3.ts` + wiring):** the three tools; each is
tier `read`; `checkUnderstanding`/`sequenceTask` are in `CLASS_A_TOOL_NAMES`
(so the Wave-3 pre-execution intercept governs them automatically —
`firstNodeIdFromArgs` now also reads a scalar `conceptSlug`), `renderStructure`
is NOT (ungated, A3-12). `renderStructure` maps the four A3 kinds onto the pure
`lib/course/diagram` model and gates each with `validateDiagram`
(drop-and-flag, never a thrown turn). The loop's `collectToolOutputs` routes to
new `structures`/`assessments` sinks; the sink stamps each assessment's
`initiation` from the turn; the settled return forces `assessments: []` on a
question turn (mirroring `practiceItems`) and passes `structures` through. The
R-6 rung→tool map now resolves to `checkUnderstanding` (rungs 0–1, 4) and
`sequenceTask` (rung 2); `generate_practice` stays a governed fallback (rung 3,
documented — full retirement is a follow-up, kept to avoid destabilizing the
Wave-3 legs). **R-2 exercised:** `store: true` on the main tutor_turn call (the
`previous_response_id` chaining seam is now LIVE; `TUTOR_ENABLE_CHAINING` stays
off — textual replay unchanged). New route action `tool_evidence` →
`recordToolEvidence` (completionKey `toolcard:{cardId}`, idempotent) + the same
refold the other evidence endpoints fire.

**Client:** `TutorStructureCard` (reuses `DiagramView`, sized for the dock),
`TutorCheckUnderstandingCard` (radiogroup + optional confidence, reveals
misconception-naming feedback), `TutorSequenceCard` (keyboard up/down reorder,
deterministic shuffle, no drag dep); pure scorers + a shared
`postToolEvidence`; session-attempt recording on completion (feeds the A3-4
hatch gate). Everything rides the lazy TutorBody chunk; zod-free (the diagram
type is a type-only import; `lib/course/diagram/schemas.ts` is never imported
client-side).

## 3. Files

**Created:** `lib/tutor/runtime/toolsA3.ts` · `lib/learn/tutorEvidence.ts` ·
`components/learn/tutor/{TutorStructureCard,TutorCheckUnderstandingCard,
TutorSequenceCard}.tsx` · `docs/tutor/a3-wave4-contract.md` (build-coordination
doc — folds into the Wave 6 docs pass) · this checkpoint.
**Modified:** `lib/tutor/runtime/{tools,loop,invocationPolicy,toolTiers,
sseProtocol,promptLayers}.ts` · `app/api/learn/tutor/route.ts` ·
`lib/learn/{tutorClientTypes,useTutorStream,tutorHistory}.ts` ·
`components/learn/tutor/TutorBody.tsx` · `scripts/verify-tutor-{runtime,client,
route-int,stream-infra,stream-int}.ts`.
**No migration. No package.json change. No new dependency.**

## 4. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0**, zero warnings |
| `npm test` (full pure chain; runtime 220/0 with the new top-level-type guard, client 357/0) | exit **0**, zero failures |
| `npm run verify:tutor:int` (16 live suites incl. Wave-4 route-int §f/§g — RE-RUN clean after the schema fix) | exit **0**, every suite 0 failed; (f) checkUnderstanding→one `tutor_evidence_recorded` row (idempotent re-POST) + (g) structure on a question turn, no evidence |
| `npm run verify:budgets` | **6/6** — `/learn/[slug]/[lessonId]` byte-identical **216.3 KB** (diagram surface + 3 cards all in the lazy chunk) |
| **Live smoke (real model)** — renderStructure diagram + checkUnderstanding misconception labels | **12/0** |
| `verify:tutor:browser:stream` (live regression on the modified TutorBody) | **20/0, zero flake retries** |

## 5. Two consolidation fixes (bugs the parallel unit suites could not catch)

1. **The scorers disagreed.** Server `scoreSequence` counted *correct-order
   pairs kept adjacent*; client `scoreSequenceCard` counted *submitted pairs in
   correct relative order*. Both unit suites passed because neither tested a
   middle transposition (`a,c,b,d`) — where the server said `not_demonstrated`
   and the client said `partial`. The client is the AUTHORITATIVE grader and
   its relative-order metric is the directive-correct one ("one element
   misplaced is not a total failure"), so the server scorer was reconciled to
   it, and BOTH suites now pin the exact splitting input.
2. **The live OpenAI API rejected `renderStructure`.** Its params were a
   top-level `z.discriminatedUnion`, which converts to `anyOf` with no
   top-level `type: object` → a live 400 (`"got type: None"`) the mock never
   sees. Refactored to a flat top-level object (`kind` + per-kind nullish
   bodies, the standard strict-function-schema shape; a missing body
   drops-and-flags). A NEW runtime assertion now pins every tool's params to a
   top-level `type: "object"`, so this class of live-only failure is caught in
   `npm test`. The live smoke — which exists precisely to catch what mocks
   can't — is what surfaced it.

## 6. Deviations

1. **`generate_practice` kept** (not retired) — the Wave-3 int legs use it as
   the Class-A example, and it's a harmless governed fallback now that the R-6
   map prefers the new tools. Full retirement is a documented follow-up.
2. **`store: true` scoped to the main tutor_turn call** only (not the repair
   sub-calls) — minimal, safe; the seam is what R-2 asked for.
3. **History persistence (R-A3-6) not closed** — structures/assessments live
   for the turn and don't survive reload, matching the `practiceItems`
   precedent (`buildGrounding` persists citations/spans/flags/markers/
   invitation only). A deliberate inherited gap, not new debt.
4. **The `tool_evidence` route-int proof drives the service seam** (calls
   `recordToolEvidence` with the route's exact completionKey) rather than an
   HTTP request — the suite has always tested the service seam.

## 7. Risk changes for Wave 5

- Wave 5's `fadedExample`/`predictThenReveal`/`explainBack` slot in the same
  way; `fadeLevel` now has a real column (Wave 2) + the evidence path carries
  it; the mastery-by-node read (`gatherLearnerState`) is where A3-16 derives
  the fade level.
- `explainBack` is free-text graded against a rubric — the ONLY new
  interaction shape; its formative (no pass/fail) rendering follows the
  checkUnderstanding feedback precedent.

---

**Awaiting approval to proceed to Wave 5 (adaptive tools: `fadedExample`,
`predictThenReveal`, `explainBack`).**
