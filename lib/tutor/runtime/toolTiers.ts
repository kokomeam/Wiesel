/**
 * TUTOR-1 Amendment A2 (Wave 2) — the tutor tool TIER table + the fail-closed
 * `tierOf` classifier.
 *
 * ── THE A2 §5 INVARIANT (load-bearing) ───────────────────────────────────────
 * This table is the SINGLE approval-authority source for the tutor surface. A
 * tool's tier decides whether the loop may execute it unattended:
 *   • "read"        — no persistent side effect (validates / returns / mints for
 *                     the turn only). Runs freely.
 *   • "reversible"  — a learner-consent-gated, learner-revocable side effect (the
 *                     propose_escalation consent_pending insert). Runs freely.
 *   • "irreversible"— NEVER runs unattended: the loop HALTS and surfaces an
 *                     approval-required result the route maps to a wire frame.
 *
 * A tool with NO explicit row GATES — it never runs. `tierOf` falls closed to
 * "irreversible" for any unknown name (an unknown tool is, by definition, an
 * unclassified capability). The Record is keyed by the FIVE tutor tool names via
 * TUTOR_TOOL_NAMES, so adding a tool WITHOUT classifying it is BOTH a TypeScript
 * error (the exhaustive Record loses a key) AND a test failure (A2-10 iterates
 * the tuple and asserts no extra keys). Keep it that way — never widen the key
 * type to `string`.
 *
 * NO tutor tool is irreversible TODAY (all five are read/reversible), so the gate
 * is dormant — but it is LOAD-BEARING for every future tool: the moment one lands
 * without a tier row, it is refused, not silently run.
 */

import { TUTOR_TOOL_NAMES } from "./tools";

/** The three approval tiers. Ordered least → most consequential. */
export type TutorToolTier = "read" | "reversible" | "irreversible";

/**
 * The exhaustive tier classification for the FIVE tutor tools. Keyed by the
 * TUTOR_TOOL_NAMES tuple so a new tool that isn't classified is a TYPE error.
 */
export const TUTOR_TOOL_TIERS: Record<(typeof TUTOR_TOOL_NAMES)[number], TutorToolTier> = {
  get_lesson_context: "read",
  get_mastery_summary: "read",
  generate_practice: "read", // no DB write — items live only for the turn
  emit_evidence: "read", // validates + hands back; the ROUTE writes
  propose_escalation: "reversible", // consent_pending insert; learner-gated + revocable
  // A3 Wave 4 — all three carry NO DB write: the card lives for the turn; the
  // ROUTE writes evidence on the learner's interaction (`tool_evidence`).
  renderStructure: "read", // presentational — a validated diagram, no side effect
  checkUnderstanding: "read", // Class A — the item rides the turn output
  sequenceTask: "read", // Class A — the item rides the turn output
};

/**
 * The tier of a tool by name. FAILS CLOSED: any name not in the table (an
 * unknown/unclassified tool) is treated as "irreversible" so the loop's gate
 * halts it instead of running an unvetted capability.
 */
export function tierOf(toolName: string): TutorToolTier {
  return (TUTOR_TOOL_TIERS as Record<string, TutorToolTier>)[toolName] ?? "irreversible";
}
