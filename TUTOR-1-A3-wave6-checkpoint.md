# TUTOR-1 — Amendment A3, Wave 6 Checkpoint: Tests + documentation — AMENDMENT CLOSE

**Date:** 2026-08-10 · **Status:** Wave 6 COMPLETE → **HARD STOP + A3 CLOSE.**
The amendment's final wave: the deferred card-render a11y proof, the canonical
documentation, a skeptical completeness audit across A3-1..A3-25, and the two
code/coverage gaps that audit surfaced — both fixed. Every §8 acceptance
criterion is now proven at its intended level with no deferred items.

## 1. What Wave 6 delivered

**The deferred card-render a11y suite (A3-25).** A deterministic fixtures route
(`app/zz-tutor-cards/page.tsx` + `components/learn/tutor/cardFixtures.tsx`,
mirroring the `zz-ui-fixtures` precedent) renders all six A3 cards; the new
`verify:tutor:browser:cards` (Playwright + axe) proves **zero serious/critical
axe violations** (and, after the contrast fix below, **zero violations of any
impact**), radiogroup/radio + roving-tabindex semantics, keyboard operation end
to end (Tab/Arrow/Enter/Space), the A3-18 malformed-item graceful fallback, and
the A3-4 hatch hidden→shown flip over the real store — 38/0.

**A real AA contrast finding, fixed.** The suite surfaced (rather than
suppressed) a genuine pre-existing failure: the Wave-4/5 cards used
`text-stone-400` for muted micro-copy (~2.6:1 on white, below AA). Bumped the
visible instances to `text-stone-500` (passes AA on white per the design
system; placeholders + aria-hidden glyphs are contrast-exempt and untouched).
Axe now reports **0 violations any-impact**.

**A3-18 — a genuine CODE gap closed.** The audit found that on a delivery turn
(accepted invitation / practice request) where a Class-A tool's args fail
validation (e.g. a checkUnderstanding option missing its misconceptionId — the
A3-13 reject), the turn produced no card AND no re-offered invitation — the
learner accepted and got silence. Implemented the re-offer: the loop tracks the
attempted delivery tool, and `applyInvocationPolicy` re-offers its invitation
when a delivery produced NEITHER an assessment nor a practiceItem (the "produced
nothing" check spans both sinks — a successful legacy `generate_practice`
delivery lands in `practiceItems`, so it must not false-trigger). Proven by 6
new pure + loop-level A3-18 tests.

**A3-20 — a structural belt.** A source assertion pins the `explain_back_grade`
route action to `withPooledModel(createOpenAIModelClient())` — never a fresh
unpooled client (the only separate learner-facing model call; the tools author
in the one pooled tutor_turn).

**Canonical documentation.** `docs/tutor/pedagogy-tools.md` (NEW) is the single
permanent home for the A3 design — the thesis, the six tools, the invocation
policy, the evidence spine, fade-from-mastery, explainBack grading, the [FWD]
seams, the test map, and the R-1..R-6 rulings. The two temporary build-contract
docs (`a3-wave4-contract.md`, `a3-wave5-contract.md`) are deleted; cross-refs
added to `runbook.md`/`architecture.md`/`analytics.md`.

**A latent build bug fixed.** `verify-tutor-stream-browser.ts` was never in the
tsconfig exclude list (an A2 omission that only escaped notice because
playwright lingered in `node_modules`); it + the new cards suite are now
excluded, matching every other browser suite — `next build` is safe.

## 2. Completeness audit result (A3-1..A3-25)

A read-only auditor verified every AC against its ACTUAL test assertion (a
checkpoint claim is not proof), flagged five as thin/missing, and I closed all
five: A3-25 (card-render axe — the new suite), A3-18 (the re-offer code + tests),
A3-14 (the card-render suite asserts the picked distractor's feedback surfaces),
A3-4 (the browser hidden→shown flip), A3-20 (the structural belt). The
consolidated ledger is `TUTOR-1-A3-completion-ledger.md`. **25/25 proven.**

## 3. Files

**Created:** `docs/tutor/pedagogy-tools.md` · `app/zz-tutor-cards/page.tsx` ·
`components/learn/tutor/cardFixtures.tsx` · `scripts/verify-tutor-cards-browser.ts`
· `TUTOR-1-A3-completion-ledger.md` · this checkpoint.
**Modified:** `lib/tutor/runtime/{loop,invocationPolicy}.ts` (A3-18 re-offer) ·
`components/learn/tutor/Tutor{CheckUnderstanding,Sequence,FadedExample,Predict,
ExplainBack,Structure}Card.tsx` (contrast) · `scripts/verify-tutor-runtime.ts`
(A3-18 + A3-20 tests) · `package.json` (cards script) · `tsconfig.json` (exclude)
· `docs/tutor/{runbook,architecture,analytics}.md` (cross-refs).
**Deleted:** `docs/tutor/a3-wave4-contract.md` · `docs/tutor/a3-wave5-contract.md`.
**No migration. No new runtime dependency (22).**

## 4. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0**, zero warnings |
| `npm test` (full pure chain; runtime 270/0 incl. the new A3-18/A3-20) | exit **0**, zero failures |
| `npm run verify:tutor:int` (16 live suites — A3-18 loop-change ripple check) | exit **0**, every suite 0 failed |
| `npm run verify:budgets` | **6/6** — `/learn/[slug]/[lessonId]` byte-identical **216.3 KB** |
| `verify:tutor:browser:cards` (live: fixtures + axe) | **38/0 · axe 0 violations any-impact** |
| `verify:tutor:browser:stream` (live regression) | **20/0, zero flake retries** |

## 5. Deviations

None. The A3-18 re-offer is a new mechanism (the directive's "the invitation
re-renders with a retry"), implemented rather than documented-around — the
audit correctly identified it as the one AC that needed code, not just a test.

---

**A3 IS COMPLETE.** Six waves, each hard-stopped and approved; all 25 acceptance
criteria proven; the tutor now renders correctly, invites rather than imposes,
observes mastery through every assessment, and names the misconception behind
every wrong answer. Commits: `60d1126` (W0 audit) → `6322ca7` (W1) → `04c43dc`
(W2) → `7459aaa` (W3) → `cdc591a` (W4) → `4df2c8b` (W5) → this wave's commit.
**HARD STOP — nothing beyond A3's scope begins without a new directive.**
