# TUTOR-1 — Wave 1 Checkpoint Report

Date: 2026-08-03 · Tree: `main` (commits `ec8e68f` → this one, pushed) ·
**HARD STOP — no Wave 2 work of any kind before Henry's explicit approval.**

Governing docs applied: the Wave 1 Execution Order (binding text — the
Amendment/Directive files are not in the repo; the order restates every
operative resolution, recorded in the delta note §5). References:
`TUTOR-1-w1-delta-note.md` (W1.0) · `docs/tutor/concept-graph.md` +
`docs/tutor/architecture.md` (shipped docs) · `TUTOR-1-task0-audit.md`.

## 0. W1.0 delta note + the D-1 branch taken

**`TUTOR-1-w1-delta-note.md` — D-1 Branch A (Inngest), verified not presumed.**
Inngest 4.13 is fully wired by the social workstream (client `wisesel`, serve
route, sleepUntil/cancelOn/sweep conventions); TUTOR-1 extends those exact
conventions. Branch B is dead.

**P-1 correction (§0 recorded-fact vs. reality):** on arrival the tree was NOT
reconciled — the learner-platform line (16 migrations, CI, the Task 0 audit)
was uncommitted while origin/main carried the worktree's social/clips/UI-1
line. Completed as a W1.0 pre-step: committed (`ec8e68f`), merged (`20b44b4`,
15 conflicts resolved as semantic unions), integration-fixed (`d2ea512` —
full verify chain + tsc + build green), pushed. Live DB = the union (56
migrations) — tree == DB before any TUTOR-1 timestamp froze.

## 1. Acceptance criteria — every AC, its test, its status

| AC | What it demands | Test (file · checks) | Status |
| --- | --- | --- | --- |
| AC-T1.1 | DAG cycle rejection, typed error | `verify-tutor-graph-int.ts` (in the 14) — A→B→C then C→A prerequisite REFUSED with the typed error; C→A `related` allowed (per-kind DAGs) | **PASS** (live) |
| AC-T1.2 | Graph-table RLS matrix | `verify-tutor-graph-int.ts` — author full CRUD; stranger reads zero from every table; stranger edge INSERT refused (no policy); RPC author-gate refusal | **PASS** (live) |
| AC-T1.3 | Fixture pipeline: valid DAG, zero same-name dupes, evidence on 100% of prerequisite edges, assumed-priors produced | `verify-tutor-extraction-int.ts` (33) + live smoke | **PASS** (live+mock; live smoke real-Terra) |
| AC-T1.4 | Node density in band or explicitly flagged | `verify-tutor-extraction.ts` (grain goldens) + `verify-tutor-extraction-int.ts`; live smoke: 36 nodes / 12 lessons, zero grain flags | **PASS** |
| AC-T1.5 | ONE change-set; accept activates (fate → accepted); reject leaves no active graph (fate → dismissed) | `verify-tutor-extraction-int.ts` — one pending set covering EVERY row; reject → all rows gone + finding dismissed; re-run → accept → rows remain + finding accepted | **PASS** (live) |
| AC-T1.6 | Publish w/o graph → extraction; with graph → reconciliation; no-op republish → nothing | `verify-tutor-reconcile-int.ts` (36) — the three `enqueueGraphRunForPublish` decisions; the identical-hash path returns BEFORE the hook by construction (service.ts early return) | **PASS** (live) |
| AC-T1.7a | Republish w/ one rewritten lesson: untouched node IDs stable; diff classified + staged; split/merge lineage sufficient for Wave 2 (parent→children + configured confidence factor) | `verify-tutor-reconcile-int.ts` — untouched ids identical; split parent retired-not-deleted with lineage `{parent→children, 0.75}` readable from BOTH item payloads and accepted rows | **PASS** (live). AC-T1.7b is Wave 2 per the binding sequencing amendment |
| AC-T1.8 | creator_locked edge survives a reconciliation that would remove it | `verify-tutor-reconcile-int.ts` — locked edge produced NO item, exists after accept | **PASS** (live) |
| AC-W1F.1 | Registry + deny-list + literal-grep guard | `verify-tutor-models.ts` (48) | **PASS** |
| AC-W1F.2 | computeCostUsd hand-computed goldens incl. cached discounting | `verify-tutor-models.ts` + `verify-tutor-telemetry.ts` (36) | **PASS** |
| AC-W1F.3 | Cost events reconcile ≤1% to provider usage (AC-T0.3); per-course rollup by job_type (AC-T0.4); author reads zero tutor rows | Live smoke + `tutor_model_costs_daily` query: view **$0.09882914** vs run **$0.09882914 — EXACT**; rollup returns spend by job_type; R-9 author-reads-zero asserted live in `verify-tutor-extraction-int.ts` | **PASS** (live) |
| AC-W1M.1 | Versioned write 409 → re-read/re-apply; ledger revert byte-for-byte; fail-closed past window | `verify-tutor-graph-int.ts` | **PASS** (live) |
| AC-W1M.2 | Concept-graph reject restores exactly, never touches the course doc; mixed-domain reverts both | Pure: `verify-tutor-rail.ts` (45). Int: `verify-tutor-extraction-int.ts` — course doc BYTE-IDENTICAL after a graph-only reject; `verify-tutor-reconcile-int.ts` — prior graph restored byte-for-byte (see deviation D3) | **PASS** |

## 2. Migrations (timestamps frozen per the delta note; ALL applied live + verified)

| File | Contents |
| --- | --- |
| `20260803100000_tutor_model_call_events.sql` | tutor_model_call event type + 8 typed columns + two-sided check + envelope + R-9 select-policy exclusion + ingest tutor_% reject + `tutor_model_costs_daily` |
| `20260803100100_concept_graph.sql` | six tables + RLS + `tutor_upsert_concept_edge` (cycle gate; hardened in review — see §5) |
| `20260803100200_concept_graph_rail.sql` | change_set_items node_type +'concept_graph' + identity constraint + `studio_course_bundle` re-created (verbatim-plus-one-filter, diff-verified) |

## 3. Live-smoke results

- **`npm run smoke:tutor`** (models): `gpt-5.6-terra` structured call at
  `medium` effort — 2.8s, usage 58/0/53, **$0.0006025** computed, real
  `resp_…` responseId (the chaining seam works live);
  `text-embedding-3-small` → 2×1536 dims, $0.00000012. Effort vocabulary
  accepted as configured.
- **`scripts/smoke-tutor-extraction.ts`** (REAL Terra over the 12-lesson
  Microeconomics fixture): **36 nodes · 38 edges** (40 pre-transitive-
  reduction; 2 removed) · 0 assumed priors (the fixture course teaches
  everything it uses; the prior path is proven by the int suite) · zero
  flags (mean 3.0 concepts/lesson — in the 1–4 band) · 124s wall ·
  **$0.09882914** total (13 Terra calls: 12 proposals + 1 edge inference —
  zero merge adjudications because real embeddings found no cross-lesson
  near-dupes above 0.85 — + 1 embedding batch of 36) · ONE change-set +
  proposed fate row staged. **The cost-event rollup reconciles the run
  total EXACTLY** (AC-T0.3 at extraction scope).

## 4. Fixture extraction quality summary

12 lessons → 36 concepts (3.0/lesson mean, all lessons in band, no
`grain_*` flags) · 40 inferred edges hardened to 38 (transitive reduction
−2; zero evidenceless, zero low-confidence, zero cycle-breaks — the model's
edge proposals were already evidence-carrying and acyclic on this fixture) ·
alias maps persisted · all anchors resolved at slide-or-block level (no
downgrades on v1 — the R-13 downgrade path is int-tested with engineered
anchors instead).

## 5. Deviations from the order (with rationale)

1. **Test-file naming**: the order names `*.test.ts` files; the repo has no
   test-runner dependency (deps stay at their frozen count) — every AC maps
   to a `scripts/verify-tutor-*.ts` tsx suite per house convention (the AC
   table above is the mapping).
2. **Studio pending-nodes surface**: `studioLoad` PARSES the widened
   node_type but filters concept_graph items off the outline sidebar (a
   course-document surface); the Wave-5 Tutor console is their home. The
   bundle RPC + schema emit them; no UI regression.
3. **Byte-for-byte reject** excludes `updated_at` on restored rows: the
   moddatetime trigger unavoidably re-stamps it on the restore-upsert
   (verified the ONLY diverging field; matches existing entity-restore
   behavior repo-wide).
4. **Security hardening added during my review** (beyond the order):
   the edge RPC's revoke now covers PUBLIC (functions default-grant to
   PUBLIC; revoking only `anon` would have left the null-uid service-role
   arm reachable), and a `pg_advisory_xact_lock(course:kind)` closes the
   concurrent-writer cycle TOCTOU.
5. **Bugs surfaced by execution, fixed in-wave**: assumed-priors were
   double-persisted as taught nodes; proposal/merge/edge cost ids used the
   retry-UNSTABLE provider responseId (an Inngest retry would double-count) —
   all runId-scoped now; the Inngest functions originally never minted the
   `agent_runs` row the fate finding's FK requires (the int suites masked it
   by minting their own) — both functions now upsert + settle their run row;
   the extraction smoke initially exited 0 on failure through a shell pipe
   (the third occurrence of the `| tail` exit-masking trap this session) and
   lacked the bare-tsx snapshot-loader seam — both fixed.
6. **Pricing**: terra/luna rates are PLACEHOLDERS pending the provider price
   sheet (`TUTOR_PRICING_JSON` overrides; unknown models emit null-cost rows
   rather than fabricated numbers).
7. **`agent_runs.trigger`**: graph runs use `'scheduled'` (the CHECK's
   closed vocabulary: chat|scheduled|threshold); `report.kind`
   distinguishes `graph_extraction`/`graph_reconciliation`. Widening the
   CHECK was not worth migration churn in Wave 1.
8. **P-1**: performed in-wave (it was recorded complete but was not) — §0.

## 6. Verification totals

- Pure: `verify:tutor` **300** (48+36+70+83+63) + `verify-tutor-rail` **45**
  (chained into `verify:reject`) — both in the `npm test` chain.
- Int (live Supabase): `verify:tutor:int` **83** (14+33+36);
  `verify:course-agent` 78 and `verify:publish:int` 50 re-run green after
  the rail/hook changes.
- Whole-repo `npm test` chain: green end-to-end (exit-code-verified, not
  pipe-masked); `tsc --noEmit` clean; `next build` green; lint at the
  pre-wave baseline (1 pre-existing warning in a social e2e script).

## 7. What Wave 1 hands Henry to review

The staged fixture graph is the first real Accept/Reject pass on a
concept-graph change-set: course `9d27d3ba-e8bc-4e02-bce0-f198444b2175`
("Foundations of Microeconomics", unlisted) carries change-set
`97a0b14c-bea8-4b91-8c96-7cd1a6db3d56` (36 nodes · 38 edges), fate finding
`ee3d0b7d-63f7-47b6-bea7-26a237a48626` in `proposed`. Accept activates the
graph; Reject deletes every staged row and provably leaves the course doc
untouched.

**HARD STOP.** Wave 2 (BKT mastery) begins only on explicit approval.
