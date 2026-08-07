# TUTOR-1 — Amendment A3, Wave 2 Checkpoint: Evidence spine

**Date:** 2026-08-07 · **Status:** Wave 2 COMPLETE → **HARD STOP.**
The evidence spine exists end-to-end under the approved gate rulings
(R-1 conceptSlug = concept-node uuid · R-3 append-only single-writer ·
R-4 `tutor_evidence_recorded`): the 23rd event type on the one analytics
stream, the per-course misconception registry, the named repository function
every Class-A tool will call, conservative mastery folding, the `[FWD]` seam
fields, and the A3-23 creator rollup with both privacy floors. Migration
`20260807100000` reviewed line-by-line and **applied to the live project**;
schema verified in place. No tool calls it yet by design — Wave 3 ships the
invocation policy BEFORE any Class-A tool exists, so the first tool lands
into a governed surface.

## 1. In-scope acceptance criteria → proofs

| AC | Criterion | Proven by | Result |
| --- | --- | --- | --- |
| A3-21 | Every tool completion → exactly one `tutor_evidence_recorded` through the repository function; spy + conflict tests | `verify-tutor-evidence-int` (live, **78/0**): §A3-21a exactly-one + typed-columns-verbatim + replay-zero-rows; §A3-21b concurrent same-(node,slug) → ONE registry row, both calls the same misconceptionId, + the R-3 restatement — stale-version optimistic update → 0 rows (control leg passes). The "every tool completion" binding is asserted per-tool in Waves 4/5 when tools exist | **PASS (spine)** |
| A3-22 | Evidence writes not gated behind the creator approval rail | Structural: `evidenceRecord.ts` has zero toolTiers/approval imports (pure-suite source assertion) · delegating-Proxy table spy (only learning_events + tutor_misconceptions + concept_nodes touched) · live leg (row lands with zero agent_runs on the course) | **PASS** |
| A3-23 | Misconception rollup on creator analytics; raw counts below cohort 20 | The `tutor_misconception_rollup` definer RPC (floors proven live: sub-5 pair omitted, sub-5 cohort returns nothing, 5-learner pair returned with exact counts) + the console "Misconceptions" section; the <20 rule lives ONLY in `misconceptionCountDisplay` (boundary-tested at 19/20; structural check: the tab never inlines the comparison) | **PASS** |

## 2. What was built

- **Migration `20260807100000_tutor_evidence_recorded.sql`** (applied live via
  MCP after line-by-line review; rollback = standard drop set, table/fn are
  additive): event-type CHECK 22→23 · eight typed nullable columns
  (`tool_name, outcome, misconception_slug, confidence, fade_level,
  initiation, item_source, reviewed_item_id`) · THREE isolation constraints
  (old-evidence arm, new bidirectional tool-evidence CHECK, and the
  re-created `tutor_call_check` freeing the pre-existing `latency_ms` for the
  new type — it was pinned to model-call rows and would have refused inserts)
  · envelope arm (publication+version required, lesson optional) · the refold
  read index gains the type · `tutor_misconceptions` registry (UNIQUE
  (course, node, slug), versioned, author-SELECT-only RLS, service-role sole
  writer) · the double-floored rollup RPC. The client ingest RPC and the R-9
  author-select exclusion needed ZERO changes — `tutor_%` pattern guards
  already cover the new type (browser-forged rows refused; per-row evidence
  invisible to creators; the floored RPC is the only creator read surface).
- **`lib/tutor/runtime/evidenceRecord.ts`** — `recordToolEvidence`, THE
  single writer (R-3): validate → resolve the concept node (merge chains walk
  to the survivor, cycle-safe; retired/unknown → drop-and-flag
  `tutor_evidence_dropped`, never a throw) → normalize + get-or-create the
  misconception (race-safe on-conflict-ignore + re-select; an unusable slug
  or registry failure degrades to a null link — evidence outranks label) →
  append with deterministic id `toolev:{completionKey}` (replay = no-op).
  Refold scheduling deliberately stays with the caller (the service.ts
  endpoint pattern) — Wave 4/5 call sites fire it.
- **`lib/analytics/events.ts`** — union 22→23; `reviewedItemId` pinned
  `z.null()` (`[FWD]` — a non-null value fails parse until the reviewed-item
  bank exists); mapEventToColumns branch; server-event set 4→5; the client
  batch schema still excludes every tutor type.
- **Mastery folding (conservative v1)** — `toolEvidenceWeight`: demonstrated
  +1.0 / partial +0.5 / not_demonstrated −1.0 at practice_answer magnitudes;
  confidence/misconception deliberately non-modulating (`[FWD]`); loader +
  normalizer extended; 4 new drift pins in `verify-tutor-mastery`.
- **Console (A3-23)** — the "Misconceptions" card on the tutor console's
  Analytics tab (third RPC in the existing parallel load; per-concept groups;
  humanized label + raw-slug mono chip; `misconceptionCountDisplay` owns the
  <20-raw-counts rule; calm empty state naming both floors).
- **`lib/database.types.ts`** hand-SPLICED (never regenerated — live-DB
  branch drift).

## 3. Files

**Created:** `supabase/migrations/20260807100000_tutor_evidence_recorded.sql`
· `lib/tutor/runtime/evidenceRecord.ts` · `lib/analytics/misconceptions.ts` ·
this checkpoint.
**Modified:** `lib/analytics/events.ts` ·
`lib/tutor/mastery/{weights,evidence,loader}.ts` · `lib/database.types.ts` ·
`components/studio/tutor/AnalyticsTutorTab.tsx` · `docs/tutor/analytics.md` ·
`scripts/verify-tutor-evidence.ts` (70→145) ·
`scripts/verify-tutor-evidence-int.ts` (+the A3 phase → 78 live checks) ·
`scripts/verify-tutor-analytics-console.ts` (31→56) ·
`scripts/verify-tutor-stream-infra.ts` (23-member lock) ·
`scripts/verify-tutor-mastery.ts` (77→81).
**package.json: zero changes** — both evidence suites pre-existed in the
chains (the builders extended them rather than creating unwired files).

## 4. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| Migration applied to the live project (MCP) + schema verified | registry ✓ · RPC ✓ · 8 columns ✓ · 23rd type in CHECK ✓ |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0**, zero warnings |
| `npm test` (full pure chain, incl. the 23-member union lock) | exit **0**, zero failures |
| `verify-tutor-evidence-int` (live, post-migration) | **78 passed, 0 failed**, exit 0 |
| `npm run verify:tutor:int` (full 16-suite chain — the recreated constraints regress-checked) | exit **0**, every suite 0 failed |

## 5. Deviations

1. **`latency_ms` freed, not added** — the frozen contract listed it as a new
   column; it already existed, pinned to model-call rows by a CHECK that
   would have refused tool-evidence inserts. The migration re-creates that
   constraint with the new arm instead. Contract intent preserved exactly.
2. **Both suite files already existed** (the original TUTOR-1 evidence
   pure/int suites) — extended in place, keeping their npm wiring; nothing
   clobbered, the pre-existing halves still green.
3. **`recordToolEvidence` does not itself fire the mastery refold** — the
   frozen behavior list was exhaustive and refold scheduling follows the
   established endpoint pattern (callers fire it). Wave 4/5 call sites own
   it; documented in the module header.
4. **Degraded-label path**: an unusable misconception slug (normalizes to
   nothing) or a registry write failure records the evidence with a null
   misconception link (logged) rather than dropping the observation —
   evidence outranks label.

## 6. Risk changes for later waves

- Wave 3's downgrade telemetry (`tutor.tool.downgraded`) is WIRE/log-only per
  the same §8-style discipline unless a persisted counter is justified — if
  persisted, it repeats this wave's one-commit recipe (union, CHECK, lock).
- Waves 4/5 bind A3-21's "every tool completion" per tool: each Class-A tool
  calls `recordToolEvidence` with a stable completionKey and then fires the
  refold (the caller-owns-refold decision above).
- The rollup's v1 learner_count semantic (ever-held, no latest-wins) is
  documented in the RPC comment; revisit only with real data (§9's
  find-the-error tool depends on this registry maturing).

---

**Awaiting approval to proceed to Wave 3 (invocation policy: `TurnInitiation`
provenance, the conservative `practice_request` classifier, the
downgrade-to-invitation path, invitation rendering + two-ignore cooldown +
discard-on-other-message, escape-hatch attempt gating — shipped BEFORE any
Class-A tool exists).**
