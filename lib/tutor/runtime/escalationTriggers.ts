/**
 * TUTOR-1 Wave 6 (P6.1) — DETERMINISTIC escalation triggers (PURE, unit-testable).
 *
 * The model can already propose an escalation (the propose_escalation tool → the
 * turn's `escalation`). But the charter's `escalationSensitivity` must ACTUALLY
 * drive escalation — a low/default/high setting should change how readily the
 * runtime offers a hand-off, independent of whether the model chose to. This
 * module is that deterministic gate: given the turn's grounding flags, the thread
 * history, this turn's learner message, and the charter sensitivity, it decides
 * whether the runtime should RAISE an escalation proposal the model didn't.
 *
 * Three deterministic reasons raise a proposal (any one suffices):
 *
 *   1. EXPLICIT REQUEST — the learner asked for a human in plain words
 *      (`ESCALATION_REQUEST_RE`). Always honoured, at every sensitivity.
 *   2. UNGROUNDED — grounding flagged this turn `ungrounded` (substantive prose
 *      the course can't support). The charter's own rule: low confidence must
 *      become an escalation offer, never invention.
 *   3. REPEATED FAILED SCAFFOLDS — the learner has been stuck on the same
 *      concept(s) across ≥ N assistant attempts this session, N from sensitivity
 *      (low=4, default=3, high=2). A "failed scaffold" is a prior assistant turn
 *      on the SAME lesson node set followed by a learner turn expressing confusion
 *      (`LEARNER_CONFUSION_RE`) — the deterministic stuck-signal heuristic.
 *
 * PURE: no DB, no model, no wall-clock. The loop calls `evaluateEscalationTrigger`
 * after grounding and, when it fires AND the model didn't already propose, mints
 * the proposal + writes the consent-pending candidate.
 */

import type { HistoryTurn } from "./history";
import type { EscalationSensitivity } from "./charter";

/* ─────────────────────────────── thresholds ─────────────────────────────────
 * The N-failed-scaffolds-per-node threshold, keyed by charter sensitivity. A
 * HIGHER sensitivity escalates SOONER (fewer failed attempts). DOCUMENTED here as
 * the single source; the checkpoint records the same table. */
export const FAILED_SCAFFOLD_THRESHOLD: Record<EscalationSensitivity, number> = {
  low: 4,
  default: 3,
  high: 2,
};

/** The explicit-request regex — the learner asking, in plain words, for a human.
 *  Case-insensitive; matches "ask the/my instructor|teacher|professor", "talk to
 *  a human|person", or "escalate". */
export const ESCALATION_REQUEST_RE =
  /ask (?:the|my) (?:instructor|teacher|professor)|talk to a (?:human|person)|escalate/i;

/** The learner-confusion regex — a subsequent learner turn signalling the prior
 *  scaffold DIDN'T land (still stuck / lost / doesn't make sense). Deliberately
 *  narrow so ordinary follow-ups don't read as confusion. */
export const LEARNER_CONFUSION_RE =
  /\b(?:still (?:don'?t|do not|not|lost|confused|stuck)|i'?m (?:still |so )*(?:lost|confused|stuck)|makes? no sense|doesn'?t make sense|not getting it|i don'?t (?:get|understand|follow)|no idea|even more confused)\b/i;

/* ─────────────────────────────── inputs ─────────────────────────────────── */

export interface EscalationTriggerInput {
  /** The grounding flags this turn produced (validateTurnOutput). `ungrounded`
   *  here is the already-computed flag — this module never recomputes grounding. */
  groundingFlags: string[];
  /** The replayed thread tail (oldest → newest), BEFORE this turn's learner row.
   *  Used to count failed scaffolds on the current concept(s). */
  history: HistoryTurn[];
  /** This turn's learner message (the explicit-request check). */
  learnerMessage: string;
  /** The charter escalation sensitivity → the failed-scaffold threshold. */
  escalationSensitivity: EscalationSensitivity;
}

/** Why the deterministic trigger fired (or that it didn't). One reason per fire;
 *  precedence when several hold: explicit_request > ungrounded > repeated_failed_scaffolds. */
export type EscalationTriggerReason =
  | "explicit_request"
  | "ungrounded"
  | "repeated_failed_scaffolds";

export interface EscalationTriggerResult {
  /** Should the runtime raise an escalation proposal this turn? */
  shouldPropose: boolean;
  /** The reason (null when shouldPropose is false). */
  reason: EscalationTriggerReason | null;
  /** The failed-scaffold count observed this session (0 when not applicable) —
   *  carried for telemetry + the checkpoint. */
  failedScaffolds: number;
  /** The threshold that applied (for the sensitivity), for telemetry. */
  threshold: number;
}

/* ─────────────────────────────── the trigger ────────────────────────────── */

/**
 * Decide whether the runtime should propose an escalation this turn. PURE.
 *
 * Precedence (a single reason is returned): an explicit human-request wins; else
 * an `ungrounded` turn; else ≥ N failed scaffolds this session. The failed-scaffold
 * count is always computed (it rides telemetry even when another reason fires or
 * nothing fires).
 */
export function evaluateEscalationTrigger(
  input: EscalationTriggerInput
): EscalationTriggerResult {
  const threshold = FAILED_SCAFFOLD_THRESHOLD[input.escalationSensitivity];
  const failedScaffolds = countFailedScaffolds(input.history);

  // 1. Explicit request — always, at every sensitivity.
  if (ESCALATION_REQUEST_RE.test(input.learnerMessage)) {
    return { shouldPropose: true, reason: "explicit_request", failedScaffolds, threshold };
  }

  // 2. Ungrounded — the charter rule: low confidence → offer a hand-off.
  if (input.groundingFlags.includes("ungrounded")) {
    return { shouldPropose: true, reason: "ungrounded", failedScaffolds, threshold };
  }

  // 3. Repeated failed scaffolds this session (N from sensitivity).
  if (failedScaffolds >= threshold) {
    return {
      shouldPropose: true,
      reason: "repeated_failed_scaffolds",
      failedScaffolds,
      threshold,
    };
  }

  return { shouldPropose: false, reason: null, failedScaffolds, threshold };
}

/* ─────────────────────────────── heuristic ──────────────────────────────── */

/**
 * Count FAILED SCAFFOLDS in the thread tail: an assistant turn immediately
 * followed by a learner turn expressing confusion. Each such (assistant → confused
 * learner) pair is one failed scaffold — the prior scaffold didn't resolve, and
 * the learner said so. Deterministic + order-preserving.
 *
 * The count is a SESSION run: it accumulates over the CONSECUTIVE trailing pairs
 * and RESETS whenever a learner turn does NOT express confusion (the learner moved
 * on / the concept firmed up) — so a long-ago stuck streak that already resolved
 * never re-triggers. Only assistant turns count as scaffolds; learner and
 * instructor turns between them are ignored except as the confusion signal.
 */
export function countFailedScaffolds(history: HistoryTurn[]): number {
  let count = 0;
  for (let i = 0; i < history.length; i += 1) {
    const turn = history[i];
    if (turn.role !== "assistant") continue;
    // Look at the NEXT turn — a learner-confusion signal means this scaffold failed.
    const next = history[i + 1];
    if (next && next.role === "learner") {
      if (LEARNER_CONFUSION_RE.test(next.content)) {
        count += 1;
      } else {
        // The learner responded WITHOUT confusion → the streak resets (they moved
        // on). A later scaffold+confusion starts a fresh streak.
        count = 0;
      }
    }
  }
  return count;
}
