# Tutor streaming — turns, phases, resume (Amendment A2)

> How a tutor conversational turn streams to the learner, how it survives a
> refresh, how tool approval is governed, and what it costs. Shipped across
> A2 Waves 0–4 (audit: `docs/audits/TUTOR-1-A2-streaming-audit.md`;
> per-wave checkpoints: `TUTOR-1-A2-wave{1..3}-checkpoint.md` + the Wave 4
> close). Companions: `runbook.md` (flags/ops), `architecture.md`.

## The Inngest boundary — why the turn is NOT durable

A learner-facing conversational turn runs in the **route handler**
(`app/api/learn/tutor/route.ts`, Node runtime, `maxDuration = 300`) — never
in Inngest. Inngest steps return serialized results on completion and cannot
emit incremental output to a watching browser; it remains the fire-time
authority for **scheduled** work only (graph extract/reconcile, mastery
nightlies, lesson health, escalation reconcile, digests). A synchronous turn
initiated by a watching human is not scheduled work.

Consequence: the turn is **not durable** — if the serverless invocation dies
mid-turn (deploy, crash, platform eviction), the turn dies with it. That is a
deliberate trade: the learner is WATCHING; the recovery story is a retry (the
learner's message is already persisted — `persistLearnerTurn` runs before the
model dispatch) plus the resume buffer below for the common case (refresh /
navigation, where the invocation is still alive). What IS durable: the
transcript (append-only `tutor_turns`, BEFORE-UPDATE-raise trigger), evidence
events (deterministic ids, re-emit = no-op), and the completed-turn chain id
(`tutor_turns.response_id`).

**Disconnect is not a stop.** The route composes its abort from the total
deadline + the stall watchdog ONLY — `req.signal` is deliberately absent. A
refresh/navigation closes the HTTP leg; the turn keeps running server-side,
frames keep teeing into the buffer, and the answer persists to the
transcript. No stop endpoint exists on the cleanup path.

## The wire protocol

Server truth: `lib/tutor/runtime/sseProtocol.ts` (Zod; the route validates
what it emits). Client mirror: `lib/learn/tutorClientTypes.ts` — **zod-free
by the PERF-1 bundle rule** (drift-guarded by `verify-tutor-client`).

Emission order per turn:

```
turn_started {streamId, ts}
model_started {responseId}            ← response.created (reasoning begins)
first_token {ttftMs}                  ← first prose char extracted
text_delta {delta}×N                  ← marker-stripped PLAIN prose
turn {payload} + turn_completed {...} ← the settled grounded answer
    | error {message} [+ turn_aborted {reason, tokensEmitted}]
    | approval_required {toolName, message}
done
```

Lifecycle + delta frames are **transport frames, not facts** — they are never
persisted. The analytics union is assertion-locked at its pre-A2 22 members
(`verify-tutor-stream-infra`); a streamed turn writes exactly what a buffered
turn wrote (1 × `tutor_model_call` per model call + model-chosen
`tutor_inference` evidence + the two transcript rows).

**Prose extraction (R-2):** the model's answer is a strict-JSON structured
output (`TurnOutputSchema`) whose first field is `proseWithSpanMarkers`.
`lib/tutor/runtime/proseExtractor.ts` incrementally extracts ONLY that
field's string value from the raw JSON delta stream — decoding escapes and
stripping the `⟦g⟧…⟦/g⟧`/`⟦s⟧…⟦/s⟧` span markers even when split across
chunk boundaries — so the learner sees clean prose while it is written.
Grounded rendering (spans/citations/practice) upgrades at settle, from the
validated `turn` payload. The output contract is byte-identical to pre-A2.

## The resume lifecycle

1. POST turn: the route mints `streamId`, writes
   `tutor_threads.active_stream_id` BEFORE dispatch, and tees every encoded
   frame into the buffer (`lib/tutor/runtime/streamBuffer.ts`). The provider
   response id is captured onto `active_response_id` at `response.created` —
   before the first output token.
2. On settle (completion, error, abort — one `finally`): buffer finalized,
   both in-flight columns cleared. The clear is the guaranteed-last write
   (the capture promise is awaited first — a race the Wave-2 tests caught).
3. GET `/api/learn/tutor?courseId=…`: same auth gate as POST (401 anonymous,
   403 not-enrolled/preview/disabled), then `active_stream_id` → **204** when
   idle or the buffer is unconfigured; otherwise an SSE replay of the
   buffered frames VERBATIM from 0 (byte-identical ⇒ gap/dup-free by
   construction) + a 400ms-poll live tail (`streamResume.ts · followStream`)
   until finalized.
4. The client (`useTutorStream`) auto-resumes once per mount after history
   loads. 204 with an unanswered learner question at the transcript tail ⇒
   one ~3s history re-load (the turn usually completed server-side — the
   common real-world path, observed in the live browser proofs).

**Buffer backend:** Upstash Redis over its REST API via `fetch` — NO SDK (the
house Resend pattern; runtime deps unchanged at 22). Keys
`wisesel:tutor:{streamId}:frames|:done`. **TTL is explicit on every write**
(`TUTOR_STREAM_TTL_SECONDS`, default 600) — never a package default. Both
env vars unset ⇒ graceful degrade: turns stream normally, GET answers 204.

## Timeouts (`lib/tutor/runtime/streamConfig.ts`)

| Knob | Value | Owner |
| --- | --- | --- |
| `totalMs` 240s | whole-turn deadline | the route (`AbortSignal.timeout`) |
| `stepMs` 90s | per-model-call deadline | `TUTOR_MODELS.tutor_turn.timeoutMs` |
| `chunkMs` 20s | stall watchdog — no model event for 20s while streaming ⇒ abort as `turn_aborted{reason:"stalled"}` | the route |
| `maxDuration` 300 | the platform ceiling declaration | the route export |

## The tool tier table — how to add a tool

`lib/tutor/runtime/toolTiers.ts` is the single approval authority:
`read | reversible | irreversible`, exhaustively typed over
`TUTOR_TOOL_NAMES`. `tierOf(unknownName)` returns **irreversible — fail
closed**. The gate runs in the loop BEFORE dispatch and before the
unknown-tool error path: an irreversible-tier call executes NOTHING, halts
the loop, and surfaces `TutorTurnResult.approvalRequired` → the
`approval_required` wire frame → a dormant amber notice client-side. A gated
turn persists no assistant row and emits no evidence.

Adding a tool = three steps, two of which fail loudly if skipped:
1. Add it to `TUTOR_TOOL_NAMES` + implement in `tools.ts`.
2. Classify it in `TUTOR_TOOL_TIERS` — skipping this is a **compile error**
   (the Record is exhaustively keyed) AND a **test failure**
   (`verify-tutor-runtime`'s A2-10 section; `npm test` is the CI gate).
3. If it is irreversible: the approval flow needs its preview-then-decide
   integration (the `[FWD]` below) — until then the tool simply gates.

Current classification: the four read/validate-only tools are `read`;
`propose_escalation` is `reversible` (a consent-pending insert the learner
gates + can withdraw). **No tutor tool is irreversible today** — the gate is
dormant but load-bearing for every future tool.

## The status phase contract

`components/learn/tutor/TutorStatusIndicator.tsx` — standalone, zero timers
(asserted over its source by `verify-tutor-status-ui`):

```ts
type TutorStatusPhase =
  | { kind: "sent" }        // request dispatched      → "Sending your question"
  | { kind: "thinking" }    // response.created        → "Working through it"
  | { kind: "composing" }   // first prose delta       → "Writing your answer"
  | { kind: "tool"; label: string };  // [FWD] — reserved, unpopulated in A2
```

Every transition is driven by a real stream event; the 400ms display floor
(`lib/learn/phaseFloor.ts`, in the HOOK — the component has no timers) only
delays display of an already-real phase, never invents progress. Errors and
approvals bypass the floor. `aria-live="polite"` + `role="status"`;
reduced-motion renders static text. Copy standard (§7): sentence case, no
terminal punctuation, generic truthful wording — a label may never name a
data source that isn't actually being read this turn. The `[FWD]` `tool`
variant is where truthful tool-derived labels bolt on in a later amendment
without touching the component.

## Cost profile

- **Redis:** ~a dozen-to-few-hundred small frames per turn, TTL 600s, one
  active stream per (learner, course). At 1,000 active learners × 20
  turns/month this is well inside Upstash's free tier (≤ a few hundred MB-s
  of ephemeral storage + ~1–2 commands per frame); the paid tier's
  per-command pricing would put it at cents/month. The buffer is
  best-effort — Redis down never blocks a turn.
- **Model:** unchanged by streaming (same call, same tokens). The §8
  measured medians (same instrument, same prompt, real model — see the Wave
  2 checkpoint): time to first visible output **14,915 → 10,767 ms**; full
  answer unchanged; zero new persisted rows/bytes (the union lock + the
  wave-diff grep are the §8 compliance proof; the sampled deltas were timing
  artifacts, analyzed there).
- The remaining pre-token gap is **reasoning time** at medium effort — the
  provider emits no visible output until reasoning ends. The truthful
  "Working through it" phase covers it; streaming reasoning-summary deltas
  is the documented `[FWD]` lever if the gap should shrink.

## Test map

| Layer | Suite |
| --- | --- |
| Wire schema + buffer + A2-5 union lock | `verify-tutor-stream-infra` (pure) |
| Prose extractor | `verify-tutor-prose-extractor` (pure) |
| Tiers + gate + floor + frame reducer | `verify-tutor-runtime` · `verify-tutor-client` (pure) |
| Indicator source + copy lint | `verify-tutor-status-ui` (pure) |
| Capture/clear/abort/resume vs live DB | `verify-tutor-stream-int` (live Supabase) |
| e2e: phases → incremental text → completion; refresh-resume; a11y; reduced motion; GET auth matrix | `verify:tutor:browser:stream` (Playwright vs a running server, real model + Upstash) |
| §8 metrics instrument | `scripts/measure-tutor-turn-metrics.ts` (`METRIC_LEG=after` for the streamed leg) |
