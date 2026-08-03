# TUTOR-1 — The Concept Graph (Wave 1)

> The course's knowledge model: a per-kind DAG of concepts extracted from the
> PUBLISHED snapshot, reviewed by the creator through the existing
> Accept/Reject rail, and projected per publication for the learner runtime
> (Waves 2+). Companion: `docs/tutor/architecture.md` (scheduler, models,
> cost telemetry, prohibitions).

## Data model (migration `20260803100100`)

| Table | Role | Key invariants |
| --- | --- | --- |
| `concept_nodes` | One concept | stable UUID; `status` active·retired·`merged_into` (CHECK-tied to `merged_into_node_id` — a merge always names its survivor); `created_by` provenance (extraction/reconciliation/creator); `creator_edited` protects human edits from automated passes; `version` int (optimistic writes); `aliases`/`anchors` jsonb; `embedding` jsonb (pgvector-shaped, in-process cosine for now); `external_taxonomy_ref` [FWD] |
| `concept_edges` | Typed directed edge | kind ∈ prerequisite·part_of·related; unique (source,target,kind); no self-loops; `evidence_refs` (required by pipeline policy — see below); `creator_locked` shields an edge from reconciliation; `version` int |
| `snapshot_concept_map` | Published projection | PK (publication_id, node_id); carries the (course_id, publication_id, version) triple so republishes never mix (the analytics-rollup convention); snapshot-RESOLVED `anchors` + `anchor_downgraded` (R-13) |
| `assumed_prior_nodes` | Used-but-never-taught concepts | unique (course_id, title) → re-extraction idempotent per title; dismissable |
| `tutor_course_settings` | Per-course config | `enabled` default false; `budget_limit_usd` [FWD] |
| `tutor_action` | Reversibility ledger | `marketing_action`'s shape; reversible rows carry `before_snapshot` + `revert_expires_at` (default 24h, `TUTOR_REVERT_WINDOW_HOURS`); revert restores byte-for-byte via the entity registry and FAILS CLOSED past the window |

**RLS regime**: creator-owned (the legacy author regime) via the per-statement
semi-join idiom; learners get NO direct access — their runtime reads arrive in
later waves through snapshot-scoped definer functions over
`snapshot_concept_map`. `concept_edges` is the deliberate exception: author
SELECT + DELETE only — see the DAG invariant.

## ID stability & anchors

- Node ids are stable UUIDs, preserved across reconciliations: a `matched`
  candidate keeps the existing id; `removed` retires (never deletes); `split`
  / `merged` record full lineage (`merged_into_node_id`, item payloads) so
  Wave 2's mastery redistribution can map parent→children.
- **Anchors** are `{lessonId, blockId, slideId?}` (R-13) — lesson/block ids
  ARE the draft row ids preserved verbatim in snapshots (the M1 invariant),
  so anchors stay joinable across versions. Slide ids are stable-but-not-row
  ids: when a slide anchor cannot be re-resolved against a new snapshot it is
  DOWNGRADED to block level and flagged (`snapshot_concept_map.
  anchor_downgraded`) rather than dropped or guessed.

## The DAG invariant — enforced at the write path

Every edge write goes through ONE SECURITY DEFINER RPC,
`tutor_upsert_concept_edge` (there is deliberately NO client insert/update
policy on `concept_edges`; default-deny makes the gate unbypassable):

1. author gate (course author, or service-role for the pipeline);
2. node validity (exist, same course, not retired);
3. `pg_advisory_xact_lock(course:kind)` — serializes writers so two
   concurrent inserts can't each pass the check and jointly commit a cycle;
4. per-kind WITH RECURSIVE reachability (depth<500): target→…→source of the
   SAME kind ⇒ `concept_edge_cycle`. **Cycles are per-kind**: `related` may
   close a loop the `prerequisite` DAG forbids — each kind is its own DAG;
5. version discipline: a stale `p_expected_version` ⇒
   `concept_edge_version_conflict` (the social versioned-update rule; nodes
   use the same rule client-side via `versionedUpdateConceptNode`).

Renderers stay cycle-TOLERANT (a bad row must never crash a traversal); the
write path keeps such rows from existing. Rail restores also ride the RPC, so
a Reject can never install a cycle either.

## Extraction (Wave 1.3 — `lib/tutor/graph/extraction.ts`)

Source = the **publication snapshot** (`getCachedSnapshot`), never the draft.
Pipeline (each stage pure where possible, model calls via `runStructuredCall`
+ `TUTOR_MODELS`, every call cost-emitted):

chunk per lesson (`extractionSource.ts` — slide text, quiz STEMS [snapshots
are answer-stripped by construction], homework prompts; anchors collected)
→ propose (Terra, `graph_extraction_proposal`; grain rule in-prompt AND
re-checked in code) → `normalizeGrain` to the density band
(`TUTOR_GRAIN_MIN/MAX_PER_LESSON` 1–4, course cap 60; out-of-band ⇒ flags,
never silent truncation) → canonicalize (exact-title pre-merge → ONE batched
embed → greedy cosine clustering @ `TUTOR_CANON_SIM_THRESHOLD` → Terra
merge-adjudication `graph_merge_adjudication`; alias map persisted on the
node) → edge inference (Terra `graph_edge_inference`) → pure passes:
`pruneEvidenceless` (an edge without evidence does not exist) →
`dropLowConfidence` → `breakCyclesDropWeakest` (per kind, deterministic,
logged) → `transitiveReduction` → assumed-priors → **persist rows first, then
stage** (the `stageStructureChangeSet` convention).

Budgeted (`TUTOR_EXTRACTION_MAX_CALLS`): exhaustion checkpoints with the
unprocessed lessons named — partial work is staged honestly, never silently.

## Review — ONE change-set on the existing rail

The whole run stages ONE `change_sets` row whose items are
`node_type='concept_graph'`, `op='create'`, `after = { entity, row }`
(`ConceptGraphItemPayloadSchema`) for EVERY persisted row — nodes, edges,
assumed-priors, snapshot-map. A fate row rides `agent_findings`
(`graph_extraction:{courseId}` dedupe key, open→proposed at staging; the
existing change-set Accept/Reject route transitions proposed→accepted |
dismissed via `change_set_id`).

- **Accept** settles status — the rows are already live: the graph activates.
- **Reject** deletes every staged row through the DOMAIN-PARTITIONED restore
  (`lib/tutor/railRestore.ts` + the `rejectChangeSet` partition in
  `lib/ai/changeSet.ts`): both domain plans are computed BEFORE any write
  (all-or-nothing preserved — one unparseable item aborts the whole reject),
  and a graph-only set NEVER loads the course document. No active graph
  remains; the fate row is dismissed.
- A pending graph change-set blocks a second run (`alreadyPending`) — the
  stage-time guard plus the Inngest per-course concurrency key.

## Reconciliation (Wave 1.4)

On republish over an ACTIVE graph, the reconciler diffs fresh candidates
against active nodes and classifies every one: `matched` (keeps the existing
id) · `added` · `removed` (→ status 'retired', never deleted) · `split` /
`merged` (full lineage recorded — the parent→children mapping plus the
configured confidence factor ride the item payloads for Wave 2's mastery
redistribution, AC-T1.7a). `creator_locked` edges and `creator_edited` nodes
are SUPPRESSED from the diff (never produce items) unless their underlying
content was deleted — then flagged, not auto-changed. Anchors re-resolve per
snapshot with the R-13 block-level downgrade. The result stages as ONE
reviewable change-set with per-node classification visible in the payloads.
An identical-hash republish (the publish service's no-op path) enqueues
nothing.

## Verification map

- `verify:tutor` (npm test chain): `verify-tutor-models` (registry/pricing/
  deny-list/grep guard/seam) · `verify-tutor-telemetry` (contract/uuid/
  mapping/drift guards) · `verify-tutor-graph` (schemas/payload contract/
  migration drift/revert-window).
- `verify:reject` chains `verify-tutor-rail` (partition, plan goldens,
  all-or-nothing, FK ordering, lockstep drift guards).
- `verify:tutor:int` (live DB): the cycle gate per kind, the RLS matrix, the
  versioned-write 409 + byte-for-byte ledger revert + past-window refusal.
- `verify-tutor-extraction` (pure) + `verify-tutor-extraction-int` (live DB +
  mock model): the full pipeline, AC-T1.3/T1.4/T1.5 and the int-level close
  of AC-W1M.2.
- Live smokes (manual, never CI): `smoke:tutor` (model ids/effort/pricing),
  `smoke-tutor-extraction` (a real Terra run over the tutor fixture).
