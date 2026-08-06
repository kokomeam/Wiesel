# TUTOR-1 — Amendment A2, Wave 0: Streaming audit (read-only)

**Date:** 2026-08-06 · **Status:** Wave 0 COMPLETE → **HARD STOP.**
No repository file was modified in this wave; this document is the sole
deliverable. Every answer carries a file:line reference; absences are stated as
**NOT FOUND**, never inferred. (Method: six parallel read-only auditors over
disjoint question sets; the two load-bearing claims — buffered delivery and the
chain-id write site — were independently re-verified against the source.)

> **Premise corrections up front.** Two of the directive's stated premises are
> stale against this repo: (1) the dependency line "blocked on P-1 repo
> reconciliation" — P-1 was completed inside TUTOR-1 Wave 1; all six waves are
> shipped and pushed (`b4b8910`). (2) The turn does NOT run in Inngest and never
> has — it is already a Node route handler streaming SSE. What A2's objective
> gets exactly right: the ANSWER is buffered — one structured model call, one
> whole-turn SSE event. §A0-1b below is the proof.

---

## 1. Audit answers

### A0-1 — Where does a tutor conversational turn execute?

**A route handler.** `POST` in `app/api/learn/tutor/route.ts:135`; the `turn`
action calls `runTutorTurnForRequest` (route.ts:343-357) →
`lib/tutor/runtime/service.ts:546` → the pure loop `runTutorTurn`
(`lib/tutor/runtime/loop.ts:217`). It is not a server action (the route is the
only caller, repo-wide grep). **No Inngest function executes conversational
turns** — `lib/inngest/functions/*` contains only background jobs
(tutorGraph, tutorMastery, tutorLessonHealth, tutorEscalation,
creatorDigestNightly, publish); grep for `runTutorTurn*` across `lib/inngest/`
returns zero. The §2 "MUST NOT route through Inngest" invariant is already
satisfied; Wave 2 changes the delivery shape of an existing route, not the
execution home.

**A0-1b — delivery shape (the objective's factual basis).** The transport is
SSE but the answer is **BUFFERED**: the loop's model call is a strict-JSON
structured call with `stream: false` and a noop event handler
(`lib/tutor/runtime/loop.ts:416-433`), `responseFormat = tutor_turn_output`
over `TurnOutputSchema` (loop.ts:392-395), parsed only after the call returns
(`parseTurnOutput(result.text)`, loop.ts:442-445). The route then emits the
whole answer as ONE `turn` SSE event (route.ts:366-380 — the comment is
explicit: *"ONE structured call this wave — the whole turn is emitted as a
single `turn` event (NO fake token deltas; streaming deltas land in a later
wave)"*). SSE event order today: zero-or-more `queued` (learner-pool wait,
route.ts:329-333) → exactly one `turn` | `error` → always `done` (finally,
route.ts:390-391).

### A0-2 — `previous_response_id`: where read/written, which column, when?

Column: **`tutor_turns.response_id` (text)** — migration
`supabase/migrations/20260804100000_tutor_threads_charter.sql:79` (*"provider
response id when TUTOR_ENABLE_CHAINING stores turns — the P-3 seam"*).
**Written at turn COMPLETION, not before first token:** the loop tracks
`lastResponseId` across rounds (loop.ts:411, 435, 489, 521; returned at :629)
and the only DB write is `persistAssistantTurn`
(`lib/tutor/runtime/service.ts:201-231`, `response_id: args.responseId` at
:226), invoked only on a completed ok turn (service.ts:620-640; doc at 198-199:
*"Called ONLY on a COMPLETED turn: an abort persists nothing
assistant-side"*). **Read:** `loadThreadHistory` selects it (service.ts:244,
252) → `collapseToChaining(ctx.historyTurns)` (loop.ts:367) → sent as
`previousResponseId` when chaining is on (loop.ts:430). Chaining is **OFF by
default** (`lib/tutor/runtime/history.ts:47-66`, P-3 pending; asserted by
`scripts/verify-tutor-runtime.ts:753-754`).

### A0-3 — Does message persistence use the versioned-update repository function?

**NOT FOUND — and structurally inapplicable.** The tutor transcript is
**append-only inserts**: `persistLearnerTurn` (service.ts:191) and
`persistAssistantTurn` (service.ts:228) both
`admin.from("tutor_turns").insert(row)`; zero `.update()` calls on
`tutor_turns` anywhere in `lib/**`/`app/**`. No versioned-update function for
tutor messages exists (the only optimistic updater in `lib/tutor` is
`versionedUpdateConceptNode`, `lib/tutor/graph/repository.ts:217` — concept
graph, not transcript). Append-only is **DB-enforced**: a BEFORE UPDATE
always-raise trigger `private.enforce_tutor_turns_immutable`
(migration 20260804100000:84-93; table comment :257), learner inserts
role-pinned by RLS, assistant/instructor rows service-role-only. ⇒ The §2
invariant translates for this surface as: *the append-only insert pair remains
the only legal write path*; a 409 re-read/re-apply cycle cannot exist on an
immutable table. A2-12's acceptance criterion needs restating accordingly.

### A0-4 — Current loading UI for a tutor turn

`components/learn/tutor/TutorBody.tsx` (presentation) over
`lib/learn/useTutorStream.ts` (state machine). Between send and answer:
optimistic learner bubble + `ThinkingRow` — three pulsing stone dots,
`aria-label="Thinking"` (TutorBody.tsx:380-391); a `queued` event swaps it for
"*N* ahead of you…" (TutorBody.tsx:296-299). The assistant bubble lands **all
at once** on the single `turn` event (useTutorStream.ts:256-258). Client status
machine `TutorStreamStatus` = `idle | thinking | queued{position} |
error{message}` (useTutorStream.ts:48-52) — no `composing` phase, because no
signal exists to drive one. Error renders a `role="alert"` rose card + Retry
(TutorBody.tsx:300-316); abort renders nothing (silent return to idle,
useTutorStream.ts:306-311; no learner-facing Stop control). Reduced motion IS
respected (TutorBody.tsx:55, 79, 380-383 + the global CSS guard,
app/globals.css:135-146). **`aria-live`: NOT FOUND** — phase changes are not
announced (a real gap A2 Wave 3 fixes). `TUTOR_TTFT` today stamps **first bytes
off the wire, not first token**: `markFirstFrame()` on the first
`reader.read()` chunk (useTutorStream.ts:241-245 → `emitTutorTtft`,
lib/learn/tutorVitals.ts:41-56) — under the buffered design, first bytes ≈ the
whole answer (or a `queued` frame), so the current metric does not measure
model TTFT. Baseline for §8 must note this.

### A0-5 — Redis / Upstash provisioned?

**NOT FOUND.** Zero hits in `package.json`, `.env.example`, `.env.local`,
`lib/**`, `app/**` for upstash/UPSTASH/KV_/redis-as-code. The single mention is
a doc comment naming Redis as a hypothetical rate-limiter upgrade path
(`app/api/analytics/ingest/route.ts:22-26`). (Lockfile-only
`@opentelemetry/instrumentation-redis*` entries are transitive, never
imported.) A2 Wave 1 would introduce the stack's first Redis: new infra, new
secrets, new deps.

### A0-6 — `maxDuration` / runtime on the tutor route; plan ceiling

`export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"`
(route.ts:22-23). **`maxDuration`: NOT FOUND** on the tutor route (the repo's
only one is `app/api/marketing/clips/tick/route.ts:29`, 300). `vercel.json`
declares only a cron — no `functions`/duration block; `next.config.ts` none.
**The deployed Vercel plan ceiling is not determinable from the repo.** The
route self-imposes an in-process deadline: `AbortSignal.timeout(tutor_turn
timeoutMs + 15s)` (route.ts:307-312), i.e. ~45s with the default 30s
(`lib/ai/modelConfig.ts:319-324`) — an application abort, not a platform
duration.

### A0-7 — Zod tutor event variants; lifecycle coverage

Two distinct layers — the directive's "the existing Zod discriminated-union
event contract" matches only the second:

1. **SSE wire protocol: NOT a Zod contract.** A plain TS union `TutorSSEEvent`
   inline in the route (route.ts:44-62): `queued | turn | error | done`,
   encoded `data: ${JSON.stringify(event)}` (route.ts:64-66). The client is a
   **deliberately zod-free mirror** (`lib/learn/tutorClientTypes.ts:86-90`;
   header rule :6-7 — *"NEVER import zod … the learn route bundle must stay
   schema-free"*, a PERF-1 bundle-budget invariant, drift-guarded by
   `scripts/verify-tutor-client.ts`), parsed by unvalidated cast
   (useTutorStream.ts:96-110).
2. **Persisted analytics contract** (`lib/analytics/events.ts`, the Zod
   discriminated union + DB CHECKs): exactly two `tutor_*` variants —
   `tutor_model_call` (:179-195) and `tutor_inference` (:269-273), plus the
   tutor-evidence trio practice_answer/hint_request/self_report (:225-251) and
   `content_engagement`. DB allowlist: migration 20260803110000:29-40; job_type
   CHECK six values (20260806160000:24-30). `TUTOR_TTFT` is a perf_vital
   METRIC, not an event type (20260804110000:23-28).

**Turn-lifecycle coverage: all four A2-required variants are ABSENT in both
layers.** started — absent (`queued` fires only on pool wait); first_token —
absent (no delta exists); completed — implicit only (`turn`+`done`); aborted —
folded into generic `error` ("The turn was cancelled.", route.ts:385-388),
indistinguishable by type. **Delta/chunk variant: NOT FOUND anywhere** (route
header states it; greps across both layers corroborate; the only "chunk" hits
are graph-extraction text chunking).

### A0-8 — Learner authorization helper

`resolveTutorAccess(admin, { userId, courseId }): Promise<TutorAccess>` —
`lib/tutor/runtime/service.ts:83-117`; kinds `ok | not_enrolled |
author_preview | disabled` (:59-63). Ordered gate (:72-77, 89-116): explicit
`enabled=false` ⇒ disabled (no row = on by default, per the 2026-08-06
follow-up) → author ⇒ author_preview (never emits evidence) → active/completed
enrollment ⇒ ok → not_enrolled. Route call: route.ts:165-166 (*"The ONE access
gate — every action goes through it"*); defensively re-resolved in the service
(:550-553, short-circuit :566). Thread ownership: `ensureThread`
(service.ts:127-149) keyed to the authenticated (userId, courseId), only after
'ok'; `tutor_threads` RLS is learner-own + enrollment-gated, no author policy
(migration 20260804100000:215-220). **A2's GET resume handler must reuse
exactly this gate.**

### A0-9 — Tutor tools and irreversibility tiers

Five tools (`TUTOR_TOOL_NAMES`, `lib/tutor/runtime/tools.ts:59-65`; exposed at
loop.ts:386-390):

| Tool | Effect | Explicit tier |
|---|---|---|
| `get_lesson_context` | read-only (snapshot) | **none — flagged** |
| `get_mastery_summary` | read-only (own-rows RPC) | **none — flagged** |
| `generate_practice` | no DB write (one structured model call; items live only for the turn) | **none — flagged** |
| `emit_evidence` | writes nothing (validates; the ROUTE emits post-turn — tools.ts:22-29) | **none — flagged** |
| `propose_escalation` | **the one mutating tool** — service-role insert of a `consent_pending` escalation candidate (tools.ts:431-488) | **none — flagged** |

**No tier table exists for tutor tools** (nothing like
`lib/marketing/gate.ts`; the `tutor_action` reversibility ledger in
`lib/tutor/graph/entities.ts:114-144` belongs to the creator-side graph
editor and is never invoked by these five). **No tool can pause the loop
today** — the ≤3-round loop (loop.ts:168-169, 449-462) executes tools inline;
zero approval/pause hits in the runtime. Escalation is learner-consent, not
tool approval: the candidate is born `consent_pending`, the turn completes,
and consent arrives as a separate `escalate_consent` request
(route.ts:228-282). Note for Wave 2: on today's inventory the `irreversible`
tier is **empty** (even `propose_escalation` is consent-gated and
learner-revocable) — A2-9 will need a synthetic irreversible tool in tests,
and the fail-closed catch-all is the real payoff.

### A0-10 — AI SDK packages present?

**All three NOT FOUND** — `ai`, `@ai-sdk/openai`, `@ai-sdk/react` appear
nowhere in `package.json` (full read). Runtime dependencies today: **22**
(package.json:108-131 — @dnd-kit ×3, @remotion ×3, @supabase ×2, ffmpeg-static,
framer-motion, inngest, lucide-react, next, openai, react, react-dom, remotion,
resend, shiki, web-vitals, zod, zustand). The dep-count invariant lives in
CLAUDE.md/docs as policy; **no executable dep-count assertion exists in
scripts/ (NOT FOUND — verified)**. Related fact (seam integrity): the `openai`
SDK is imported in exactly one file, `lib/ai/providers/openai.ts:12`; the tutor
obtains its model via `withPooledModel(createOpenAIModelClient(), { pool:
poolFor("learner"), cost: { jobType: "tutor_turn" } })` (route.ts:329-341) —
cost telemetry, the learner pool, and the global semaphore all hang off this
seam.

---

## 2. Migration surface

A2 touches **one table: `tutor_threads`** (the directive's `tutor_sessions`
does **NOT exist** — NOT FOUND in migrations and `lib/database.types.ts`; the
per-(learner, course) conversation row is `tutor_threads`, migration
20260804100000:40-47: id, user_id, course_id, created_at, updated_at, unique
(user_id, course_id)). Wave 1's single column lands there as
`tutor_threads.active_stream_id text` (nullable, no FK, no index yet — no
current query pattern needs one; the row is always fetched by the unique
(user_id, course_id) key). No column resembling it exists today (NOT FOUND).
`tutor_turns` needs **no schema change** — but note its BEFORE-UPDATE
immutability trigger constrains the chain-id design: the "write the chain id
before the first token" requirement cannot target the assistant turn row
(it does not exist yet mid-stream, and rows are immutable once written), so
the early write must land on `tutor_threads` (e.g. alongside
`active_stream_id`) or be dropped as unnecessary — see risk R-4. The
analytics layer needs **no new table**; if any lifecycle event is persisted it
must ride the existing `learning_events` allowlist CHECK (one migration line),
subject to the §8 rows-per-turn contradiction in risk R-5. Types must be
SPLICED into `lib/database.types.ts` (never full-regen — live drift rule).

## 3. Risk register

**R-1 · The prescribed vehicle collides with three repo invariants — a ruling
is required before Wave 1.** Wave 2 mandates `streamText` +
`openai.responses()` (Vercel AI SDK) and Wave 3 mandates `useChat`; Wave 1 adds
`resumable-stream` + an Upstash client. That is ≈+5 runtime dependencies and,
more seriously, a **second model-call path** that bypasses `withPooledModel` —
losing the learner pool, the global ≤2 semaphore, per-call cost telemetry
(`tutor_model_call` rows and the console cost card go dark for turns), and the
proxy-scoped transport (the AI SDK's fetch would resurface the ~75s
proxy-bypass timeout this repo already fought). It also breaks the
one-openai-import seam (A0-10) and §2's own "no parallel systems" rule. **A
native path exists and is already built:** `ModelClient.runTurn` streams —
`client.responses.stream(...)` forwards `response.output_text.delta` as
`ModelStreamEvent {type:"text_delta"}` (`lib/ai/providers/openai.ts:451-470`,
`lib/ai/modelClient.ts:49-50, 208`); the tutor loop simply passes
`stream:false` + a noop today (loop.ts:416-423). Flipping the final call to
`stream:true` and forwarding deltas over the existing SSE channel satisfies
both A2 outcomes with zero new dependencies and every invariant intact. The
directive's MUSTs as written cannot be reconciled with §2's "extend existing
patterns"; Wave 0 flags the conflict rather than silently deviating.

**R-2 · Token streaming meets a structured-output contract.** The answer is
not free text: `TurnOutputSchema` (prose + grounded spans + citations +
practice items + escalation), validated post-hoc (grounding, canon
suppression, citation resolution — loop.ts:535-585). Streaming raw
`output_text` deltas streams **JSON**, not prose; the learner-visible text is
the `prose` field inside it. Wave 2 needs one of: (a) an incremental extractor
that forwards only `prose` string content as display deltas (server-side,
cheap, keeps the contract byte-identical — recommended); (b) restructuring the
output into streamed text + a structured trailer (contract change, touches
grounding validation); or (c) schema field reordering so `prose` streams
first (prompt-level, fragile alone, useful with (a)). Grounded span/citation
rendering necessarily lands AFTER validation completes — the stream shows
plain prose that upgrades to grounded rendering at finalize. This is the
central design decision of Wave 2 and should be approved explicitly.

**R-3 · `tutor_sessions` does not exist.** Use `tutor_threads` (§2). Deviation
noted per the directive's own escape hatch.

**R-4 · The chain-id early-write premise needs re-examination.**
A2-3 assumes an abandoned turn breaks the chain. Today an aborted turn
persists **nothing** assistant-side (by design), so the next turn chains from
the last COMPLETED turn — with chaining OFF by default (P-3) the history is
textual replay and nothing is lost; with chaining ON the chain is equally
intact (it skips the aborted response). Writing the in-flight response id
early is still useful — but only as a resume/observability handle on
`tutor_threads`, NOT as a `tutor_turns` write (immutability trigger, R-3/§2).
Recommend: satisfy A2-3 as "the in-flight response id is captured on
`tutor_threads` before first token," leaving the completed-turn
`tutor_turns.response_id` semantics untouched.

**R-5 · Internal contradiction: lifecycle events vs the §8 failure condition.**
§8 declares any increase in event-stream rows per turn a **failure**; Wave 1
mandates four new lifecycle variants. If those persist to `learning_events`,
every turn adds +3–4 rows — automatic §8 failure. Resolution needed at
approval: lifecycle variants belong on the **SSE wire layer** (transport
frames, ephemeral — started/first_token/aborted), with at most `completed`
folding into the existing `tutor_model_call` row (it already carries latency +
usage). Also note the naming mismatch: `tutor.turn.*` dot-form vs the
snake_case DB allowlist — wire-layer naming is free; DB naming is CHECKed.

**R-6 · The zod-free learn client is a guarded invariant.** The directive says
"extend the existing Zod discriminated union"; the wire union is deliberately
NOT Zod on the client (`tutorClientTypes.ts:6-7`, PERF-1 bundle budget,
drift-guarded). Zod-validating outbound frames server-side is fine; the client
must stay a cast-based mirror. Wave 3's `useChat` (`@ai-sdk/react`) would also
replace `useTutorStream` + `TutorBody`'s rich turn model (grounded spans,
citations, practice cards, escalation consent) with a text-parts chat
abstraction — a redesign, not a swap; the native alternative (extend
`useTutorStream` with delta/status events + the `TutorStatusPhase` component
exactly as specified in §6) meets every Wave 3 AC except the literal "MUST use
useChat".

**R-7 · Redis is new infrastructure.** First Redis in the stack (A0-5):
provisioning, two secrets, TTL policy, and a defined degrade mode (dev without
Redis must still stream — resume becomes unavailable, not the turn). Cost is
trivial at current scale; operational surface is not. If R-1 resolves to the
native path, resume can ride a thin buffer keyed by `active_stream_id`
(`wisesel:tutor:` prefix, explicit TTL) without `resumable-stream`'s AI-SDK
coupling — same GET/204 semantics.

**R-8 · No `maxDuration` today; plan ceiling unknown (A0-6).** Wave 2 must set
it explicitly; the value must be chosen against the actual deployed plan
(not determinable from the repo — needs a one-line answer from the operator).
The in-process 45s deadline also needs rethinking for streaming (per-chunk
stall timeout replaces whole-turn abort as the learner-facing guard).

**R-9 · Uncommitted prior work in the tree.** The 2026-08-06 "tutor on by
default" change (12 files + checkpoint, all gates green) is complete but
uncommitted, awaiting the creator's go-ahead. A2 waves touch overlapping files
(route.ts, service.ts, useTutorStream.ts, TutorBody.tsx). The pending work
should be committed (or explicitly parked) before Wave 1 lands anything, or
the two changes interleave in the diff.

**R-10 · Baseline metrics semantics (§8).** Today's TUTOR_TTFT measures first
BYTES (frequently ≈ the full answer; a `queued` frame also stamps it) — the
before/after table must measure "time to first visible output" at the same
point in both runs (first rendered text character), not reuse the existing
vital as-is.

---

## 4. Checkpoint report (§9)

1. **Wave 0 — COMPLETE.** Read-only; no repository file modified other than
   creating this audit document.
2. **Acceptance criteria:** none in scope for Wave 0 (audit wave). All ten
   audit questions answered with file:line evidence above; NOT FOUNDs explicit
   (A0-3 versioned-update, A0-5 Redis, A0-6 maxDuration, A0-7 lifecycle
   variants + delta variant, A0-9 tier table, A0-10 all three packages,
   tutor_sessions, active_stream_id).
3. **Files created:** `docs/audits/TUTOR-1-A2-streaming-audit.md`. Modified:
   none. Deleted: none.
4. **Deviations:** none from the Wave 0 mandate. Premise corrections
   (route-not-Inngest already true; P-1 long complete; `tutor_sessions` →
   `tutor_threads`) are documented, not silently absorbed.
5. **Risk profile for later waves:** R-1 (vehicle vs invariants — needs a
   ruling), R-2 (structured-output streaming design — needs an approach
   approval), R-5 (lifecycle-events layer vs §8 — needs a layer decision) are
   the three that change Wave 1/2 as written. R-9 (uncommitted prior work)
   needs a git decision before any A2 commit.
6. **Awaiting approval to proceed to Wave 1.**
