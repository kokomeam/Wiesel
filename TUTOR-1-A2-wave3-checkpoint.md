# TUTOR-1 — Amendment A2, Wave 3 Checkpoint: Client + status indicator

**Date:** 2026-08-07 · **Status:** Wave 3 COMPLETE → **HARD STOP.**
The learner now SEES the stream: truthful status phases fill the reasoning gap
("Sending your question" → "Working through it" → "Writing your answer"), the
answer renders token-by-token into a growing bubble, the settled grounded turn
replaces it seamlessly, and a mid-answer refresh re-attaches. All on the
approved native seam — the bespoke zod-free client extended, no `useChat`, no
new dependencies.

## 1. Acceptance criteria

| AC | Proof | Result |
| --- | --- | --- |
| A2-13 text renders incrementally (≥3 growing samples) | `verify-tutor-stream-browser.ts` (**17/0, run twice, zero flakes**) — live dev server + real Luna + live Upstash: the answer node's textContent grew through **11 strictly-increasing samples** (158→1,495 chars; settled 1,506 ≥ last sample); run 2: 6 samples → 1,701 | **PASS** |
| A2-14 sub-400ms phase change held until the floor | `verify-tutor-client.ts` (**178/0**): `createPhaseFloor` fake-clock — first applies immediately; <400ms proposal HELD + flushed at expiry; latest-wins during a hold; post-floor immediate; reset cancels | **PASS** |
| A2-15 every transition maps to a named stream event; no setTimeout transitions in the component | `verify-tutor-status-ui.ts` (**50/0**): source assertion — `TutorStatusIndicator.tsx` contains NO setTimeout/setInterval/rAF/framer-motion. Transitions: sent=dispatch · thinking=`model_started` (response.created) · composing=`first_token`/first `text_delta` — real frames only; the floor's single flush timer lives in the hook and only DELAYS display, never invents progress | **PASS** |
| A2-16 refresh mid-answer re-attaches + completes | Browser: reload mid-reasoning → the question survives (exactly one copy), exactly ONE assistant answer lands within 60s. Both live runs resolved via the **dangling-question history re-load** (the turn completed server-side inside the reasoning window → GET 204 → fallback); the live re-attach leg (`GET` replay + tail) is proven at the unit level + the real-Upstash smoke (Wave 2) | **PASS** |
| A2-17 status announced via aria-live; automated a11y | Browser: axe **zero serious/critical** with the panel open during a live phase; the live DOM region carries `role="status"` + `aria-live="polite"` + `aria-atomic` (the visible text IS the announced node) | **PASS** |
| A2-18 prefers-reduced-motion ⇒ no animation | Browser: a `reducedMotion:'reduce'` context — phase copy renders with **zero `animate-*` classes** on any descendant | **PASS** |

**Repo gates (bare exits):** recorded in §5 below.

## 2. What was built

- **`TutorStatusIndicator.tsx`** (NEW, standalone) — exactly the §6 contract:
  `TutorStatusPhase = sent | thinking | composing | tool{label}` (the `tool`
  variant reserved `[FWD]`, renders its label verbatim when a later amendment
  populates it). §6/§7 copy verbatim; warm-editorial quiet styling (stone-600
  on paper); the three-dot pulse only when motion is allowed; zero timers.
- **`useTutorStream`** — the phases (`sent`/`thinking`/`composing` join the
  status union), all floored through ONE `createPhaseFloor` per send
  (`lib/learn/phaseFloor.ts`, pure, injectable clock — 400ms display floor;
  `queued`/`error`/`approval`/`idle` bypass it: an error is never held back);
  `streamingText` accumulates deltas and goes public only once `composing`
  has applied (no indicator flicker), nulled in the same cycle the settled
  turn appends (no double bubble); the shared `processTutorFrame` reducer
  (exported pure) drives BOTH send and resume; **resume on mount** (GET
  `?courseId` → 204 nothing / SSE re-attach, one attempt, a send aborts it);
  the **dangling-question fallback** (204 + unanswered tail ⇒ one ~3s history
  re-load — the path both live refreshes took).
- **TTFT re-pointed at truth** — the vital now stamps the first `text_delta`
  (the learner-visible token), not first bytes (~50ms, which rated everything
  vacuously "good"). Buckets recalibrated good<4s / ni<12s / poor≥12s with
  the rationale in the source. The dashboard number now means something.
- **Approval surface (dormant)** — the `approval_required` frame renders an
  amber notice (`data-ai-component="tutor-approval-notice"`, §7 copy, no
  action buttons — no tutor tool is irreversible today; the preview-then-
  decide integration bolts on when one exists).
- **A pre-existing live bug found & fixed by the wave's own tests:** the route
  always emits `done` after `error`, and the old client's `done` handler reset
  status unconditionally — **the error card flashed and vanished**. `done` now
  returns to idle only from non-terminal kinds; `error`/`approval` survive.
- Client wire mirror extended (all seven variants, still zod-free —
  drift-guard greps updated); `ThinkingRow` deleted (superseded).

## 3. Files

**Created:** `components/learn/tutor/TutorStatusIndicator.tsx` ·
`lib/learn/phaseFloor.ts` · `scripts/verify-tutor-status-ui.ts` ·
`scripts/verify-tutor-stream-browser.ts` · this checkpoint.
**Modified:** `components/learn/tutor/TutorBody.tsx` ·
`lib/learn/useTutorStream.ts` · `lib/learn/tutorClientTypes.ts` ·
`scripts/verify-tutor-client.ts` · `package.json` (status-ui suite chained).
**Deleted:** none (ThinkingRow was an internal function of TutorBody).

## 4. Deviations

1. **No `useChat`/`@ai-sdk/react`** — the approved R-1/R-6 ruling: the bespoke
   zod-free hook extended instead; every §6 AC met on the native surface.
2. **A2-16's live browser observation took the fallback path** both runs (the
   fixture's turns complete during the reasoning window before a reload
   finishes). The live re-attach leg is unit-proven + real-Upstash-proven;
   both paths satisfy the AC's contract (re-attach and complete, no loss, no
   duplication).
3. **The phase floor's flush timer lives in the hook**, not the component
   (A2-15's assertion is over the component source, and the directive's
   intent — no fabricated progress — holds: phases only ever ADVANCE on real
   frames; the timer only releases a HELD display).
4. **TTFT bucket recalibration** (good<4s/ni<12s) — a semantic re-point, not a
   gaming of thresholds: the old first-bytes stamp made the vital vacuous;
   the new number is the learner's real first-visible-token latency.

## 5. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0** (the 1 pre-existing baseline warning) |
| `npm test` (pure chain incl. the two new/extended client suites) | exit **0** |
| `npm run verify:tutor:int` (16 suites) | exit **0** (16 suites, all 0 failed) |
| `npm run build` | exit **0** |
| `npm run verify:budgets` | **6/6** — `/learn/[slug]/[lessonId]` **byte-identical 216.3 KB**: the whole streaming client rides the lazy TutorBody chunk, the eager-shell discipline held |
| `verify-tutor-stream-browser` (live, ×2 runs) | **17/0 · 17/0**, exit 0 |

## 6. Risk-profile updates for Wave 4

- Wave 4 is tests + documentation: the directive's Playwright e2e pair is
  DONE early (`verify-tutor-stream-browser.ts` covers send→phases→incremental
  →completion AND refresh→resume→completion); Wave 4 wires it into the
  documented run-book, delivers `docs/tutor/streaming.md`, updates the env
  docs, and re-verifies the §8 table end-state.
- The learn-route bundle grew with the streaming client — budgets gate below
  confirms it stayed inside 250 KB; the exact number lands in this table.
- The int suites + browser suite double as the regression net for any future
  reasoning-summary streaming (`[FWD]` from Wave 2's checkpoint).

**Awaiting approval to proceed to Wave 4.**
