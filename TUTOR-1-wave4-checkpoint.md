# TUTOR-1 — Wave 4 Checkpoint: The Learner Sidebar

**Date:** 2026-08-04 · **Status:** COMPLETE → **GATE** (this wave ends with the
checkpoint posted + the demo path verified working; Henry drives the sidebar
himself before Wave 5 is issued — Wave 4's order § "Gate").

**Wave-3 HARD STOP release (recorded per the order's §0):** Henry, in session —
*"Please continue with ultracode using opus 5 subagents and close out wave 4."*
and earlier *"Start wave 4 please"* following the `c196f15` Wave-3 checkpoint.
Wave 5 is **not** in scope this session (it gets its own order).

Every AC is green. The review artifacts are the two golden pure suites
(`verify-tutor-browser` drove all 11 ACs against a live server + live Luna) and
the hands-on demo (`docs/tutor/demo.md` + `npm run seed:tutor-demo`).

---

## 1. Commits (all wave-authored, on `main`)

| Commit | Package |
| --- | --- |
| `f77da6b` | W4.1 — learner store, ambient-context taps, gated persistent mount |
| `03f7259` | W4.2 — the sidebar conversation: stream client, grounded rendering, practice cards, `TUTOR_TTFT` vital |
| `4194cd5` | W4.3 — `/home` tutor entry goes real; the canned preview is deleted |
| `8cbd8d2` | W4.4 — browser AC suite, a11y remediation, demo seed + docs |

**Migration:** `supabase/migrations/20260804110000_tutor_ttft_vital.sql` —
extends the `learning_events_metric_name_check` to admit `TUTOR_TTFT`.
**Applied to the live project and verified** (`pg_get_constraintdef` returns the
six-metric list `LCP/INP/CLS/FCP/TTFB/TUTOR_TTFT`).

---

## 2. Acceptance criteria — every AC, named test, literal result

> Naming: the order's `e2e/*.spec.ts` names map to this repo's runnable
> `scripts/verify-*.ts` suites (the repo has no `e2e/` dir — same convention as
> Waves 1–3). The browser suite section ids match the AC ids verbatim.

| AC | What was proven | Test | Result |
| --- | --- | --- | --- |
| W4.0 pre-flight | migration tail + Wave-4 surfaces unchanged since `c196f15`; `/api/learn/tutor` byte-identical | read-only scan | PASS (no contradicting delta) |
| AC-W4C.1 | slide/quiz/video taps flow into the turn body; a video scrub-back emits a `content_engagement` row | `verify-tutor-browser` W4C.1 | **5/0** |
| AC-W4C.2 | gating matrix ×4: enrolled→sidebar; author preview→NO tutor DOM + zero evidence rows; disabled→no tab; anonymous→no tab | `verify-tutor-browser` W4C.2 | **5/0** |
| AC-T4.1 | converse on lesson A, navigate to B, "explain this" → the turn's citations resolve to lesson B (a live Luna turn) | `verify-tutor-browser` T4.1 | **5/0** |
| AC-T4.2 | open + scroll survive lesson→lesson navigation AND a full reload (scroll restored ±40px) | `verify-tutor-browser` T4.2 | **3/0** |
| AC-T4.3 | citation chip: same-lesson steers the deck to the cited slide; cross-lesson navigates (`?block=`), sidebar stays open | `verify-tutor-browser` T4.3 | **4/0** |
| AC-W4U.1 | practice card → `practice_answer` → `practice_result` evidence row → refold → the targeted `learner_mastery` pair moved | `verify-tutor-browser` W4U.1 | **5/0** |
| AC-W4U.2 | the `TutorBody` chunk is NOT fetched before open and IS fetched on open; warm learn route **216.0 KB** ≤ 250 (budget) / ≤ 217 (shell ceiling) | `verify-tutor-browser` W4U.2 + `verify:budgets` | **3/0** |
| AC-W4U.3 | with `TUTOR_ESCALATIONS_UI` unset, an `escalationProposal` turn renders the prose but NO consent card in the DOM | `verify-tutor-browser` W4U.3 + `verify-tutor-client` (pure gate) | **2/0** |
| AC-W4H.1 | `/home` shows the real `TutorEntryCard` + last-turn snippet, deep-links into the player with the sidebar open, zero canned markers | `verify-tutor-browser` W4H.1 + `verify-tutor-home` (grep-gone) | **4/0** |
| AC-T4.4 | axe **zero serious/critical** on all four surfaces (collapsed shell · overlay 390×844 · docked 1440×900 · /home); full keyboard walkthrough (open→converse→activate citation→Esc-close-returns-focus); touch targets ≥44px | `verify-tutor-browser` T4.4 | **10/0** |
| AC-T4.5 | 5 real-turn TTFT samples recorded; ≥1 `TUTOR_TTFT` vital landed in `learning_events` | `verify-tutor-browser` T4.5 | **2/0** |

**Browser suite total: `verify-tutor-browser` → 48 passed, 0 failed, exit 0**
(prod server on :3100, live Luna, seeded fixture).

**Pure ACs** (store slices, engagement episode detector, practice grading,
`selfReportStableKey`, TTFT thresholds, zod-free fences, flag-off gate,
client-type drift, quizActive derivation): `verify-tutor-client` **101/0**.

---

## 3. Bundle-delta table (AC-W4U.2)

| Measurement | Warm learn-route JS (gz) | Note |
| --- | --- | --- |
| Baseline (`c196f15`, pre-wave) | 211.9 KB | budget 250 |
| After W4.1 (eager shell only) | 179.6 KB* / 215.9 KB | *the ReviewSlideIn chunk no longer races the measurement window; like-for-like band is ~212–216 |
| After the full wave (`8cbd8d2`) | **216.0 KB** | budget 250 — **PASS** |
| **Eager-shell delta** | **+4.0 KB** | ≤ 5 KB — **AC-W4U.2 met** |
| `TutorBody` (the conversation) | lazy `next/dynamic` chunk | **absent before open, fetched on open** — proven in-browser |

The whole conversation UI (stream client, span rendering, practice cards,
escalation, drag) is off the eager path; only the ~4 KB edge-tab shell + store
ship in the route JS. Warm-run methodology only (the first run after a cold
build spikes on prefetch-settling and is discarded).

---

## 4. First-token latency (AC-T4.5)

`TUTOR_TTFT` — measured send→first-SSE-frame, 5 real Luna turns:

- **P50 = 9,219 ms · P95 = 9,709 ms** (target 1.5 s).

Reported **honestly, gates nothing** (alerts-not-gates, like every perf vital).
The turn is **one non-streamed structured call this wave**, so "time to first
frame" IS whole-turn latency by construction — sub-1.5s is not achievable
without token streaming, which is a deliberate future change, not a Wave-4
regression. The vital is wired end-to-end (const → schema → migration → drift
guard → client emit → `learning_events`) so the P95 is observable in
`perf_vitals_daily` from day one.

---

## 5. axe results (AC-T4.4)

Zero **serious/critical** violations on every surface scanned:

| Surface | serious/critical |
| --- | --- |
| Lesson w/ collapsed shell | 0 |
| Open sidebar — overlay (390×844) | 0 |
| Open sidebar — docked (1440×900) | 0 |
| /home entry | 0 |

Getting there required remediating **pre-existing** low-contrast text the axe
gate surfaced on the shared learn surfaces (see Deviation 1). The product was
fixed; the axe filter was NOT weakened.

---

## 6. Gating matrix evidence (AC-W4C.2)

Server-derived (`resolveTutorAccess` in the `[slug]` layout is the one truth),
client-respected — verified in-browser:

| Principal | Sidebar mounted? | Evidence rows |
| --- | --- | --- |
| enrolled learner, tutor enabled | yes | emitted |
| **author preview** | **no DOM** | **zero** (asserted against `learning_events`) |
| tutor disabled (`enabled=false`) | no | — |
| anonymous / public landing | no | — |

---

## 7. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npm run verify:tutor` (14 pure suites incl. client 101 / home 36 / runtime 64) | exit **0** |
| `verify-tutor-browser` (11 AC sections, live) | 48/0 · exit **0** |
| `npm run verify:vitals` | 65/0 · exit **0** |
| `seed:tutor-demo` (end-to-end, live DB) | exit **0** — prints the click path |
| `npm run lint` | exit **0** — the 1 pre-existing warning baseline (zero added) |
| `npx tsc --noEmit` | exit **0** |
| `npm run build` | exit **0** |
| `npm run verify:budgets` | 5/5 PASS · exit **0** (learn 216.0 · dashboard 219.1 · studio 590.0 · analytics 217.0 · marketing 308.3 KB) |
| `npm test` (full pure chain) | exit **0** |
| `npm run verify:tutor:int` (live-DB, covers the fixture changes) | 14/33/36/32/24 · exit **0** |

---

## 8. The demo path (the review artifact)

`docs/tutor/demo.md` + `npm run seed:tutor-demo` (verified exit 0). The seed
publishes the microeconomics course, shapes a learner **weak on Scarcity /
strong on Market Equilibrium**, and prints a ready-to-click block. The scripted
moment: the learner asks about **Market Equilibrium** and the tutor **interjects
the root cause** — the shaky prerequisite **Scarcity** — and points back there,
with "What should I review next?" surfacing Scarcity. That is the Wave-2 mastery
graph + the L3 learner-state layer driving Wave-4 pedagogy end to end.

---

## 9. P-3 status (store:true / chaining)

Still pending, still non-blocking, still dormant behind `TUTOR_ENABLE_CHAINING`
(default OFF). Wave 4 added no cache work and did not touch the layer contract;
the Wave-3 finding stands (the 300s-TTL smoke removed the economic argument —
chaining is a privacy/latency decision). Noted; not blocking.

---

## 10. Deviations & disclosures

The order's target was empty deviations. The following are disclosed in full;
none is a new capability/table/behavior beyond the governing documents (the
zero-surprise rule holds), and none weakened a test.

1. **a11y contrast remediation on adjacent learn surfaces (AC-T4.4-driven).**
   The axe scans run over the whole lesson page + `/home`, so they surfaced
   **pre-existing** low-contrast text outside the tutor components. Fixed as
   pure `className` swaps (`text-stone-400 → 500/600`, `brand/emerald-600 → 700`
   on colored text — the identical class of fix as the Wave-1 sidebar
   remediation) across the lesson player, course nav, completion checklist,
   quiz, slide deck, student sidebar, and the tutor bubble; `ProgressBar` gained
   an optional `label` → `aria-label` (WCAG progressbar-name). No logic touched;
   these are exactly what AC-T4.4 demands (fix the product, not the filter).
2. **Practice items carry their own answer key (Contract 5, additive).**
   `generate_practice`/`TurnPracticeItemSchema` gained
   `correctChoiceIndex`/`acceptedAnswers`/`explanation` (all `.nullable()`),
   graded CLIENT-side because practice is formative. The frozen
   `/api/learn/tutor` `practice_answer` route still takes `evidenceCorrect` from
   the client; the graded **course-quiz** answer-key invariants
   (`quiz_answer_keys`, server-only, stripped from snapshots) are untouched.
3. **`content_engagement` emits signal-only (no `blockId`).** The frozen Wave-2
   event schema defines `content_engagement` with only `signal` (the envelope
   auto-injects course/pub/lesson); the plan's `blockId` field does not exist on
   that contract, so the emission followed the source of truth.
4. **TTFT ≈ 9s, not sub-1.5s.** By construction (one non-streamed structured
   call); recorded honestly, never gated. Not a regression.
5. **Build-process note (no work lost).** The transport flaked hard this
   session — several builder agents died mid-run (Fable transport/limit, one
   Opus watchdog stall). Package B was reconstructed via write-first Opus
   micro-dispatches against frozen inter-file contracts; the W4.4 live
   verification was completed directly by the main loop after its agent hit a
   usage limit. Every file was verified on disk and every gate re-run from a
   clean state — nothing was assumed green. The a11y edits (Deviation 1) were
   independently reviewed line-by-line before commit.

---

**GATE — not a punitive HARD STOP.** All 11 ACs are green, the demo path is
verified, deviations are disclosed (all AC-driven or additive). Per the Wave-4
order, the wave now waits for **Henry to drive the sidebar himself** (start at
`docs/tutor/demo.md`) before Wave 5's order is issued. No Wave 5 work has begun.
