# TUTOR-1 — Amendment A3 (Interactive pedagogy tools): completion ledger

**Closed:** 2026-08-10. Six waves, each milestone-gated and approved.
Commits: `60d1126` (W0 audit) → `6322ca7` (W1 defect repair) → `04c43dc`
(W2 evidence spine) → `7459aaa` (W3 invocation policy) → `cdc591a` (W4 core
tools) → `4df2c8b` (W5 adaptive tools) → this wave (W6 tests + docs).

This is the amendment's completion record: every §8 acceptance criterion mapped
to the assertion that proves it and the wave that shipped it. Verified by a
skeptical read-only audit (a checkpoint claim is not proof — the assertion in
the file is). **25 / 25 proven.**

## The §1 diagnosis — all six defects repaired (Wave 1)

| Defect | Fix |
| --- | --- |
| D-1 markdown renders literally | `components/ui/Markdown.tsx` rendered per span + streaming bubble |
| D-2 "RUNG 2 · NUDGE" leaked | badge deleted (labels were also inverted); rung stays internal |
| D-3 duplicate "Show me" chips | citations deduped by jump target at validation (the downgrade path manufactured them) |
| D-4 unconditional escape hatch | gated `rung < 4 && hasAttempted` |
| D-5 malformed ASCII diagrams | L0 ban + the `renderStructure` visual channel (W4) |
| D-6 "hello" answered the prior question | the grounding ok-rule matched to its contract (a greeting is not a claim) + delimited replay + newest-tail history |

## The §8 acceptance criteria — 25 / 25

| AC | Proven by (file · assertion) | Level | Wave |
| --- | --- | --- | --- |
| A3-1 | `verify-tutor-client` · `parseMarkdownBlocks` all-four fixture + span-boundary splits | unit | 1 |
| A3-2 | `verify-tutor-client` · no `RungBadge`/`"Rung "` in TutorBody source | structural | 1 |
| A3-3 | `verify-tutor-runtime` (server dedup) + `verify-tutor-client` (`dedupeCitations`) | unit ×2 | 1 |
| A3-4 | `verify-tutor-client` (`hasAttemptedFor`+`shouldOfferEscapeHatch`) + **`verify:tutor:browser:cards`** hidden→shown flip over the real store | unit + browser | 1 + 6 |
| A3-5 | `verify-tutor-client` · rung 4 / null → no hatch | unit | 1 |
| A3-6 | `verify-tutor-runtime` · `applyInvocationPolicy` PROPERTY over **120** turns | unit (property) | 3 |
| A3-7 | `verify-tutor-runtime` (pure + loop) + `verify-tutor-route-int` (a) — downgraded not blocked, `tutor_tool_downgraded` logged | unit + int | 3 |
| A3-8 | `verify-tutor-runtime` (regex matrix + Path 1 intact) + `verify-tutor-route-int` (c) | unit + int | 3 |
| A3-9 | `verify-tutor-runtime` (property: never with items) + `verify-tutor-client` (belt) | unit | 3 |
| A3-10 | `verify-tutor-runtime` (`deriveInvitationState`/`effectiveCooldown`) + `verify-tutor-route-int` (d) | unit + int | 3 |
| A3-11 | `verify-tutor-runtime` (immediately-prior validation) + `verify-tutor-client` (final-turn only) + route-int (e) | unit + int | 3 |
| A3-12 | `verify-tutor-runtime` (loop: executes on a question turn) + route-int (g) | unit + int | 4 |
| A3-13 | `verify-tutor-runtime` · the `superRefine` REJECTS a distractor missing its misconceptionId | unit (schema) | 4 |
| A3-14 | `verify-tutor-client` (`scoreCheckUnderstanding` returns the picked distractor's feedback) + **`verify:tutor:browser:cards`** (the feedback string renders) | unit + browser | 4 + 6 |
| A3-15 | `verify-tutor-runtime` + `verify-tutor-client` — both scorers, reconciled to the relative-order metric, pin the middle-transposition input | unit ×2 | 4 |
| A3-16 | `verify-tutor-runtime` (`fadeLevelForMastery`/`blankStepsForFade` + stubbed exec) + `verify-tutor-route-int` (h) live-seeded 0.9 → fadeLevel 3 | unit + int | 5 |
| A3-17 | `verify-tutor-client` (`explainBackCriteriaView` verdict-free) + `verify-tutor-route-int` (i) presence→outcome, no verdict | unit + int | 5 |
| A3-18 | `verify-tutor-runtime` — 3 pure + 3 loop-level: a failed delivery re-offers the invitation; a clean delivery does not; no partial widget. `verify:tutor:browser:cards` — malformed → graceful `role="note"` fallback, no SVG/controls | unit + browser | 6 |
| A3-19 | `verify-tutor-runtime` · a Class-A tool is not executed on an intercepted question turn (no card + downgrade log) | unit (structural) | 3/5 |
| A3-20 | `verify-tutor-route-int` (i) pooled grade call + `verify-tutor-runtime` structural (grade action uses `withPooledModel`) | int + structural | 5 + 6 |
| A3-21 | `verify-tutor-evidence-int` — exactly-one + replay-zero + concurrent-registry + stale-version conflict; route-int (f)/(i) per-tool binding | int | 2 + 4/5 |
| A3-22 | `verify-tutor-evidence` (no toolTiers/approval import) + `verify-tutor-evidence-int` (table-spy: only 3 tables, zero agent_runs) | unit + int | 2 |
| A3-23 | `verify-tutor-analytics-console` (`misconceptionCountDisplay` 19/20 boundary) + `verify-tutor-evidence-int` (RPC floors) | unit + int | 2 |
| A3-24 | `verify-tutor-runtime` (L0 ASCII ban routes to renderStructure) + drop-and-flag on a malformed spec | unit | 1/4 |
| A3-25 | **`verify:tutor:browser:cards`** — axe **0 violations any-impact** + radiogroup/roving-tabindex/labelled-inputs/move-buttons + keyboard end-to-end; `verify-tutor-client` structural backstop | browser + structural | 6 |

## The rulings (R-1..R-6, decided at the Wave-0 gate)

| # | Decided |
| --- | --- |
| R-1 | `conceptSlug` = the concept node's uuid (concepts have no slug); misconception ids are model-proposed human-readable slugs |
| R-2 | `store:true` scoped to the tutor_turn foreground call (the chaining seam is live; chaining itself stays off) |
| R-3 | evidence writes through the append-only `recordToolEvidence` (no versioned UPDATE on an append-only stream) |
| R-4 | the event is `tutor_evidence_recorded` (snake_case) |
| R-5 | A3-20 asserts the pool-decorator invariant, not a literal count (the tutor rides the learner pool) |
| R-6 | A3's 1–4 rung table maps onto the existing 0–4 ladder, extended in place |

## Deliberately deferred ([FWD], out of A3 scope by §9)

Item bank + creator review (`reviewedItemId`/`itemSource:"reviewed"` seams land
now, unused) · spaced review across sessions (Inngest) · contrasting-case tool ·
find-the-error tool (needs a populated misconception registry) · the
model-classifier fallback for `practice_request` · a categorical-timeline
renderer.

## Standing invariants (structural, not just tested)

- Every assessment is a mastery observation (`tutor_evidence_recorded`, the one
  append-only writer, deterministic completionKey).
- Every distractor carries a named misconception (A3-13 is a schema rejection).
- The tutor invites, it does not impose (the pre-execution downgrade intercept;
  a delivery that produces nothing re-offers rather than imposes or goes silent).
- Tool params are top-level objects (the runtime guard; the live-only OpenAI
  400 the mock can't see).
- The learn route stays byte-identical (all six cards + the diagram surface ride
  the lazy TutorBody chunk; 216.3 KB).

**A3 is closed.** Nothing beyond its scope begins without a new directive.
