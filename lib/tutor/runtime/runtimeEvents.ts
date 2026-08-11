/**
 * TUTOR-1 Amendment A4 — the tutor RUNTIME telemetry seam.
 *
 * A tiny, dependency-free emitter for the dotted `tutor.*` operational events the
 * A4 waves raise (chain recovery, retrieval expansion, contradiction routing).
 * These are OBSERVABILITY signals, not learner evidence — they never touch
 * `learning_events`. The default sink logs ONE structured JSON line (the house
 * `console.log(JSON.stringify({tag,…}))` convention, greppable by tag); a caller
 * (the loop) may inject an `onRuntimeEvent` sink so a test can observe the exact
 * emission + reason without scraping stdout.
 *
 *   • tutor.chain.rebuilt        — A4-5 (Wave 1): a rejected/stale
 *     `previous_response_id` was recovered by rebuilding the chain from the
 *     compaction summary + recent turns. Carries the rejection `reason`.
 *   • tutor.retrieval.expanded   — A4-15 (Wave 3, [FWD]): retrieval reached past
 *     the active lesson under one enumerated expansion code.
 *   • tutor.contradiction.detected — A4-19 (Wave 3, [FWD]): retrieved content
 *     contradicts the model's own assertion; routed to the escalation loop.
 *
 * PURE w.r.t. the app: no DB, no network. The emit itself never throws (a broken
 * sink must never fail a turn).
 */

/** The dotted A4 runtime-event names. Waves 2/3 add fields to their payloads. */
export type TutorRuntimeEventName =
  | "tutor.chain.rebuilt"
  | "tutor.retrieval.expanded"
  | "tutor.contradiction.detected";

/** A runtime-event payload — the event name plus arbitrary structured fields. */
export interface TutorRuntimeEvent {
  name: TutorRuntimeEventName;
  fields: Record<string, unknown>;
}

/** A sink the loop/service can inject (tests capture; production logs). */
export type TutorRuntimeEventSink = (event: TutorRuntimeEvent) => void;

/**
 * The default sink: one structured JSON line tagged by the event name. Swallows
 * any logging error (telemetry must never break a turn).
 */
export function logTutorRuntimeEvent(event: TutorRuntimeEvent): void {
  try {
    console.log(JSON.stringify({ tag: event.name, ...event.fields }));
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Emit one runtime event through an OPTIONAL sink, always also logging via the
 * default sink. The sink is best-effort — a throwing sink is swallowed so an
 * observer can never fail the turn.
 */
export function emitTutorRuntimeEvent(
  event: TutorRuntimeEvent,
  sink?: TutorRuntimeEventSink
): void {
  logTutorRuntimeEvent(event);
  if (sink) {
    try {
      sink(event);
    } catch {
      /* an injected observer is best-effort */
    }
  }
}
