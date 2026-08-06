# TUTOR-1 — Operator Runbook

> How to run the AI tutor in production: what the flags do, where the money goes,
> how to watch it, and how to recover safely. Companion docs: `architecture.md`
> (the model/cost pipeline), `escalation.md`, `analytics.md`, `mastery.md`.

## Flag inventory

Every TUTOR flag, its default, effect, and when to flip it. All are
env-overridable; none is required in dev.

| Flag | Default | Effect | Flip when |
| --- | --- | --- | --- |
| `TUTOR_ENABLE_CHAINING` | **off** | L4 collapses to the provider `previousResponseId` instead of textual replay (P-3). | A privacy/latency decision, not a cost one — the 5-min-TTL smoke showed the prompt cache survives at cadence, so chaining is not needed for cache health. Leave off unless you want provider-side thread state. |
| `TUTOR_ESCALATIONS_UI` | **on** (`!== "false"`) | Renders the learner consent card + the creator Escalations tab. The escalation loop is complete behind it. | Off to hide the loop (e.g. a course cohort not ready for it). Resolved once in `lib/tutor/flags.ts` so the learner + creator surfaces can't disagree. |
| `DIGEST_DRY_RUN` | **on** (`!== "false"`) | The creator digest renders + persists `creator_digest` rows but sends NO mail (`provider_mode='dry_run'`). | Off **only** after inspecting real digest output and confirming `RESEND_API_KEY` + `RESEND_FROM` are set on a verified domain. This is the operator's call, never the wave's. |

Per-course settings (on `tutor_course_settings`, edited in the console): `enabled`
(the master switch — the sidebar mounts only when true), the six charter knobs,
`digest_opt_out`, `digest_cadence` (`daily`/`off`).

Model + budget env: `TUTOR_<JOB>_MODEL`/`_EFFORT`/`_TIMEOUT_MS`/`_MAX_RETRIES`/
`_MAX_OUTPUT_TOKENS` per job; `TUTOR_CANON_SIM_THRESHOLD` (0.85),
`TUTOR_RECONCILE_MATCH_THRESHOLD` (0.8), `TUTOR_ESCALATION_CLUSTER_THRESHOLD`
(0.83), `TUTOR_MASTERY_MIN_COHORT` (5, the D-4 floor). Infra:
`OPENAI_API_KEY` (required for any live tutor turn), `INNGEST_EVENT_KEY` +
`INNGEST_SIGNING_KEY` (prod; dev uses `npx inngest-cli dev`).

## Where the money goes (cost dashboards)

Every tutor model call rides `withPooledModel`, the single cost-interception point,
which writes a `tutor_model_call` row into `learning_events` with `job_type` +
computed USD. The six tracked jobs: `tutor_turn` + `practice_gen` (gpt-5.6-luna),
`graph_extraction` + `reconciliation` + `lesson_rationale` + `escalation_dossier`
(gpt-5.6-terra), and `embedding`. (`practice_gen`'s per-item cost is intentionally
not row-emitted — a luna precedent; all Terra spend is tracked.)

- **Per-course spend by job:** the console Overview tab's cost card
  (`tutor_console_bundle`, author-gated) groups `tutor_model_call` by `job_type`.
- **Project spend:** `sum(metric_value)` over `learning_events` where
  `event_type='tutor_model_call'`, grouped by `job_type` and day. These rows are
  R-9-invisible to every client role; read them with the service role.
- **Cost model:** `computeCostUsd` (`lib/ai/modelConfig.ts`) prices input/cached/
  output per MTok. Terra ≈ $1.25 / $0.125 / $10 per MTok; luna ≈ $0.25 / $0.025 /
  $2; embeddings ≈ $0.02. The Wave-3 checkpoint's cache smoke shows a live tutor
  session runs ≈72% cheaper on the input side thanks to the L0 prompt cache.

## Cache-ratio monitoring

The layered prompt keeps L0 (identity/pedagogy) byte-constant and first, so the
provider caches it. `scripts/smoke-tutor-cache.ts` is the manual probe: 10 turns
at realistic cadence with a deliberate 5-minute gap, printing cached/input per
turn. Target: cached ratio ≥ 0.7 from turn 2 (last measured 0.79–0.94). If the
ratio falls, check that (a) `TUTOR_L0` didn't change without a `TUTOR_PROMPT_VERSION`
bump, and (b) the variable context still rides the developer/input messages, not
the system message.

## Evidence replay

Every mastery/evidence event carries a deterministic, purpose-prefixed
`client_event_id` (`wisesel.tutor-evidence.v1:evidence:{turnId}:{i}` etc.), so
re-emitting is a no-op (`on conflict do nothing`). To replay a learner's mastery:
re-run the refold (`tutor/mastery.refold.requested` or the nightly reconcile) —
it full-replaces `learner_mastery` deterministically from the event stream. The
change-set rail is likewise replayable: reject computes byte-for-byte inverse
patches; accept is idempotent.

## Safe re-extraction

The concept graph is staged, never auto-applied. To re-extract:
`tutor/graph.extraction.requested` (or the weekly cron) stages a pending
change-set; a pending set short-circuits a second run (`alreadyPending`), so you
can't double-stage. Reconciliation preserves creator edits (`creator_edited`
nodes are never auto-stomped; `creator_locked` edges are never auto-removed).
Review + Accept/Reject in the console's Concept-graph tab; Reject restores
byte-for-byte. A merge redistributes `learner_mastery` through the definer
`tutor_merge_concept_nodes` (the only legal writer of that service-role table).

## Digest dry-run → live flip

1. Run `npm run seed:tutor-escalation-demo` (or wait for real escalations) so a
   course has cluster/most-missed content.
2. Let the nightly digest job run (or invoke `sendCreatorDigest` manually) with
   `DIGEST_DRY_RUN` on. Inspect the `creator_digest` row: `content` (aggregate,
   no `user_id`), `provider_mode='dry_run'`, `status='dry_run'`.
3. Confirm `RESEND_API_KEY` + a `RESEND_FROM` on a verified domain.
4. Set `DIGEST_DRY_RUN=false`. New rows resolve `provider_mode='resend'`;
   `status='sent'` only when the send actually succeeds — a failure is `'failed'`
   with the error, never a silent 'sent'. Opt-out (`digest_opt_out`) +
   `comms_suppressions` are re-checked at send.

## Inngest jobs (all idempotent; correctness never depends on the event)

`tutorMasteryRefold` (event), `tutorMasteryNightly` (04:00), `tutorLessonHealthNightly`
(05:00), `tutorEscalationSynthesize` (event) + `tutorEscalationReconcileNightly`
(06:00), `creatorDigestNightly` (07:00), plus the graph extract/reconcile.
Dev has no `INNGEST_EVENT_KEY`, so event sends no-op and the nightly reconciles
are the correctness path — run `npx inngest-cli dev` alongside `npm run dev` to
exercise crons locally.
