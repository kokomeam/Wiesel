# TUTOR-1 — Architecture (Wave 1 sections)

> Companion: `docs/tutor/concept-graph.md` (the Wave-1 subsystem itself).
> Governing documents: the Wave 1 Execution Order (amendment A1 resolutions
> restated inline), `TUTOR-1-w1-delta-note.md` (post-merge verification),
> `TUTOR-1-task0-audit.md` (the factual base; symbol names are the durable
> pointers). Later waves append their sections here.

## Scheduler — D-1 Branch A: Inngest (decided by W1.0 verification)

All TUTOR-1 timed/durable work rides **Inngest**, the scheduler the
social-publishing workstream landed (`inngest@4.x`, client id `wisesel` in
`lib/inngest/client.ts`, serve route `app/api/inngest/route.ts`). The W1.0
delta pass verified it is fully wired (two production functions, event
vocabulary, dev workflow) — so the Branch-B fallback (pg_cron + fail-closed
drain route) is dead. Conventions TUTOR-1 extends, copied from the social
functions:

- **Function ids** kebab-case (`tutor-graph-extract`); **events**
  `{domain}/{noun}.{verb}` (`tutor/graph.extraction.requested`,
  `tutor/graph.reconciliation.requested`).
- **Sends are best-effort** (log, never throw) — a lost event must have a
  reconciliation path, never a hard dependency on delivery.
- **Concurrency** is declared on the function (`concurrency: { key:
  "event.data.courseId", limit: 1 }`) — one graph run per course at a time;
  the stage-time pending-set guard (`alreadyPending`) is the second,
  DB-anchored line of defense.
- **vercel.json stays untouched** — Inngest crons live in function
  definitions, not platform config.
- **Dev**: `npx inngest-cli@latest dev` auto-discovers `/api/inngest`;
  integration suites run the pipeline CORE directly (deps-injected) so CI
  never needs the Inngest dev server up.

## Model routing — ONE registry, per-call routing, a deny-list at load

`lib/ai/modelConfig.ts` `TUTOR_MODELS` is the single source of truth for every
tutor job: `graph_extraction` / `reconciliation` → `gpt-5.6-terra`,
`embedding` → `text-embedding-3-small`, `tutor_turn` → `gpt-5.6-luna`
(consumed in Wave 3). Every entry is `{model, effort, timeoutMs, maxRetries,
maxOutputTokens}`, env-overridable per field, **effort always explicit**.
`gpt-5.6-sol` is deny-listed at module load (`assertTutorModelAllowed`) — a
directive prohibition enforced in code, and a grep guard in
`scripts/verify-tutor-models.ts` keeps tutor model literals out of every file
but the registry.

Calls route through the EXISTING seam: `runStructuredCall` (extended with
per-call `model/effort/timeoutMs/maxRetries` — existing callers byte-identical)
over the provider-agnostic `ModelClient`. `ModelClient.embed` is new (batched,
one API call per batch; deterministic 32-dim mock). Concurrency rides
`withSemaphore` exactly like the maintenance orchestrator.

### Response chaining (D-3) — seam built, dead until Wave 3

`ModelTurnParams.previousResponseId` / `store` and the result's `responseId`
exist and are wired through the OpenAI provider (verified live — the smoke
prints a real `resp_…` id). Foreground calls stay `store:false` by design
(P-3); `TUTOR_ENABLE_CHAINING` ships default-off in Wave 3. `inspectImage` was
pinned to explicit `store:false` in the same pass.

## Cost telemetry — the ONE analytics pipeline, author-invisible per-call (R-9)

Every tutor model call emits a `tutor_model_call` event onto the SAME
`learning_events` stream (never a parallel path), via the server-emit
admin-upsert discipline (`lib/tutor/telemetry.ts emitTutorModelCall` — never
throws; telemetry must not break a pipeline step):

- **Idempotency**: `client_event_id` = deterministic UUID over
  `wisesel.tutor.v1:{provider_response_id}` — an Inngest step retry re-emits
  as a no-op. Embedding calls get the synthetic deterministic id
  `embed:{runId}:{batchIndex}` (the embeddings API returns no response id).
- **Typed columns** (M3 convention, migration `20260803100000`): job_type,
  model, input/cached/output tokens, computed_cost_usd, latency_ms,
  learner_user_id (nullable — extraction runs have no learner). Course-scoped
  envelope (course_id NOT NULL, publication/version/lesson NULL — the
  envelope CHECK admits exactly this shape).
- **R-9, why the select-policy exclusion**: `course_id` is NOT NULL on these
  rows, so the author semi-join SELECT policy would otherwise expose per-call
  rows (model ids, latencies, per-learner call patterns once Wave 3 lands) to
  creators. The policy is re-created with `event_type not like 'tutor_%'`:
  per-call rows are invisible to EVERY client role. Creators get AGGREGATE
  spend only, through the service-role-only `tutor_model_costs_daily` view
  (SECURITY INVOKER + all client grants revoked). The client batch schema
  excludes the type and the ingest RPC rejects any `tutor_%` row a browser
  forges — server-emitted or nothing.
- **Cost math**: `computeCostUsd` (pure, colocated with the pricing registry)
  = (input−cached)·rate + cached·cachedRate + output·rate, per-token.
  Responses-API `output_tokens` already includes reasoning tokens — they are
  never added twice. terra/luna prices are PLACEHOLDERS pending the provider
  price sheet (`TUTOR_PRICING_JSON` overrides); unknown model → cost null,
  the row still lands.

## Concurrency & budgets (Wave-1 scope)

Wave 1 keeps the existing global 2-call semaphore (`withSemaphore`) for
extraction — the keyed per-principal pool registry (creator 2 / learner 8
FIFO) is Wave 3 work, and the second-parameter seam (`withSemaphore(model,
pool)`) is already in place for it. Extraction runs carry their own call
budget (`TUTOR_EXTRACTION_MAX_CALLS`, default 40) with graceful checkpointing:
budget exhaustion stages what was built and names the unprocessed lessons —
never a silent half-run.

## Prohibitions in force (Wave 1 audit)

- No new agent frameworks; the pipeline is `runStructuredCall` + pure modules.
- No second DB write path: nodes ride the versioned-update rule, edges ride
  the ONE definer RPC (the cycle gate), everything else is plain RLS writes.
- No provider-side scheduling; Inngest only.
- No MCP in production code paths.
- Accept/Reject extended, never weakened: the reject partition computes BOTH
  domain plans before any write; one bad item aborts the whole reject.
- No mocked numbers in any UI (no tutor UI ships in Wave 1).

## Wave 2 — the mastery layer (appended 2026-08-03)

**Evidence flow:** graded quiz answers land per-question in
`quiz_attempt_detail` through the `record_quiz_attempt` single-transaction
RPC (the grading write is now atomic — attempt + responses + detail);
tutor-emitted evidence (`practice_answer`, `hint_request`, `self_report`,
`tutor_inference`) joins `learning_events` as SERVER-ONLY members (the ingest
RPC rejects them from the client batch); `content_engagement` is the one
client member (rewatch/scrub_back/completed — a browser cannot know node
ids). The `tutor_inference` metadata shape ({node_id, direction, strength,
turn_ref}) is FROZEN now as Wave 3's side-channel contract.

**Refold + scheduling:** `refoldLearnerCourse` (deterministic, lineage-aware
— split parents redistribute at the recorded 0.75 factor) → `writeMastery`
(full-replace) → `materializeMasteryResults` (review queues + cohort
aggregates). Nightly `tutor-mastery-nightly` (04:00) + on-demand
`tutor/mastery.refold.requested` (handled now, emitted by Wave 3). Zero model
calls anywhere in the layer — grep-guarded.

**The strict-regime boundary (drawn in Wave 2):** everything mastery-shaped
is invisible to creators except `concept_mastery_aggregate` (cohort floor 5
inside the SQL; suppressed rows disclose nothing, not even the count).
Learners read their own mastery/queue/detail through own-row policies and
definer RPCs only. The legacy analytics regime (roster, raw timelines) is
untouched — the two regimes coexist by table, exactly per the two-regime
resolution.

**Sequencing honesty:** Wave 2 defines every evidence member and handles
every schedule, but wires client emission for NONE of them — the engine is
proven on day-one historical data (block-level attempts at 0.30 weight +
dwell), which IS the cold-start story, tested as such.

## Wave 3 — the tutor runtime (appended 2026-08-04)

**Route diagram:** `POST /api/learn/tutor` → requireUser → access matrix
(disabled / author_preview [never emits] / not_enrolled / ok) → learner
turn persisted → history + charter + concept context loaded → the layered
prompt (L0 static cache prefix · L1 charter · L2 lesson · L3 learner state
· L4 replay-or-chaining) → ONE structured Luna call under the LEARNER pool
(≤3 tool rounds over the five-tool registry) → scaffolding → grounding →
assistant turn persisted (completion only) → evidence server-emitted →
targeted mastery refold fired → SSE {queued}→{turn}→{done}.

**Pools as-built (D-2 consumed):** the Semaphore is hardened — release
HANDS the slot to the head waiter (no barging window), acquire(signal)
dequeues on abort, FIFO proven under stress. poolFor("creator") IS the
legacy modelCallSemaphore (existing call sites identical); the learner pool
(AI_LEARNER_POOL_MAX=8) serves tutor turns. `withPooledModel` is the ONE
cost-interception point (runTurn AND embed) — Wave 1's inline emission is
retired; ids are retry-stable `${runKey}:${seq}` under Inngest, responseId/
uuid on route turns. Pools remain per-Vercel-instance.

**Evidence flow now LIVE:** practice answers, self-reports, hint requests,
and per-turn tutor inferences land on `learning_events` through the frozen
Wave-2 members with deterministic purpose-prefixed ids; each emission fires
`tutor/mastery.refold.requested` for exactly that (learner, course). The
sequencing-honesty gap is closed exactly as planned: Wave 2 defined, Wave 3
emits.

**P-3 status:** the chaining seam is fully built (turn.response_id stored;
L4 collapses behind TUTOR_ENABLE_CHAINING) and remains OFF by default —
foreground turns ship store:false. This wave was the last natural decision
point; the checkpoint carries the note.

## Wave 4 — the learner sidebar (appended 2026-08-04)

The client path, end to end:

```
app/(learn)/learn/[slug]/layout.tsx  (server; resolveTutorAccess gates)
  └─ TutorFrame (client, reflow) ─ children (the lesson page tree)
  └─ TutorMount (client, EAGER ≤5KB: edge tab, ?tutor/?seed one-shot)
       └─ next/dynamic ssr:false → TutorBody (LAZY chunk)
            ├─ useTutorStream ── POST /api/learn/tutor (SSE: queued→turn→done)
            ├─ tutorHistory ──── learner-own tutor_threads/turns (RLS)
            ├─ practice cards ── practice_answer (client-graded, Contract 5)
            ├─ self-report ───── self_report (stable-keyed)
            └─ TUTOR_TTFT ────── perf_vital (alerts-not-gates)
  players ⇄ lib/learn/tutorStore (ambient context · citationRequest · seed)
```

Trust boundaries unchanged from Wave 3: the route's access gate + the
service-role-only assistant writes + the frozen event schema at emission.
The client adds NO privileged path — its reads are the learner's own RLS
rows, its writes go through the same four route actions.

## Wave 5 — the creator console (appended 2026-08-05)

`/studio/[courseId]/tutor` — a four-tab creator console (the analytics-console
pattern: server-rendered `?tab=`, one author-gated definer bundle-RPC per tab,
`notFound()` for non-authors). Own route budget (230 KB / 250; the learn route
is untouched).

```
/studio/[courseId]/tutor?tab=
  ├─ overview   tutor_console_bundle  — enablement · usage (cohort-floored ≥5) · cost by job_type
  ├─ charter    tutor_console_bundle  — enable toggle (opt-OUT: on by default, NOT graph-gated) + 6-field charter via applyCharterChange + version history
  ├─ graph      tutor_graph_console   — pure-SVG editor (own store/viewport/layout; ZERO editor-store imports)
  │                                     versioned node/edge edits · tutor_upsert_concept_edge cycle gate ·
  │                                     tutor_merge_concept_nodes (folds service-role-only learner_mastery, §1.4) ·
  │                                     cohort-floored overlays · staged change-set review (accept/reject)
  └─ analytics  most_missed_questions · lesson_health — A1.3 most-missed (SQL-derived, no learner rows) ·
                                     deterministic rollup_lesson_health composite (Terra writes only the rationale,
                                     nightly Inngest) · confusion heatmap · mastery funnel
```

**The privacy invariant (D-4), enforced not asserted:** every creator-facing
number comes from a cohort-floored (`>= 5` distinct learners) author-gated
SECURITY DEFINER RPC (`revoke public,anon` + `grant authenticated`); below floor
→ a `suppressed` state that discloses nothing, not even the count. The raw
learner tables (`learner_mastery`, `quiz_attempt_detail`, `tutor_turns`,
`mastery_review_queue`) keep ZERO author policies — authors read only through the
floored definer RPCs. The graph editor is fenced off the ~590 KB editor bundle
(no `lib/course/store`/`patches`/`SlideStage` imports) so the console route
carries its own weight.

## Wave 6 — the escalation loop (appended 2026-08-06, project close)

The loop that closes the tutor. When the tutor can't answer, a **consented**
escalation flows into creator scope and back into the course:

```
learner turn ──trigger (sensitivity-driven)──► consent card (editable question)
   └─ Send ─► tutor_escalation_candidates: consent_pending → consented
             └─ tutor/escalation.consented (Inngest) ─►
                synthesizeAndCluster: Terra dossier (no identity) + embed +
                  join/create escalation_cluster (cosine ≥ 0.83, stable id)
                  ├─ escalation_dossier   (identity-BEARING, RLS zero policies)
                  └─ escalation_cluster   (identity-FREE, author-readable, COUNT)
   creator console ── Escalations tab (tutor_escalation_queue, author-gated) ──
     ├─ Approve/edit ─► apply_escalation_reply: 1 instructor tutor_turn / member,
     │                   exactly-once per (cluster,user) via a ledger
     ├─ Dismiss(reason)
     └─ Promote ─► Terra drafts an FAQ block ─► createChangeSet (EXISTING rail)
                   └─ Accept ─► resolved_in_content (DERIVED from change_set) ─►
                      node drawer: "clarified after N asked" ─► publish ─► reconcile
   creator digest ── lib/notify (NEW seam, never lib/comms's send) ──
     daily, cohort-floored, aggregate-only, DIGEST_DRY_RUN default ON,
     provider_mode persisted per row (never silently 'sent')
```

**The privacy boundary is structural.** Consent is the only path into creator
scope, and it exposes only identity-free aggregates: the dossier that carries
`user_id` has zero RLS policies (definer/service-role only); the cluster and the
queue have no `user_id` at all. A creator sees a count and a representative
question, never a roster. The no-auto-send boundary is equally structural: the
tutor runtime imports no send path, and the digest is a separate seam. Everything
else reuses existing rails — the change-set Accept/Reject, the `tutor_turns`
thread, the `withPooledModel` cost point, the Inngest cron pattern — so Wave 6
added surfaces, not systems.

TUTOR-1 is complete. See `TUTOR-1-completion-report.md` for the consolidated
Waves 1–6 acceptance ledger, the final privacy proof, and the cost economics.
