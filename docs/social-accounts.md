# Social publishing foundation (M-A) — connected accounts

> The production foundation built on Task 0a's CONDITIONAL GO for
> **Upload-Post** (`spikes/task0-upload-post/FINDINGS.md` — the live-verified
> endpoint mapping, response shapes, and evidence samples there are
> **authoritative over the vendor's own spec** where they conflict). M-A links
> and manages creator accounts; **no publish call is made anywhere in M-A** —
> publishing ships in M-B.

## Architecture

```
components/marketing/accounts/*          ← client UI (cards, import dialog)
app/(app)/marketing/accounts/{page,actions}  ← server surface (auth + RLS)
lib/marketing/accounts/
  accountsService.ts    ← orchestration (link / reconcile / selection / usage)
  accountsRepository.ts ← THE only writer of the 3 tables (versioned updates)
  crypto.ts             ← AES-256-GCM for profile refs (SOCIAL_ACCOUNTS_ENC_KEY)
  events.ts             ← emitAccountEvent → the single analytics_event stream
  constants.ts          ← platforms, health states, §9 explainers, usage thresholds
  fixtures/task0a/*.json ← RECORDED live responses (redacted) driving the tests
lib/marketing/publish/provider/
  types.ts              ← SocialPublishProvider (provider-agnostic seam)
  uploadPostClient.ts   ← the ONLY vendor module (fetch + Apikey, no SDK)
  index.ts              ← selection point (Postproxy swap lives here)
```

- **Seam rule** (the ClipRenderProvider/muxClient precedent): Upload-Post
  specifics exist in exactly one file; `api.upload-post.com` anywhere else
  fails `verify:accounts`. Errors carry `permanent` (4xx except 408/429) and
  services branch via the duck-typed `isPermanentPublishError`.
- **Data**: migration `20260723120000_social_accounts.sql` —
  `social_provider_profile` (1/creator, encrypted ref) · `social_account`
  (per-platform health: linked | expired | revoked; `unique (creator,
  provider, platform)`; versioned writes only) · `social_publish_ledger`
  (append-only; **no update/delete policy even for the owner**). RLS ×3 on
  `creator_id = (select auth.uid())`. Types **SPLICED** into
  `lib/database.types.ts` (never full-regen — branch drift rule).
- **Events**: `social_account_linked` / `_expired` / `_revoked` (snake_case —
  the repo's deliberate deviation from dotted PRD names) on the single
  `analytics_event` stream; emission is best-effort and **skips when the
  creator has no course yet** (`analytics_event.course_id` is NOT NULL — rows
  remain the source of truth, events are telemetry).
- **Linking flow**: `beginLinkAction` → provider JWT `access_url` (~48 h) →
  hosted page → back to `/marketing/accounts?linked=1` → server-side
  `reconcileAccounts` pulls `listConnectedAccounts` truth into rows. More new
  platforms than expected → the **multi-account import dialog** (keep some,
  revoke the rest). Health map: provider `reauth_required` → `expired`;
  absent-after-linked / deselected / manual disconnect → `revoked`.

## The four Task 0a design deltas (why the code looks like this)

1. **No delete.** `deletePost()` returns
   `{deleted:false, reason:"unsupported_by_provider"}` for every platform and
   **fires zero requests** (Test 3: 7 probes, all 404). ⚠ Upgrade path: the
   vendor's newer OpenAPI (2026-07-23) documents `POST
   /uploadposts/posts/unpublish` ("Supported: facebook, youtube, x, linkedin,
   threads") — **unverified and stays that way** (M-B decision 1 below): no
   re-probe unless a specific newly documented endpoint is cited first.
   Never probe from production code.
2. **Self-tracked quota.** No provider quota-read endpoint exists (`usage`
   rides only in sync upload responses). Monthly usage = counting
   `social_publish_ledger` rows (M-B inserts one per provider-ACCEPTED
   upload); thresholds in `accountsUsageConfig()`
   (`SOCIAL_UPLOADS_PER_MONTH`=10, `SOCIAL_UPLOADS_WARN_AT`=8, env-override
   for paid tiers).
3. **Poll-only verification.** Webhooks observed delivering ZERO events live
   (plus a spec/docs contradiction on the config shape, and no signature) —
   `verifyPost` polls `GET /uploadposts/status` (live-verified to carry
   `platform_post_id` + `post_url`, richer than the vendor spec) with history
   (`limit=10` — the only accepted page size) as the audit backstop. "live"
   is terminal — never wait on YouTube Shorts classification (lags ~2–3 min).
   The webhook config left on the vendor side is a passive Task 0b
   experiment; no ingestion route exists here.
4. **Recovery ref persistence (M-B note).** There is no provider idempotency
   key; LinkedIn rejects only *consecutive identical* content. M-B MUST
   persist `clientRef` (manifest id) + the returned `providerRequestId`
   BEFORE/at the publish call, and recover ambiguous failures by
   `verifyPost`/history lookup — **verify-before-republish, never re-fire**.
   Sharpened into the binding manifest contract below (decision 2).

## M-B binding decisions (checkpoint, 2026-07-29)

Recorded at the M-A closeout review — these are BINDING on M-B:

1. **Unpublish re-probe: NO.** Task 0a proved no deletion API exists (7
   probes, all 404). `deletePost` honest-refusal stands. Do not spend uploads
   or calls re-probing unless a specific newly documented endpoint is cited
   first. The two live Task 0a test posts are cleaned up manually by the
   creator — not code's concern.
2. **Manifest contract.** The manifest row is persisted BEFORE the provider
   publish call; the provider job/request ref is persisted as its own durable
   step IMMEDIATELY after the call returns — that ref is the primary
   crash-recovery handle. History (`limit=10` cap) is fallback-only.
3. **Webhooks: passive experiment only.** M-B's first real publish tests
   delivery for free (the docs-shape config already sits vendor-side).
   Poll-verify remains the production path regardless of the result. No
   webhook code in the production workflow.
4. **Ledger semantics.** Write the row on provider-ACCEPT; SKIP it when the
   response carries `platformError` (mirrors the proven vendor quota
   semantics). Accepted-then-platform-failed may over-count by one — accepted
   drift: no quota-read endpoint exists to reconcile against, and
   over-counting errs toward warning the creator early, the safe direction.
   Rationale also lives on `insertLedgerRow` in `accountsRepository.ts`.

## M-B — the publish path (`lib/marketing/publish/*`, 2026-07-29)

Implements the approved M-B plan under the binding decisions above. Backend
only — publish/schedule UI vocabulary still arrives with M-C/M-D (the M-A
language fence holds unchanged).

- **Manifest** (`social_publish_manifest`, migration `20260729100000`): one
  row per publish attempt; **the row id IS the provider `clientRef`**
  (decision 2 — it exists durably before any provider traffic). States:
  `queued → submitting → submitted → (live | verifying → live)`; guard
  failures → `held` (self-healing); `platform_failed` (accept envelope
  carried a platform error) and `failed` are terminal alongside `live` and
  `cancelled`. RLS creator-only, **no delete policy** (cancel, never delete).
- **Single write paths** (`manifestRepository.ts`, grep-fenced):
  `createPublishManifest` (only insert) · `transitionPublishManifest` (only
  status write — legal-edge table + optimistic `eq(status, from)`, version
  bumped every write) · `reschedulePublishManifest` (only content write —
  optimistic on version, queued/held only) · `bumpManifestAttempt`.
- **Workflow** (`publishService.ts`, deps-injected; advanced one edge per
  scheduler tick by `processPublishTick` — wired into
  `/api/marketing/scheduler/tick`, provider+encryption gated): guards run in
  order due → account health → monthly quota (ledger count) → send window
  (`DEFAULT_SEND_WINDOW`); then the durable `submitting` transition, THEN the
  one `provider.publish(clientRef)` call, then refs persisted immediately as
  their own transition. Ledger row on provider-ACCEPT, skipped on
  `platformError` (decision 4), **idempotent** by client_ref
  check-before-insert (a crash between refs and ledger replays safely).
- **Crash recovery (decision 2):** a row FOUND in `submitting` at tick start
  is a crashed/ambiguous prior run — recovery adopts refs via
  `listRecentPosts` (the new seam method over history limit=10) with a
  DELIBERATELY conservative matcher (exact composed-title + platform +
  success; a null title never matches — the field is unverified vendor
  surface), or fails after `RECOVERY_GRACE_ATTEMPTS` (3). The publish call is
  **never re-fired** (grep: exactly one `provider.publish(` call site).
- **Platform gate:** only Task 0a-proven platforms publish —
  `PROVEN_PUBLISH_PLATFORMS = linkedin + youtube` (`youtube_shorts` clip
  posts map onto the youtube connection); tiktok/instagram/facebook refuse
  honestly until Task 0b. Text = `composePublishText` (body + CTA +
  hashtags — byte-identical to the reviewed manual-copy composition); clips
  ride `video_path` bytes from the `clip-media` bucket.
- **Cancel/reschedule:** legal only while queued/held. Past `submitting`
  there is no recall (decision 1: no provider delete) — the refusal is
  honest (`past_submission`), not best-effort.
- **Tests:** `npm run verify:publish-path` (50 pure, in `npm test` — state
  machine goldens, guard order, decision-4 predicate, conservative recovery
  matcher, composition, and the fences: manifest writes confined, ONE
  publish call site, submitting-before-publish order, no scheduling params,
  no webhook reference, migration↔TS status drift guard, no delete policy) ·
  `npm run verify:publish-path:int` (61 vs live Supabase + fake provider —
  the full approved chaos list: sync/async lifecycles, platformError skips
  the ledger, permanent 4xx never retries, transient submit adopts-from-
  history or grace-fails with the call counter pinned at 1, ledger replay
  idempotency, quota/health/window holds all self-heal, cancel/reschedule
  legality + version conflicts + the concurrent-transition race, video
  publish via the youtube mapping, the refusal matrix, RLS both directions +
  owner-can't-delete).

## M-C — Approval governance: the card is the SOLE path (2026-07-30)

The preview-then-decide card is the only way anything publishes. Full AC
evidence in `verify-publish-path{,-int}`.

**Token design.** `social_publish_approval` = one row per card request
(creator click, agent `propose_publish_plan`, or a retry clone). At CARD
RENDER the server mints a single-use token (32 random bytes; only its sha256
is stored; 15-min TTL; re-render re-mints and invalidates the prior token).
Approve = ONE guarded UPDATE (`where token_hash=… and consumed/declined/
voided are null and expires_at > now`) — replay, expiry, decline-race and
void-race all lose in the same statement. The consumed approval is the only
thing `requestPublish` accepts (runtime assert), `manifest.approval_id` is
NOT NULL + **UNIQUE** (one approval → one manifest at the DB layer), and
`approved_via='card'` is check-constrained. Layers, outermost-in: grep fence
(manifest writes/`requestPublish` call sites) → runtime asserts → RLS → FK +
UNIQUE + check constraints.

**Invariants.**
- *Edit-voids, both directions:* every content edit rides
  `versionedUpdateSocialPost` (the single content-write path — including
  hook re-burns rotating `video_path`), which voids open approvals + live
  (queued/held) manifests, releases the durable sleep (cancel-by-event), and
  emits `social_publish_approval_voided`. The BELT: pre-submit the workflow
  re-hashes the CURRENT post row against `manifest.content_hash`
  (body+cta+hashtags+first_comment+video_path+image path) — a mismatch voids
  (`approval_stale`), never publishes. `voided` is terminal AND DB-immutable
  (BEFORE UPDATE trigger).
- *Retry (amendment):* only from `failed` (transient/ambiguous), via an
  approval-linked CLONE (`kind='retry'`, born consumed, chained to the human
  card approval) — no fresh card while the content hash still matches;
  `platform_failed` requires an edit → void → fresh card.
- *Frozen-source (amendment 2):* a clip post whose render job's take is no
  longer the lesson's current take (`pickCurrentVideoRow`) is refused at
  token mint AND held pre-submit (`source_superseded`).
- *Fire path (amendment 1):* Inngest durable function —
  `social/publish.requested` → `sleepUntil(scheduled_for)` (sleepUntil-
  precise, no cron quantization; P95 = delivery latency, well under 120s) →
  advance;  cancel/void/reschedule emit `social/publish.released`
  (`cancelOn` by manifestId). The M-B tick survives ONLY as the
  reconciliation sweep (Inngest cron `*/5`). Env: `INNGEST_EVENT_KEY` +
  `INNGEST_SIGNING_KEY`; dev = `npx inngest-cli@latest dev`.
- *Post states (amendment 3):* `posted_api` (workflow-stamped on live,
  DISTINCT from `posted_manual`) · `unpublished_local` (the unpublish valve:
  local mark only, the platform copy REMAINS LIVE — Task 0a, zero provider
  calls; per-platform manual-deletion guidance in `cardCopy.ts`).
  `mark_social_post_status` cannot forge either (schema-restricted).
- *Autonomy:* `publish_social_post` / `schedule_social_post` /
  `unpublish_social_post` are irreversible + HARD-DENIED — a card in manual,
  assisted AND auto; approved gate cards still only FILE review cards.
  `propose_publish_plan` is reversible (requests are inert; revert declines).
- *Card honesty (amendment 4):* first-comment support is per-platform —
  LinkedIn proven (0a), YouTube rendered as "may be skipped" until proven.
- *Language (AC-MC.4):* publish/schedule vocabulary lives ONLY under
  `components/marketing/publish/` + `app/(app)/marketing/publish/`; the
  social + accounts fences keep their original scan sets (path-scoped
  allowlist, no global unban — grep-asserted both ways).

**Threat cases considered:** token replay (atomic consume + UNIQUE
approval_id), stolen token cross-creator (RLS + owner check), expiry
(guarded UPDATE), TOCTOU edit-vs-approve (eager void + pre-submit re-hash +
status-lock race), forged manifest insert (assert + FK + no other write
path), forged posted_api (tool schema restriction), stale media (video_path
in the hash; re-burn = new content), stale card render (mint re-validates
hash + frozen fence and voids on drift), approve-all fat-finger (no such
affordance exists; per-card tokens).

## M-D — Queue/editor integration + language split (2026-07-31)

Publishing became visible and operable from the queue/editor — with ZERO new
creation paths (AC-MD.2: every entry point calls `requestPublishCard`; the
card modal renders the SAME `PublishApprovalCard` from the SAME
`cardPayload.ts` assembly the review page uses).

- **Queue states** (`components/marketing/social/connected/PublishStates.tsx`,
  data via the read-only `/api/marketing/social-posts/publish-state` +
  focus/visibility refresh — no polling): scheduled (fire time + countdown
  via `useSyncExternalStore` clock reads; cancel/reschedule = the M-C
  versioned transitions), held (human copy per reason + what self-heals it),
  posted_api (link-out + the manifest history drawer w/ approval lineage
  incl. retry parents), failed (typed reason + Retry — the A2 clone, no new
  card) vs platform_failed ("edit & re-approve"), voided (re-card CTA),
  cancelled/unpublished_local per M-C copy. AC-MD.6: posted_api stays
  distinct from posted_manual across queue labels, exports front-matter, and
  performance logging (which now accepts BOTH posted states, named).
- **Language split (AC-MD.5)**: `languageAllowlist.ts` = the 3 sanctioned
  path prefixes (publish components + route + `social/connected/`);
  verify-social skips ONLY that subtree (scan set otherwise unchanged);
  verify-publish-path proves both directions + Phase-1 copy byte-unchanged.
  The Phase-1 notice renders only where no connected affordance applies (its
  "never publishes" sentence, bytes intact, must not sit beside a publish
  control).
- **Dev banner (AC-MD.7)**: the banner TEXT is served exclusively by the
  dev-branch `/api/marketing/publish/dev-status` route (probes :8288) — it
  exists in no client chunk (bundle needle) and no component source (pure
  fence).
- **AC-MD.8 — first real delivery proof (Inngest dev server + a local
  Upload-Post stub via `UPLOAD_POST_API_BASE`; zero vendor traffic):**
  scheduled 16:43:12.709Z → live 16:43:35.48Z = **23s fire delay**
  (sleepUntil-precise; P95 target ≤120s met with room). Cancel-by-event:
  cancelled from the queue 75s pre-fire → past fire time the released run
  was a NO-OP (stub call count unchanged, manifest `cancelled`). SDK gotcha
  fixed en route: v4 requires `INNGEST_DEV=1` when serving unkeyed.
- **Design correction from the E2E**: the email-suite send window no longer
  gates connected publishing — a card-approved fire time (chosen instant or
  "immediately after approval") is AUTHORITATIVE. `send_window` survives
  only as a legacy hold-reason render.
- **Tests**: pure suite grew to 109 (guard change + mdFences: allowlist both
  directions, byte-snapshots, entry-point purity, banner confinement,
  no-setInterval countdown); int suite's window section now asserts the
  authoritative-fire-time semantics.

## M-AG — Agentic publishing: the workflow drivable from chat (2026-07-31)

Chat is a **new render surface for the SAME cards — never a new approval
path**. A creator can say "plan this week's posts" and the agent assembles
the plan, files the cards, the cards render INLINE in the conversation, and
every decision flows through `approvalService.approvePublishCard` exactly as
on the review page. Governance is byte-identical to M-C.

- **Toolset** (`lib/marketing/tools/publishOps.ts`): `get_connected_accounts`
  (read — accountId discovery + health + monthly usage; the publish tools'
  prerequisite) · `get_publish_status` (read — THE truth source: manifests
  with status/hold explanation/typed failure/postUrl + open cards; the prompt
  bans answering "did it go out?" from memory) · `retry_publish` (irreversible
  but NOT hard-denied — re-fires the A2 clone with the exact approved bytes,
  no new publish card; carded in manual/assisted, policy-optable in auto
  since the agent initiating a re-fire stays human-visible) ·
  `cancel_scheduled_publish` (irreversible, not hard-denied — queued/held
  only, honest refusal past submission; graded irreversible because a cancel
  cannot be un-done: cancelled is terminal and re-publishing needs a fresh
  card — the plan's earlier "reversible" recommendation was corrected at
  build time against the gate's revert contract). The M-C trio stays
  HARD_DENY. Autonomy registry + drift guard updated together.
- **Cards inline** — the loop detects freshly FILED approvals
  (`filedApprovalIds` in `agent/events.ts`: the three filing tools' outcome
  data ONLY — status reads never re-render cards), assembles payloads via the
  ONE `assembleCardPayload` (batch helper `assembleCardPayloadsForApprovals`
  in `cardPayload.ts`), and emits an additive `publish_cards` SSE event
  (tokens ride ONLY this ephemeral event, never conversation messages).
  `components/marketing/publish/ChatPublishCards.tsx` (allowlisted path —
  AgentPanel imports its publish-vocabulary strings instead of carrying any)
  mounts the SAME `PublishApprovalCard` wired to the SAME
  approve/rejectCardAction. Per-card decisions; no approve-all (fenced).
  `followUpFromEvents` folds the event so resumed runs replay cards too.
- **Cross-surface collapse** — `approvalSync` gained a `publish` kind keyed
  by approvalId; `PublishApprovalCard` itself subscribes + writes, so chat ↔
  review page ↔ other tabs collapse on any resolution (token consumption
  already guarded correctness; this heals the stale-card window). AC-AG.3 is
  structural: every render re-mints (last mint wins), consume is atomic —
  approving anywhere kills every other surface's token.
- **Honesty loop** — `social_publish_approval.conversation_id` (migration
  `20260731100000`, types spliced) is stamped by chat-filed cards
  (`ctx.conversationId` threaded through all three filing tools →
  `requestPublishCard`). Deciding such a card (chat host AND review page)
  fires `fetchPublishFollowUpAction` — decision derived from the approval
  ROW — which runs `resumeAgentAfterPublishDecision` (the FOURTH resume
  path in `agent/resume.ts`; `publishDecisionMessage` teaches queued-is-NOT-
  posted) in the SAME conversation; the wrap-up lands via the sync store and
  AgentPanel replays it. Prompt: DISCOVERY FIRST / STATUS TRUTH / inline-
  cards / retry+cancel semantics in the CONNECTED PUBLISHING section.
- **Discovery** — two publish chips on the hub ask-bar + the panel empty
  state, strings exported from the allowlisted chat host module.
- **Tests** — pure `agentic.spec` (36 checks: tiers, filing detection, fold,
  sync kind, fences incl. AgentPanel vocabulary-leak scan + one-assembly +
  token-never-persisted, threading, row-derived decisions, message honesty,
  prompt teaching, ops fences) and int `agentic.spec` (AC-AG.1 auto-mode
  agent turn → zero manifests + hard-deny belt; AC-AG.2 inline-card text
  byte-identical through to `publish()`; AC-AG.3 both directions; AC-AG.4
  same-conversation follow-up, truth-sourced answers, failure → A2-clone
  retry, policy-opted cancel). ⚠ timestamptz round-trips normalize ISO
  strings — match cards by approval id, compare fire times by epoch. ⚠ Run
  int suites with the Inngest dev server DOWN (live fire runs race the
  fake-provider ticks).

## Env

| Var | Meaning |
|---|---|
| `UPLOAD_POST_API_KEY` | provider key (server-only; linking disabled without it) |
| `SOCIAL_ACCOUNTS_ENC_KEY` | 32-byte base64 AES key (`openssl rand -base64 32`); linking hard-disabled when unset — no plaintext fallback |
| `SOCIAL_UPLOADS_PER_MONTH` / `SOCIAL_UPLOADS_WARN_AT` | usage meter overrides |
| `UPLOAD_POST_API_BASE` | test/staging override of the API base |

## Tests

- `npm run verify:accounts` (pure, in `npm test`) — the adapter against the
  **recorded Task 0a fixtures**, crypto round-trip/tamper, event drift guard,
  the language grep (no publish/schedule copy on this surface — literal-level
  extraction, so `lib/marketing/publish` import paths can't false-positive),
  vendor/secret/import fences, repository write confinement, usage thresholds.
- `npm run verify:accounts:int` (live Supabase + mock provider) — the RLS
  matrix both directions ×3 tables, idempotent profile creation, reconcile
  transition matrix, multi-account selection, disconnect, versioned-write
  conflict, event round-trip, ledger month-boundary counting + append-only.
- `npm run verify:accounts:bundle` (runs `next build`) — greps every client
  chunk for the env names, the vendor host, and the LIVE key values.

## Swapping to Postproxy (the fallback skeleton)

1. `lib/marketing/publish/provider/postproxyClient.ts` — implement
   `SocialPublishProvider` (the one vendor-HTTP file; mirror the
   `UploadPostError.permanent` taxonomy).
2. Point `getSocialPublishProvider()` (index.ts) at it — env-gated if both
   run side by side (`SOCIAL_PUBLISH_PROVIDER=postproxy`).
3. Re-record fixtures from a Postproxy verification spike (the Task 0a
   script pattern in `spikes/task0-upload-post/`) and add an adapter section
   to `verify-accounts.ts`.
4. Rows/events/UI are provider-agnostic already (`provider` column on every
   row); only `profile_ref` semantics may differ — keep it encrypted either
   way.
5. Delta watch-list when evaluating: linking-flow equivalent (hosted page or
   OAuth-per-platform?), result-ref retrieval, delete support, webhook
   signatures, real rate-limit headers.
