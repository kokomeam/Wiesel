# TUTOR-1 — Amendment A2, Wave 1 Checkpoint: Persistence & infrastructure

**Date:** 2026-08-06 · **Status:** Wave 1 COMPLETE → **HARD STOP.**
Built under the three approved Wave-0 rulings: **R-1** native ModelClient seam
(no AI SDK, no new runtime deps — still 22) · **R-2** prose-delta extraction
(design locked, lands Wave 2) · **R-5** lifecycle events on the SSE wire layer
only (the persisted analytics union gained nothing — asserted by test).

## 1. Acceptance criteria

| AC | Proof | Result |
| --- | --- | --- |
| A2-1 migration applies + rolls back cleanly | Applied live via MCP (`tutor_active_stream`); rollback proven **transactionally** against the seeded live DB (`begin; drop column ×2; rollback;` ran clean; columns intact after) | **PASS** |
| A2-2 `active_stream_id` nullable, defaults null | information_schema: both columns `text`, `is_nullable=YES`, `column_default=null` | **PASS** |
| A2-3 chain id persisted BEFORE first output token; abort keeps it provable | `verify-tutor-stream-int.ts` (**12/0**, live): a gated fake model emits `started` then BLOCKS; the test observes `tutor_threads.active_response_id` populated while zero output tokens exist; abort → both in-flight columns cleared, NO assistant row, and a following turn completes with `tutor_turns.response_id` set (chain intact). Pure leg: `verify-tutor-runtime.ts` A2 section (**71/0**) — aborted turns return the pre-abort id; a throwing hook can't kill a turn | **PASS** (as restated per approved R-4 — the early capture lands on `tutor_threads.active_response_id`; the immutable completed-turn `tutor_turns.response_id` semantics are byte-identical) |
| A2-4 new event variants parse; malformed rejects | `verify-tutor-stream-infra.ts` (**71/0**): all 10 wire variants parse; 8 malformed-payload rejects; exact SSE framing | **PASS** |
| A2-5 no delta/chunk variant in the event contract | Same suite: asserts `AnalyticsEventSchema`'s union member list equals the exact pre-A2 **22-member** set (extra AND missing both trip) + banned-substring scan (delta/chunk/stream/first_token/turn_*) | **PASS** — the persisted contract is untouched; `text_delta` exists only in the **wire** schema (transport frames, per §2's own rationale + approved R-5) |

**Repo gates (bare exits):** `tsc` **0** · `lint` **0** (1 pre-existing baseline
warning) · `npm test` **0** (now includes the new pure suite) ·
`verify:tutor:int` **0** — now **16 suites / 349 checks** · `build` **0** ·
`verify:budgets` **6/6** (learner route byte-identical 216.3 KB — Wave 1 is
entirely server-side).

## 2. What was built

- **Migration `20260806180000_tutor_active_stream.sql`** — `tutor_threads` +
  `active_stream_id text` (resume-buffer key, [FWD], no FK) +
  `active_response_id text` (in-flight provider response id). No index (the row
  is addressed by the existing unique (user_id, course_id) — no new query
  pattern, per the directive's no-speculative-index rule). Types SPLICED.
- **`lib/tutor/runtime/sseProtocol.ts`** — the server-side Zod wire contract:
  the 4 existing variants + `turn_started` / `model_started` / `first_token` /
  `text_delta` / `turn_completed` / `turn_aborted`, + `encodeWireEvent`. The
  client mirror stays zod-free (PERF-1 bundle rule); Wave 2 moves the route
  onto this schema.
- **`lib/tutor/runtime/streamBuffer.ts`** — the resume-buffer seam:
  `TutorStreamBuffer` interface, in-memory impl (dev/tests), **Upstash over
  REST via fetch — NO SDK** (the house Resend pattern), keys
  `wisesel:tutor:{id}:frames|:done`, **explicit TTL on every write**
  (default 600s, `TUTOR_STREAM_TTL_SECONDS`), env factory returning null when
  unconfigured (degrade: streaming works, resume 204s).
- **`lib/tutor/runtime/streamState.ts`** — best-effort (never-throw)
  `tutor_threads` in-flight writers: set/capture/clear/read.
- **Early chain-id capture (the seam, not a parallel system):**
  `ModelStreamEvent` gained `{type:"started", responseId}` (additive);
  `providers/openai.ts` forwards `response.created` (SDK shape verified
  against the installed `.d.ts`, not guessed); the mock emits it
  deterministically; the tutor loop's MAIN structured call flipped
  `stream:false → stream:true` with an event handler that stamps
  `lastResponseId` immediately and forwards every event to a new optional
  `RunTutorTurnDeps.onModelEvent` hook; the service wires the hook →
  `captureActiveResponseId` and clears in-flight state in a `finally`
  (completion, error, AND abort — A2-11 groundwork).
- **Env:** `.env.example` Upstash block (URL/TOKEN/TTL, degrade documented).
- **Test chains:** new pure suite added to `verify:tutor` (→ `npm test`); new
  int suite added to `verify:tutor:int`.

## 3. Files

**Created:** `supabase/migrations/20260806180000_tutor_active_stream.sql` ·
`lib/tutor/runtime/sseProtocol.ts` · `lib/tutor/runtime/streamBuffer.ts` ·
`lib/tutor/runtime/streamState.ts` · `scripts/verify-tutor-stream-infra.ts` ·
`scripts/verify-tutor-stream-int.ts` · this checkpoint.
**Modified:** `lib/database.types.ts` (splice) · `lib/ai/modelClient.ts` ·
`lib/ai/providers/openai.ts` · `lib/ai/providers/mock.ts` ·
`lib/tutor/runtime/loop.ts` · `lib/tutor/runtime/service.ts` ·
`scripts/verify-tutor-runtime.ts` · `package.json` · `.env.example`.
**Deleted:** none.

## 4. Deviations (each justified)

1. **`tutor_threads`, not `tutor_sessions`** — the directive's table doesn't
   exist; its own escape hatch applies (audit §2).
2. **Two columns, not one** — the approved R-4 satisfier needs a distinct
   `active_response_id`: the stream key must exist from request start, the
   response id only exists after `response.created`; merging them would leave
   pre-created frames unkeyed.
3. **Lifecycle variants live on the wire layer** (approved R-5), named
   snake_case-flat to match the existing wire (not the directive's dot-form);
   `model_started` added beyond the directive's four — it is §6's `thinking`
   trigger (`response.created`) and the carrier of the early chain id;
   `text_delta`'s schema is defined now, emitted in Wave 2.
4. **No `resumable-stream`, no Upstash SDK** — approved R-1/R-7: the adapter
   is fetch-based (house pattern); runtime deps stay 22. Same GET/204 resume
   semantics land in Wave 2 on this seam.
5. **The two fallback re-ask calls stay `stream:false`** (rare repair path;
   one-line comments mark them; Wave 2 revisits with the delta extractor).
6. **`captureActiveResponseId` takes `string`, the event carries
   `string|null`** — the service null-guards the call (nothing to persist for
   a null id); interface left frozen rather than churned mid-wave.
7. **Chain-gap fix (pre-existing, disclosed):** `verify-tutor-route-int.ts`
   and `verify-tutor-mastery-int.ts` were in NO package.json chain (run ad hoc
   in prior waves). Both verified green today (32/0 · 47/0), then wired into
   `verify:tutor:int` alongside the new stream int suite (13 → 16 suites).

## 5. Risk-profile updates for later waves

- **Upstash is not yet provisioned** (operator action, ~2 min at
  console.upstash.com; paste the two vars). Until then resume degrades
  gracefully; the adapter is fully fake-fetch tested. Wave 2's A2-7
  (kill-and-resume) needs the real instance for its live leg.
- **§8's BEFORE metrics must be captured before Wave 2 lands** — the buffered
  behavior disappears with Wave 2's route change. Wave 2 must open by
  measuring the before-leg (same prompt, 5 runs, real model) or the comparison
  requires an old-commit checkout.
- **Streaming the structured call is now live in production paths** (the main
  tutor call runs `stream:true`): all 16 int suites + the route regression
  passed, but Wave 2's route work should watch for provider-side differences
  under real load (the pure/int mocks can't prove provider behavior).

**Awaiting approval to proceed to Wave 2.**
