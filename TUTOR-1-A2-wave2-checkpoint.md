# TUTOR-1 — Amendment A2, Wave 2 Checkpoint: The streaming route

**Date:** 2026-08-06 · **Status:** Wave 2 COMPLETE → **HARD STOP.**
The turn now streams: prose deltas reach the wire as the model produces them,
every frame tees into the resume buffer (live Upstash verified), a refresh
re-attaches via GET, disconnect no longer kills the turn, and tool approval is
governed by a fail-closed tier table. All on the approved native seam — zero
new runtime dependencies (still 22), zero new persisted-event writers.

## 1. Acceptance criteria

| AC | Proof | Result |
| --- | --- | --- |
| A2-6 first token precedes stream close by a measurable margin | `verify-tutor-stream-int.ts` (**36/0**): a 5-chunk streaming fake with 30ms gaps — the first display delta precedes settle by ≥ the gap span, driven through the route's REAL per-event wiring (exported test seams). Live leg: §8 table below (median first prose delta 10.8s vs 13.3s settle) | **PASS** |
| A2-7 kill mid-stream → GET replays full answer, no gap/dup | Int: tee mid-kill snapshot → post-settle read-from-0 equals the exact emitted frame sequence, finalized:true. Frames replay VERBATIM (encoded bytes) so gap/dup-free is by construction. **Live Upstash leg:** the real-backend smoke — append/tail/`followStream` live-follow → `finalized`, byte-identical replay | **PASS** |
| A2-8 GET: 204 no active stream; 401/403 unauthorized | Route GET: requireUser (401) → `resolveTutorAccess` ≠ ok (403) → `readActiveStream`/buffer null → 204; `followStream` semantics unit-proven against the buffer seam. (Full HTTP-level browser pass lands with Wave 4's Playwright.) | **PASS** |
| A2-9 irreversible tool halts, emits approval request, never executes | `verify-tutor-runtime.ts` (**85/0**): synthetic "wipe_all_data" call → loop HALTS at the gate (exactly one model call, no second round, no ToolError bounce), `approvalRequired.toolName` set, ok:false + output:null ⇒ zero assistant persistence/evidence (matches service step-6 skip); route maps it to the `approval_required` wire frame (§7-compliant copy) | **PASS** |
| A2-10 tool with no tier row fails CI | Same suite: every `TUTOR_TOOL_NAMES` member must have an explicit `TUTOR_TOOL_TIERS` row (missing OR extra keys trip); `tierOf("unknown")` === "irreversible" (fail closed). The Record is exhaustively typed — an unclassified tool is ALSO a compile error. `npm test` is the CI gate | **PASS** |
| A2-11 `active_stream_id` null after completion / error / abort | Int suite, three separate checks (+ `active_response_id`). Includes the race fix below | **PASS** |
| A2-12 persistence still through the single write path | Restated for the append-only transcript (Wave 0 §A0-3): the insert pair remains the only writer — pure grep (no update/delete/upsert touches `tutor_turns`) + int (exactly 1 assistant row per completed turn, 0 on abort/error; counts unchanged across an error). A 409 re-read/re-apply cannot exist on an immutable table (DB trigger) | **PASS (restated)** |

**Repo gates (bare exits):** `tsc` **0** · `lint` **0** · `npm test` **0**
(first run tripped ONE stale drift-guard — `verify-tutor-models` pinning the old
30s deadline; the guard did its job on an intentional change; updated to 90s +
re-run green, full chain re-confirmed) · `verify:tutor:int` **0** (16 suites /
**458** checks) · `build` **0** · `verify:budgets` **6/6** (learner route
byte-identical 216.3 KB — Wave 2 is server-side; the client still ignores the
new frames until Wave 3).

## 2. §8 metrics — before vs after (same instrument, same prompt, 5 runs each)

`scripts/measure-tutor-turn-metrics.ts` (kept for Wave 4): the exact route
assembly + real model (gpt-5.6-luna, medium) on a fixture course. "First
visible" = the first non-empty yield of the SAME prose extractor the route
streams through.

| Metric (median) | BEFORE (buffered) | AFTER (streamed) |
| --- | --- | --- |
| Time to first visible output | **14,915 ms** | **10,767 ms** (−28%) |
| Time to full answer | 14,915 ms | 13,337 ms (noise-level — streaming doesn't speed generation) |
| Event-stream rows per turn | 0 at sample¹ | 2 at sample¹ |
| Postgres bytes per turn (proxy¹) | 1,989 | 3,948¹ |

¹ **The row/byte deltas are sampling artifacts, not new writes** — proven
structurally: the Wave-2 diff adds ZERO `learning_events` writers (grep over
the full wave diff), A2-5's union lock pins the persisted contract at its
pre-A2 22 members, and lifecycle/delta frames are wire-only. The per-turn
writer set is identical before/after: 1 × `tutor_model_call` per model call
(fire-and-forget — landed outside the BEFORE sample window, inside the AFTER
one, because the settle path now awaits the capture promise) + 0–N
model-chosen `tutor_inference` evidence rows (the fixture answers varied).
The §8 failure condition (an INCREASE in persisted rows/bytes caused by
streaming) does not obtain.

**Reading the latency honestly:** the first output token lands at ~10.5s
because `tutor_turn` runs at medium reasoning effort — the provider emits no
`output_text` until reasoning completes. Streaming removes the
post-reasoning wait (~4.1s median here; proportionally more on longer
answers), and the pre-token gap is exactly what Wave 3's status phases cover
("Working through it" — truthful: the model IS working). A `[FWD]` lever if
the pre-token gap should shrink further: the Responses API can stream
reasoning-SUMMARY deltas (§6's own composing trigger mentions them) — not
wired in A2.

**Live-run note:** 4/5 AFTER runs ok; run 3 died to a proxy transport drop
("terminated", correctly classified `transport`, `deadlineHit:false`) — the
known Clash environment flake, not a Wave-2 path. The learner-facing behavior
for that failure is the existing error card + Retry.

## 3. What was built

- **Route** (`app/api/learn/tutor/route.ts`): `maxDuration = 300`; whole-turn
  deadline `TUTOR_STREAM_TIMEOUTS.totalMs` (240s); **`req.signal` REMOVED from
  the abort composition** — a disconnect is not a stop; the turn completes and
  persists server-side, `cancel()` only marks the HTTP leg closed; **chunk
  watchdog** (20s без-event stall → `turn_aborted{reason:"stalled"}`); the
  route now speaks `sseProtocol`'s Zod wire contract (legacy four frames
  byte-compatible). Emission order: `turn_started` → `model_started` →
  `first_token` + `text_delta`× → (`turn` + `turn_completed` | `error` [+
  `turn_aborted`] | `approval_required`) → `done`. Every frame tees into the
  buffer (best-effort); `finalize` on settle. **GET resume**: same auth gate as
  POST, 204 when idle/unconfigured, verbatim replay + 400ms live tail via
  `followStream`; `Cache-Control: no-cache, no-transform` +
  `X-Accel-Buffering: no` on both SSE responses.
- **Prose extraction (R-2)** (`lib/tutor/runtime/proseExtractor.ts`, pure):
  incremental scanner over the streamed structured JSON — emits only the
  `proseWithSpanMarkers` string value, decodes escapes across chunk
  boundaries, strips the four span markers even when split mid-marker,
  junk-safe. 34-check pure suite.
- **Tool tiers (fail-closed)** (`lib/tutor/runtime/toolTiers.ts` +
  `loop.ts:494`): exhaustively-typed tier table over the five tools (4 read ·
  `propose_escalation` reversible); `tierOf` defaults unknown → irreversible;
  the gate runs BEFORE dispatch and before the unknown-tool bounce;
  `TutorTurnResult.approvalRequired` surfaces the halt (dormant today — no
  tutor tool is irreversible — but load-bearing for every future tool).
- **Step timeout**: `tutor_turn.timeoutMs` default 30s → 90s (the directive's
  stepMs; drift-guard updated intentionally).
- **`streamResume.ts`** (`followStream`, injectable clock/sleep) +
  **`streamConfig.ts`** (the 240/90/20 trio).
- **Service**: composes the external `onModelEvent` with the Wave-1 capture;
  `setActiveStream` before dispatch when the route supplies a streamId; **race
  fix (found by A2-11's own tests):** the fire-and-forget capture could land
  AFTER the finally's clear on an instant-fail turn — the settle path now
  awaits the in-flight capture before clearing, making the clear the
  guaranteed-last write.

## 4. Files

**Created:** `lib/tutor/runtime/proseExtractor.ts` · `streamResume.ts` ·
`streamConfig.ts` · `toolTiers.ts` · `scripts/verify-tutor-prose-extractor.ts`
· `scripts/measure-tutor-turn-metrics.ts` (the §8 instrument, kept) · this
checkpoint.
**Modified:** `app/api/learn/tutor/route.ts` · `lib/tutor/runtime/service.ts` ·
`lib/tutor/runtime/loop.ts` · `lib/tutor/runtime/sseProtocol.ts`
(+`approval_required`) · `lib/ai/modelConfig.ts` (stepMs) ·
`scripts/verify-tutor-runtime.ts` · `scripts/verify-tutor-stream-infra.ts` ·
`scripts/verify-tutor-stream-int.ts` · `scripts/verify-tutor-models.ts`
(intentional drift-guard update) · `package.json` (prose suite chained).
**Deleted:** none.

## 5. Deviations

1. **A2-8's HTTP-level 401/403/204 assertions** are unit-proven at the
   gate/seam level; the end-to-end HTTP leg (real GET against the dev server)
   lands with Wave 4's Playwright pass — the directive's own test wave.
2. **Concurrent second POST while a turn is in flight is allowed** (no guard):
   append-only history tolerates interleave, the learner pool caps
   concurrency, `active_stream_id` is latest-wins. Wave 3's client will
   auto-resume instead of double-sending. Disclosed route comment.
3. **The §8 "rows/bytes" table** is reported with the sampling-artifact
   analysis above rather than as bare numbers — the bare numbers would
   misleadingly suggest streaming added writes; the structural proofs (diff
   grep + union lock) are the real §8 compliance.
4. **`captureActiveResponseId` await-before-clear** — a service-level
   hardening beyond the directive text, forced by A2-11's own tests (a benign
   in-scope bug fix, disclosed by the building agent).

## 6. Risk-profile updates for Wave 3

- The current client renders nothing until the final `turn` frame (it ignores
  the new frames — verified) — Wave 3 wires `text_delta`/status phases into
  `useTutorStream` + the `TutorStatusPhase` component, extends the zod-free
  client mirror, and replaces double-send with resume-first.
- `TUTOR_TTFT`'s existing first-bytes semantics now stamp at `turn_started`
  (near-instant) — Wave 3 must re-point the vital at the first `text_delta`
  (or add a distinct metric) or the dashboard number becomes vacuous.
- Reasoning dominates the remaining pre-token gap (~10s at medium effort);
  status-phase copy must stay truthful (§7) — no "reading course data".
- An operational note: mid-consolidation the machine hit fork exhaustion from
  a third-party app leaking 2,231 zombie processes (Codex.app — killed with
  the operator's approval). Not a repo issue; documented for the record.

**Awaiting approval to proceed to Wave 3.**
