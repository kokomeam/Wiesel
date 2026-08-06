# TUTOR-1 — Completion Report

**Date:** 2026-08-06 · **Status:** COMPLETE across all six waves. This is the
single artifact proving the Directive was executed in full: the consolidated
acceptance ledger, the project-wide privacy proof, the cost economics for the
SKU decision, and the open-items ledger. Per-wave detail lives in
`TUTOR-1-wave{1..6}-checkpoint.md`; subsystem docs in `docs/tutor/*.md`.

## What TUTOR-1 is

A course-grounded AI tutor for WiseSel, built as a closed loop: it learns each
course's **concept graph** (W1), tracks each learner's **mastery** (W2), tutors
them live with a **scaffolded, grounded runtime** (W3) in a **learner sidebar**
(W4), gives creators a **console** to enable/configure/analyze it (W5), and
**escalates** what it can't answer to the creator, whose reply can flow back into
the course content (W6). Every learner-facing number a creator sees is
cohort-floored; no individual learner's identity, conversation, or mastery is
ever reachable by a creator.

## 1. Consolidated acceptance ledger (Waves 1–6)

Every wave shipped at a HARD STOP with all ACs green. Final pure+int suite
status by wave (each suite exit 0):

| Wave | Scope | ACs | Suites (final) |
| --- | --- | --- | --- |
| **W1** | Concept graph — extraction, review rail, reconciliation, the DAG cycle gate | T1.1–T1.8 (DAG, dedup, evidence, priors, snapshot map; merge/split lineage; locked edges) | `verify-tutor-graph` 70 · `-extraction` 86 · `-reconcile` 64 · `-rail`; int: graph 14 · extraction 33 · reconcile 36 |
| **W2** | BKT mastery — evidence contract, atomic quiz detail, refold engine, strict-regime RLS, review queue | T2.x (evidence-weighted mastery, decay, refold, cohort floor, root cause) | `verify-tutor-evidence` 70 · `-mastery` 77 · `-queries` 46; int: evidence 32 · mastery 47 |
| **W3** | Tutor runtime — layered prompt, 5-tool loop, scaffolding, grounding, session behaviors, assessment integrity | T3.1–T3.8, W3S.1, W3R.1–3, T5.2-schema | `verify-tutor-runtime` 64 · `-session` 57 · `-client` 101 · `-threads` 95 · `-concurrency-pools` 37; int: threads 24 · route 30 · mastery 47 |
| **W4** | Learner sidebar — gated persistent mount, ambient taps, stream client, practice, TUTOR_TTFT vital, /home entry | W4C.1–2, T4.1–5, W4U.1–3, W4H.1 | `verify-tutor-client` 101 · `-home` 36; browser 48; budgets (learn 216 KB) |
| **W5** | Creator console — enablement, charter, concept-graph editor, analytics, most-missed, bad-lesson | T5.1–6, W5O.1, W5G.1–2, A1.3–5, W6-parity | `verify-tutor-console` 25 · `-graph-console` 24 · `-graph-ui` 92 · `-analytics-console` 30; int: console 21 · graph 25 · analytics 26; browser 51 (axe 0×4) |
| **W6** | Escalation loop — consent, dossier/clustering, queue/reply, promotion, digest | T6.1–4, W6C.1, W6D.1, W6Q.1, W6P.1, W6E.1–2 | escalation 46 · cluster 27 · queue 33 · promotion 50 · digest 32; int: escalation 18 · cluster 35 · queue 23 · promotion 31 · digest 23; comms 73; browser consent 14 + queue 14 (axe 0) |

**Final whole-project gates (2026-08-06):** `npm test` exit **0** ·
`verify:tutor:int` (13 suites) exit **0** · `tsc` **0** · `lint` **0** (1
pre-existing baseline warning) · `build` **0** · `verify:budgets` **6/6**
(`/studio/[courseId]/tutor` 234.8 KB, `/learn/[slug]/[lessonId]` 216.3 KB — the
learner route never regressed across the whole project).

## 2. Privacy proof (final, project-wide)

**The invariant:** every creator-facing number comes from an author-gated,
cohort-floored (≥5 distinct learners, `TUTOR_MASTERY_MIN_COHORT`) SECURITY
DEFINER RPC (`revoke public,anon` + `grant authenticated`); the raw
identity-bearing tables keep ZERO author policies. Individual learner identity,
conversation, mastery, and per-question detail are unreachable by any creator
principal — proven as RLS-matrix rows, not code paths.

**Creator-reachable definer RPCs** (all author-gated, verified live):

| RPC | Floor | Notes |
| --- | --- | --- |
| `tutor_console_bundle` | usage ≥5 (suppressed) | overview/charter; cost = author's own spend |
| `tutor_graph_console` | mastery + confusion overlays ≥5 | nodes/edges author-owned; clarifications by accepted change-set |
| `most_missed_questions` | question omitted <5 learners | first/second-attempt + distractors derived in SQL, no learner rows |
| `lesson_health` | per-lesson inputs floored | ranked composite read |
| `tutor_escalation_queue` | count is an aggregate (any N) | clusters — count + representative question, **never a user_id** |
| `concept_mastery_aggregate` · `my_review_queue` · `course_analytics_overview/roster/bundle` | ≥5 / own-only | Waves 2–5 |

**Service-role-only writers (no creator/learner path):**
`tutor_merge_concept_nodes`, `recompute_lesson_health_admin`,
`apply_escalation_reply`, `apply_comms_delivery`, `ingest_learning_events`,
`record_quiz_attempt`, `publish_course`.

**Zero-policy / own-only identity tables** (a creator reads NONE):
`learner_mastery` (own-select only), `quiz_attempt_detail` (zero policies),
`tutor_turns` (own), `mastery_review_queue`, `mastery_course_aggregate`,
`tutor_escalation_candidates` (own; consent invariant), **`escalation_dossier`**
(zero policies — the escalation roster), **`escalation_reply_delivery`** (zero
policies), `learning_events` tutor_% rows (course-author-only, R-9).

**The escalation consent boundary** is the project's tightest: a `consent_pending`
or `withdrawn` escalation is unreachable by any creator; consent is the only
transition into creator scope, and it exposes only the identity-free cluster
(count + representative question). Terra never sees learner identity in any
dossier/rationale/FAQ prompt. The creator digest is aggregate-only and never
sends without `provider_mode='resend'` + a successful send.

## 3. Economics — cost per 1,000 active learners (for the SKU decision)

**Model pricing** (`lib/ai/modelConfig.ts`, per MTok): gpt-5.6-terra $1.25 in /
$0.125 cached / $10 out; gpt-5.6-luna $0.25 / $0.025 / $2; text-embedding-3-small
$0.02 in. All figures are measured or measured-derived; **assumptions are
stated** — this is an input to pricing, not a guarantee.

**Per-unit measured costs:**
- **Tutor turn** (luna): ~2,600 input tokens (≈72% cached from turn 2 via the L0
  prompt cache — measured in the W3 smoke) + ~330 output → **≈$0.0004–0.0013 per
  turn** (cached vs cold). Use **$0.001/turn** as a blended estimate.
- **Graph extraction** (terra, one-time per course): measured ≈**$0.10 per
  course** (36 nodes / $0.0988, live Terra).
- **Nightly per course** (mastery refold + lesson-health composite is SQL;
  lesson-rationale + dossier are Terra, top-N only): **≈$0.01–0.05 per course-day**.
- **Escalation dossier** (terra, per consented escalation): ~200 input + 60
  output → **≈$0.0009 each**; embeddings negligible.

**Projection — 1,000 active learners, one 20-lesson course, one month:**

| Component | Assumption | Monthly cost |
| --- | --- | --- |
| Tutor turns | 20 turns/learner/mo × 1,000 × $0.001 | **$20** |
| Graph extraction | 1 course, amortized (one-time) | ~$0.10 |
| Nightly (mastery/health/rationale) | 30 days × ~$0.03 | ~$0.90 |
| Escalations | ~2% of learners escalate, ~20 dossiers × $0.001 | ~$0.02 |
| Embeddings | turns + escalations | ~$0.20 |
| **Total** | | **≈$21–25 / 1,000 active learners / month** |

**Sensitivity:** the dominant term is tutor turns; cost scales ~linearly with
turns/learner. At 50 turns/learner/mo the total is ≈$50–55/1,000. The prompt
cache (L0) is the single biggest lever — losing it would roughly triple the
per-turn input cost. **Implication for the SKU:** even at heavy usage the
model cost is well under $0.10/active-learner/month, so the tutor is comfortably
affordable inside the existing Pro ($29) / Expert ($79) tiers; a per-seat or
usage-metered add-on is optional, not required, to be margin-positive.

## 4. Open-items ledger

**P-3 (prompt chaining)** — pending, non-blocking. The seam is built and dormant
behind `TUTOR_ENABLE_CHAINING` (default off). The 5-min-TTL cache smoke removed
the economic argument (the L0 cache survives at cadence), so chaining is a
privacy/latency decision only. What exists: the `collapseToChaining` L4 seam +
`store:false` foreground turns. What's needed to ship: a decision on provider-side
thread retention + a live latency A/B.

**`[FWD]` seams reserved but unbuilt** (each has its hook; none is stubbed):
- *Item bank + spaced repetition* — `practiceItemRef` / `itemBankRef` fields
  reserved on practice items; needs a persistent bank table + a scheduler.
- *Budget enforcement* — `tutor_course_settings.budget_limit_usd` column exists +
  every call is cost-metered; needs a pre-call budget gate + a soft-stop UX.
- *Application activities / certificate lockout / Stripe SKU* — product surfaces
  outside TUTOR-1's scope; the mastery + completion data they'd read is live.

**PERF-2 (studio bundle decomposition)** — the `/studio` editor route is 590 KB
(its own renegotiated budget); a decomposition pass over the recorder/clips
chunks is the flagged candidate. The tutor console + learner sidebar are NOT
affected (own budgets, editor-store-fenced).

**Operational** — the vault log append is OS-blocked (TCC) throughout; the record
lives in the checkpoints + agent memory. Migrations are applied via the Supabase
MCP, so live migration-history version numbers don't match repo filenames (the
project's established pattern); each repo migration file is the canonical
fresh-apply artifact.

---

**TUTOR-1 is complete.** Six waves, each gated and reviewed; every acceptance
criterion green; the privacy and no-auto-send invariants enforced at the schema.
Nothing beyond TUTOR-1's scope begins without a new directive.
