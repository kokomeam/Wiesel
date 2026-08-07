# TUTOR-1 — Amendment A3, Wave 5 Checkpoint: Adaptive tools

**Date:** 2026-08-08 · **Status:** Wave 5 COMPLETE → **HARD STOP.**
The three adaptive tools land into the governed surface: **`fadedExample`**
(worked-example fading whose difficulty the RUNTIME derives from stored mastery
— never the model, never turn count), **`predictThenReveal`** (commit a
prediction before the answer), **`explainBack`** (self-explanation graded
against a rubric by criterion PRESENCE, formative-only). No migration (Wave-2's
`tutor_evidence_recorded` + `fade_level` carry it), no new dependency, one L0
bump (`tutor-v5`). The tutor surface now spans all six §3 tools.

## 1. In-scope acceptance criteria → proofs

| AC | Criterion | Proven by | Result |
| --- | --- | --- | --- |
| A3-16 | `fadeLevel` derived from stored mastery; high → 3, none → 0 | `fadeLevelForMastery` (pure; <0.25→0, <0.5→1, <0.75→2, ≥0.75→3) + `blankStepsForFade` (backward fading; level 3 → all steps) — runtime matrix + route-int (h). **LIVE smoke**: a seeded 0.9-mastery node → the real model echoed the node uuid → the runtime derived **fadeLevel 3** and blanked all 4 steps | **PASS** |
| A3-17 | `explainBack` returns criterion-level formative feedback, no pass/fail verdict | The `explain_back_grade` route action grades criterion PRESENCE via a pooled model call; `outcomeFromExplainBackGrade` maps (all required present → demonstrated · ≥1 → partial · none → not_demonstrated) for evidence ONLY; the client renders met/not-yet + notes, no verdict (pure `explainBackCriteriaView` asserted verdict-free). **LIVE**: a good explanation → demonstrated, a weak one → not_demonstrated, graded on presence not wording | **PASS** |
| A3-19 | Item generation does not run for an ignored invitation (spy) | Structural: a Class-A tool `execute` is NOT called on an intercepted question turn (the Wave-3 pre-execution intercept) — runtime spy assertion. An ignored invitation never reaches an acceptance turn, so no generation | **PASS** |
| A3-20 | Item generation never raises concurrent model calls above the ceiling | The `explain_back_grade` grading call goes through `withPooledModel(…, poolFor("learner"))` — never a fresh unpooled client (structural + route-int (i) asserts the pooled wrapper carried the grading call) | **PASS** |
| A3-25 | Every interactive component keyboard-operable + a11y | Faded: `<label htmlFor>`+`<input id>` per blank, `<ol>` order; Predict: labelled prediction input, reveal gated behind commit; ExplainBack: labelled `<textarea>`, sr-only met/not-yet text — no positive tabindex, no framer-motion, latency in handlers/effects (client-suite structural asserts; browser axe on the live panel). Dedicated card-render axe → Wave 6 (as W4) | **PARTIAL (structural PASS; card-render axe → Wave 6)** |

## 2. What was built

**Server (`lib/tutor/runtime/toolsA3.ts` + wiring):** the three tools (flat
top-level `z.object` params — the Wave-4 rule, guarded). **`fadedExample`**
reads the learner's decayed mastery for the resolved node from
`deps.masteryByNode` (the loop threads it from `gatherLearnerState().masteryRows`
after L3), derives `fadeLevel` deterministically, and marks the last N steps
blanked — the model authors the FULL worked example, the RUNTIME sets the
difficulty (A3-16; fadeLevel fixed at authoring — never advanced in-turn).
**`predictThenReveal`** ships accepted answers + near-miss misconception
matchers. **`explainBack`** authors a rubric; the once-per-concept-per-session
guard drops a duplicate (the loop threads `explainBackConcepts` derived from the
session window — `buildGrounding` now stamps a compact `{toolName, conceptSlug}`
marker per delivered card so the derivation has data, no keys leaked). All three
are tier `read`, in `CLASS_A_TOOL_NAMES` (governed by the Wave-3 intercept); the
R-6 map now offers `fadedExample` at rung 3. **The new `explain_back_grade`
route action** is the wave's one new interaction shape: a POOLED structured
model call grading criterion PRESENCE (system prompt: judge the idea, not
wording), mapped to an evidence outcome, `recordToolEvidence` +
refold; returns `{ ok, criteria, outcome }` with NO verdict; a model failure
fails closed (no fake grade, no evidence). L0 → **tutor-v5**.

**Client:** `TutorFadedExampleCard` (worked steps inline, blanked steps as
labelled inputs, reveal on submit), `TutorPredictCard` (commit-before-reveal —
nothing reveals until the learner commits), `TutorExplainBackCard` (textarea →
awaits `gradeExplainBack` → renders the criterion list with notes and NO
verdict; a failed grade shows a plain retry). Pure scorers (`scoreFadedCard`,
`scorePredictCard`) + the verdict-free `explainBackCriteriaView`. All ride the
lazy TutorBody chunk; zod-free.

## 3. Files

**Modified:** `lib/tutor/runtime/{toolsA3,tools,loop,invocationPolicy,
toolTiers,sseProtocol,service,promptLayers}.ts` · `app/api/learn/tutor/route.ts`
· `lib/learn/{tutorClientTypes,tutorEvidence,tutorHistory}.ts` ·
`components/learn/tutor/TutorBody.tsx` · `scripts/verify-tutor-{runtime,client,
route-int}.ts`.
**Created:** `components/learn/tutor/{TutorFadedExampleCard,TutorPredictCard,
TutorExplainBackCard}.tsx` · `docs/tutor/a3-wave5-contract.md` (build doc — folds
into Wave 6) · this checkpoint.
**No migration. No package.json change. No new dependency.**

## 4. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0**, zero warnings |
| `npm test` (full pure chain; runtime 263/0, client 436/0) | exit **0**, zero failures |
| `npm run verify:tutor:int` (16 live suites incl. route-int (h)/(i)) | exit **0**, every suite 0 failed (route-int 77/0) |
| `npm run verify:budgets` | **6/6** — `/learn/[slug]/[lessonId]` byte-identical **216.3 KB** (6 cards + diagram surface in the lazy chunk) |
| **Live smoke (real model)** — A3-16 fade-from-mastery + A3-17 rubric grading | **7/0** |
| `verify:tutor:browser:stream` (live regression) | **20/0, zero flake retries** |

## 5. The A3-16 live proof — and what its first two runs taught

The load-bearing rule needed a LIVE proof (the model must echo the real concept
node uuid for the mastery lookup to resolve). It took two fixture corrections
that are worth recording:
1. The seed used `writeMastery`'s exact row shape wrong → a direct
   `learner_mastery` insert with the full column set.
2. **The seeded concept node had no `anchors`** → it was filtered OUT of the L2
   lesson context, so the model never saw its uuid and invented a slug
   (`bst-insertion`). Anchoring the node to the lesson's blocks fixed it — and
   this RESOLVES the "invented slug" worry noted in Waves 3–4: the model DOES
   echo the real node uuid when the concept is anchored (as the real
   auto-extracted graph always is). With the anchor, the run showed
   `conceptSlug=<real uuid>`, `fadeLevel=3`, all steps blanked.
3. The message must be a delivery path — "let me try one" (practice_request), or
   the Class-A call downgrades on a question turn (which route-int leg (h)
   originally tripped on with a stale acceptance claim — §6).

## 6. Consolidation fix (a bug the parallel unit suites missed)

Route-int leg (h) claimed `invitation_accepted` for a fresh learner with NO
prior offered invitation — so `resolveInitiation` correctly rejected the stale
claim (fail-toward-question), the fadedExample call downgraded to an invitation,
and the turn carried ZERO assessments (`{n:0}`). Fixed to the practice_request
delivery path ("let me try one", no claim — mirroring legs (c)/(f)), which needs
no prior offer; leg (h) now 77/0. The live smoke had surfaced the same
delivery-path requirement, so the fix was already validated end-to-end.

## 7. Deviations

1. **`buildGrounding` now stamps a compact `{toolName, conceptSlug}` per
   delivered assessment card** — the contract's explainBack once-per-session
   guard needs prior cards in history, which weren't persisted before. No keys
   or full cards leak into history grounding; just the marker.
2. **conceptSlug resolution for fadeLevel is a direct `masteryByNode` lookup by
   the raw slug** (R-1: conceptSlug IS the node uuid); merge-chain resolution
   stays at evidence time in `recordToolEvidence`. An unresolvable slug → fade 0
   (safe default). The live proof confirms real uuids resolve.
3. **A3-25 card-render axe** deferred to Wave 6 (same as W4) — structural a11y
   is proven; a rendered-card axe needs non-deterministic in-browser authoring.

## 8. Risk changes for Wave 6

- All six §3 tools now exist and are governed. Wave 6 is tests + docs: the
  deferred card-render axe pass (W4+W5 cards), the full `docs/tutor/` fold-in of
  the two build-contract docs, and the §8 completeness sweep.
- The concept-id-echo now has a live-verified precondition (anchored nodes) —
  worth one line in the Wave-6 docs: the tools' node resolution depends on the
  graph being anchored, which publish-time extraction guarantees.

---

**Awaiting approval to proceed to Wave 6 (tests and documentation — the
amendment's final wave).**
