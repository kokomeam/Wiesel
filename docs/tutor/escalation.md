# TUTOR-1 — The Escalation Loop (Wave 6)

> The loop that closes the tutor: when the tutor can't answer, a consented
> escalation becomes a creator-visible cluster, the creator replies to every
> affected learner at once, and a reply can be promoted into course content — all
> without ever exposing who asked. Companion docs: `runtime.md`, `charter.md`,
> `analytics.md`, `concept-graph.md`, `runbook.md`.

## The two invariants (enforced, not asserted)

1. **Consent invariant (RLS).** `tutor_escalation_candidates` is learner-own-only
   (SELECT/UPDATE on `user_id = auth.uid()`, no author policy, a status-only
   trigger). A `consent_pending` or `withdrawn` row is unreachable by ANY creator
   principal — no policy, RPC, view, or join. **Consent is the only transition
   into creator scope**, and it moves nothing directly: the on-consent synthesis
   job writes *derived* rows. The identity-bearing `escalation_dossier` keeps ZERO
   policies (service-role/definer only); the creator-visible `escalation_cluster`
   has **no `user_id` column** at all. So a creator sees "14 learners asked,"
   never who. (`verify-tutor-escalation-int` proves the RLS matrix.)
2. **No-auto-send invariant.** `lib/comms` remains the single *learner-mail* send
   site (`service.ts`'s one `provider.send`). The creator digest is a separate
   `lib/notify/creatorDigest.ts` seam that never imports that send site, and the
   tutor runtime can reach no `provider.send` at all (grep-proven by
   `verify:comms` negatives).

## 1. Triggers + consent (W6.1)

The turn loop escalates on the FIRST of, in precedence order: an **explicit
human request** (regex over the learner message), the already-computed
**`ungrounded`** grounding flag (low-confidence substantive prose), or **N
repeated failed scaffolds on one node**, where N is charter-driven —
`escalation_sensitivity` low = 4 / default = 3 / high = 2 (a "failed scaffold" =
a prior assistant turn on the same node followed by a confusion signal). When the
model itself didn't propose an escalation, the deterministic trigger raises one,
so sensitivity actually drives the behavior. `propose_escalation` writes a
`consent_pending` candidate populated with the rung trail + cited anchors.

The **consent card** (learner sidebar, behind `TUTOR_ESCALATIONS_UI`, on by
default) renders exactly what will be shared: the learner's question (**editable**),
the implicated concept, and the tutor's proposed answer — with Send / Cancel and
copy stating the instructor will see it in their queue (no SLA implied). **Send**
(`escalate_consent` route action) transitions the candidate `consent_pending →
consented` with the final edited question; **Cancel/timeout** → `withdrawn`. The
migration relaxes the status-only trigger to permit the question/anchors/rung_trail
edit *only* on the consent transition; everything else stays immutable. Send fires
`tutor/escalation.consented`.

## 2. Dossier synthesis + clustering (W6.2)

On `tutor/escalation.consented` (Inngest, per-course serialized; a nightly
reconcile at 06:00 UTC mirrors it so correctness never needs the event),
`synthesizeAndCluster` runs: **gpt-5.6-terra** (`TUTOR_MODELS.escalation_dossier`,
via `withPooledModel` — cost-tracked, sees NO learner identity, only the
anonymized question + node context) synthesizes a dossier `{summary,
confidenceNotes}`; the question is embedded (`ModelClient.embed`); and it joins
the nearest **open** cluster on the *same node* (cosine ≥
`TUTOR_ESCALATION_CLUSTER_THRESHOLD`, default 0.83) or forms a new one. Clustering
is **stable-identity**: a new member joins an existing cluster; a cluster's id
never changes. `escalation_dossier` (identity-bearing) is keyed by `candidate_id`
(idempotent); `escalation_cluster` (identity-free) carries the `member_count` +
representative question. `AC-T6.1`: 10 near-dupes collapse to one cluster of 10;
an 11th joins the same id.

## 3. Creator queue + reply delivery (W6.3)

The flag-gated **Escalations tab** (`tutor_escalation_queue` author-gated definer
RPC) shows one card per cluster: the implicated node + anchor deep links, the
representative question, a **count** ("14 learners asked" — never a roster), the
tutor's proposed answer (editable), and the evidence trail — Approve-and-send /
Dismiss(reason) / Promote. **Delivery** (`apply_escalation_reply`, service-role
definer) writes one `instructor`-role `tutor_turns` row into each cluster member's
own thread, **exactly-once per (cluster_id, user_id)** via an `on conflict do
nothing` ledger — retries and partial failures never double-deliver. The learner
sees the instructor reply in the same thread (`AC-T6.2`).

## 4. Content-patch promotion (W6.4) — the loop closes

**Promote** builds a `BlockChange[]` — an FAQ `lecture_text` block appended to the
implicated lesson, drafted by Terra from the dossier + the creator's approved
answer (no learner identity) — and files it through the **existing**
`createChangeSet` rail with the dossier summary as `ctx.evidence`. The unchanged
`BlockFrame` pending chrome + `EvidenceCard` + Accept/Reject handle it. Resolution
is **derived, not hooked**: the cluster records `change_set_id`, and it is
`resolved_in_content` only when that change-set is `accepted` (both the queue RPC
and the graph console RPC compute it at read time via a left join). The node
drawer then shows "clarified after N learners asked." Accepting the patch changes
the draft doc; the next publish triggers the Wave-1 reconciliation path normally
(`AC-T6.3`, `AC-W6P.1` end-to-end).

## 5. Creator digest (W6.5) — ships conservatively

`lib/notify/creatorDigest.ts` sends a daily digest (Inngest, 07:00 UTC) of new
clusters, cluster movers, and A1.4 most-missed movers — all cohort-floored,
aggregate-only (no `user_id` in the content). It re-checks `digest_opt_out` +
`comms_suppressions` at send and is idempotent per (course, day) via a unique
`idempotency_key`. **The footgun guard:** `provider_mode` (`resend`/`mock`/
`dry_run`) is persisted on every `creator_digest` row, and `status='sent'` only
when `provider_mode='resend'` AND the send succeeded — a mocked or dry-run row is
never silently marked sent. **`DIGEST_DRY_RUN` defaults ON**: the digest renders +
persists but sends nothing until an operator flips it (`AC-W6E.1`/`W6E.2`).

## Cost + models

Dossier synthesis and reply/FAQ drafting run on `gpt-5.6-terra` through the single
`withPooledModel` cost-interception point (`tutor_model_call` telemetry); the
`job_type` CHECK admits `escalation_dossier` (and `lesson_rationale`) so all Terra
spend is tracked. Terra prompts are identity-free by construction.
