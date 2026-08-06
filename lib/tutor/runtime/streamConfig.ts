/**
 * TUTOR-1 Amendment A2 Wave 2 — the tutor STREAMING TIMEOUTS.
 *
 * Three nested deadlines guard one streamed turn, each protecting a different
 * failure mode:
 *
 *   • totalMs (240s) — the WHOLE-TURN route deadline. The `AbortSignal.timeout`
 *     wired to the model call(s) fires at this ceiling so a wedged turn can never
 *     hold the connection (or the pool slot) open forever. It is the outer bound
 *     the route's `maxDuration` (300s) leaves overhead above.
 *   • stepMs (90s)   — the PER-MODEL-CALL timeout. This is the value carried by
 *     `TUTOR_MODELS.tutor_turn.timeoutMs` (the model client wires it as a hard
 *     fetch deadline per call), so one slow model round can't consume the whole
 *     budget. It lives here as the documented source of that number; the model
 *     config is the value the loop actually passes.
 *   • chunkMs (20s)  — the STALL WATCHDOG. A provider can open a stream (emit
 *     `started`) and then go silent — the learner would watch a dead cursor until
 *     `totalMs`. If no ModelStreamEvent arrives for `chunkMs` WHILE the model call
 *     is in flight, the route aborts the turn with a distinguishable reason so the
 *     wire settles a `turn_aborted{reason:"stalled"}` instead of hanging.
 *
 * Pure constants — no env reads here (the route composes them; the per-call step
 * timeout is env-overridable via TUTOR_TURN_TIMEOUT_MS at its source in
 * modelConfig).
 */

export const TUTOR_STREAM_TIMEOUTS = {
  /** Whole-turn route deadline (ms) — the outer ceiling on one streamed turn. */
  totalMs: 240_000,
  /** Per-model-call timeout (ms) — mirrors TUTOR_MODELS.tutor_turn.timeoutMs. */
  stepMs: 90_000,
  /** Stall watchdog (ms) — no model event for this long while streaming ⇒ abort. */
  chunkMs: 20_000,
} as const;
