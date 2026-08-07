# TUTOR-1 — Amendment A3, Wave 1 Checkpoint: Defect repair (D-1..D-6)

**Date:** 2026-08-07 · **Status:** Wave 1 COMPLETE → **HARD STOP.**
All six §1 defects repaired, plus the audit's three latent defects in the same
areas and the A2 lint dust. No new tools (per the wave mandate); no migration
(no schema change); no wire-protocol change; zero new dependencies. The tutor
now renders correctly, answers the message the learner actually sent, and no
longer discards answers it already streamed.

## 1. In-scope acceptance criteria → proofs

| AC | Criterion | Proven by | Result |
| --- | --- | --- | --- |
| A3-1 | Markdown renders: bold, lists, fenced code, inline code | `verify-tutor-client` §A3-1 (13 checks: all-four fixture, fence language tag consumed, span-boundary splits parse per-segment) + live browser 20/0 through the new renderer | **PASS** |
| A3-2 | No rung identifier in learner-facing output | `verify-tutor-client` §A3-2 source assertions (no `RungBadge`, no `"Rung "` literal); the wire/row keep rung internal | **PASS** |
| A3-3 | Two suggestions resolving to the same action never both render | Server: `verify-tutor-runtime` §A3/D-3 (byte-identical + downgrade-manufactured duplicates collapse; distinct blocks survive) · Client legacy-row leg: `verify-tutor-client` §A3-3 | **PASS** |
| A3-5 | No escape hatch on a turn where the full answer was given | `shouldOfferEscapeHatch(rung)` — false at rung 4 AND null; `verify-tutor-client` §A3-5 | **PASS** |
| A3-24 (prompt half) | No ASCII/monospace diagrams | L0 `== FORMATTING ==` ban (tutor-v2); render-path half completes when `renderStructure` ships (Wave 4) | **PASS (Wave-1 scope)** |
| D-6 | "hello" no longer answers the previous question | Four-layer fix (§2) · pure suites · **live re-run of the Wave-0 reproduction: 9/0** — post-abort "hello" → rung 0, 178 chars: *"Hello! We can pick up your question about why hash-table lookup is described as **O(1)** whenever you're ready. Would you like a brief explanation…"* | **PASS** |

(A3-4's attempt-based hatch gate is Wave 3 scope where session attempt state exists — per the Wave-0 checkpoint.)

## 2. What was built

**D-1** — `components/editor/agent/Markdown.tsx` MOVED to
`components/ui/Markdown.tsx` (the streaming-safe dependency-free markdown-lite
renderer; tokenized to the UI-1 type scale in transit — `text-[12px]`→
`text-meta`, `text-[13px]`→`text-secondary`); tutor prose renders through it
per span (supplemental chrome preserved) and in the streaming bubble; learner
bubbles stay plain text. Everything rides the lazy TutorBody chunk — the learn
route is **byte-identical 216.3 KB**.

**D-2** — the badge is gone (labels were also inverted — rung 0 showed
"Direct answer"); rung stays on the wire, the row, and telemetry. Latent fix:
both history loaders (server `loadThreadHistory`, client `tutorHistory`) now
select the `rung` COLUMN and inject it into the in-memory grounding — the
session rung trail sees real values for ALL rows, historical included (the
jsonb was never written and the table is immutable; the column was always the
truth).

**D-3** — citations dedup by jump-target identity
(`lessonId|blockId|slideId`) server-side in `validateTurnOutput` AFTER the
slide-downgrade normalization (the downgrade path manufactured byte-identical
duplicates), so persisted grounding jsonb is clean; the client dedups too
(legacy rows) and the chip key lost its index suffix.

**D-4** — the escape hatch renders only below rung 4 (`shouldOfferEscapeHatch`;
null/legacy rungs fail toward no hatch).

**D-5** — L0 `== FORMATTING ==`: the supported markdown subset is taught;
tables/links/images/HTML banned; **ASCII/monospace diagrams banned** ("a visual
channel does not exist yet; describe structure in prose").

**D-6** — four layers: (i) the per-turn input delimits
`== CONVERSATION SO FAR ==` from `== CURRENT MESSAGE ==` (per-turn bytes, no
cache cost); (ii) `serializeHistory` marks dangling learner lines
` [no tutor reply was delivered]`; (iii) **the grounding ok-rule now matches
its own documented contract**: `ungrounded` fires ONLY on substantive
(>200 chars) citation-less prose with no escalation proposal — a greeting is
not a claim. The old any-grounded-span-without-citations rule failed routine
turns (both Wave-0 happy-path greetings settled `ok:false ungrounded`),
discarded the streamed answer, and stranded the question — THE precondition
factory. `span_parse_error` still fails ok deliberately (relaxing it could
leak supplemental content under a strict canon); (iv) `loadThreadHistory`
reads the NEWEST tail (descending + reverse — ascending+limit replayed the
oldest 40) and drops the just-written learner row BY ID, not position. L0
gained `== THE CURRENT MESSAGE ==` (respond to the current message; context
only; acknowledge-and-offer on marked unanswered questions). ONE prompt bump:
**tutor-v1 → tutor-v2**.

**Consolidation extras** — the browser suites counted settled bubbles via the
escape-hatch selector (broken by the D-4 gate): the assistant bubble now
carries `data-ai-component="tutor-assistant-bubble"`, all 11 selector sites
repointed, and the two clone-and-strip text extractors strip ALL interactive
chrome (they previously left citation-chip labels in the measured text). All
five A2-era lint warnings cleaned — the repo lints at zero warnings.

## 3. Files

**Created:** `components/ui/Markdown.tsx` (moved) · this checkpoint.
**Deleted:** `components/editor/agent/Markdown.tsx` (moved) ·
`scripts/zz-a3-w1-smoke.ts` (transient live smoke — transcript in §5).
**Modified:** `components/learn/tutor/TutorBody.tsx` ·
`components/editor/agent/AgentPanel.tsx` · `lib/learn/tutorClientTypes.ts` ·
`lib/learn/tutorHistory.ts` · `lib/learn/useTutorStream.ts` (lint dust only) ·
`lib/tutor/runtime/{grounding,history,promptLayers,service}.ts` ·
`scripts/verify-tutor-client.ts` (178→205) ·
`scripts/verify-tutor-runtime.ts` (84→110) · `scripts/verify-agent-ux.ts`
(import) · `scripts/verify-tutor-stream-browser.ts` ·
`scripts/verify-tutor-browser.ts` (selector repoint) ·
`scripts/verify-tutor-route-int.ts` (comment) · `scripts/e2e-inngest-live.ts`
(lint dust).

## 4. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0** — **zero warnings repo-wide** (was 5) |
| `npm test` (full pure chain) | exit **0**, zero failures (incl. verify-ui 154/0 after tokenizing the moved Markdown) |
| `npm run verify:tutor:int` (16 live suites) | exit **0**, every suite 0 failed |
| `npm run verify:budgets` | **6/6 PASS** — `/learn/[slug]/[lessonId]` byte-identical **216.3 KB**; studio unchanged 590.4 |
| `verify:tutor:browser:stream` (live: dev server + real model + Upstash) | **20/0, zero flake retries** |
| Live D-6 smoke (real model, transient script) | **9/0** — transcript in §5 |

## 5. The live D-6 smoke (the Wave-0 reproduction, re-run on the fix)

Same scenario as the audit's reproduction, real model: (A) a bare "hi there!"
now settles `ok:true, flags=[]` with its assistant row persisted (pre-fix:
`ok:false ungrounded`, error card, no row). (B) a substantive hash-table
question aborted at the first token (dangling row), then "hello": the
assembled input carried the frozen delimiter + dangling marker, and the reply
was rung 0, 178 chars — a greeting that acknowledges the open question and
OFFERS to pick it up. The defect behavior (a full unsolicited answer) did not
reproduce. Script deleted; fixture rows cleaned; tree clean.

## 6. Deviations

1. **D-6 fix (iii) refined at design time** — the Wave-0 checkpoint said
   "persist flagged ok:false assistant rows"; reading `grounding.ts` showed
   the better cut: the ok-rule itself contradicted its documented contract and
   was failing VALID turns. Fixing the rule makes those turns settle normally
   (row persists because the turn is fine), keeps live/history views
   consistent, and needs no persistence special-case. True failures (aborts,
   transport errors) still persist nothing and are covered by the dangling
   marker + L0 rule. Same goal, smaller and truer mechanism.
2. **`verify-tutor-runtime` tight-budget constant 60→100** — the dangling
   marker's bytes made the old fixture line unfittable; same semantics
   asserted (documented in-test).
3. **The moved Markdown was tokenized** (`text-meta`/`text-secondary`) — the
   UI-1 token lint correctly claimed it the moment it entered
   `components/ui/`; visual size unchanged (12/13 px tokens).

## 7. Risk changes for later waves

- The rung trail is now REAL history-wide — Wave 3's invitation/cooldown
  policy can rely on it (it was silently empty before this wave).
- Grounding-strictness note for Wave 6's docs pass: the ok-rule change is
  learner-visible policy (fewer error cards, more settled turns) — worth one
  line in `docs/tutor/runbook.md` when Wave 6 touches docs; behavior is
  already documented in `grounding.ts`'s header.
- `tutor-v2` invalidates the L0 cache line — the first live turn per course
  re-warms it (observed in the smoke; no action).
- The A2 metrics instrument (`scripts/measure-tutor-turn-metrics.ts`) still
  works unchanged (same service seam) — re-baselining is Wave 6's call.

---

**Awaiting approval to proceed to Wave 2 (evidence spine: `tutor_evidence_recorded`, the misconception registry, repository writes, concept-graph read path, `[FWD]` seam fields — under gate rulings R-1..R-4).**
