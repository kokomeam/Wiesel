/**
 * Autonomy copy helpers (UI-1 W4.2/W4.6) — pure, unit-tested. One line of
 * description per mode; the compare table; and the mode-change consequence
 * line computed from the ACTUAL settings state, never static copy.
 *
 * Copy stays truthful to the policy engine: every unset guardrail fails
 * closed, so nothing here may imply an unset field widens autonomy.
 */

import type { AutonomyMode, AutonomySettings } from "./autonomy";

export const MODE_TITLES: Record<AutonomyMode, string> = {
  manual: "Manual",
  assisted: "Assisted",
  auto: "Auto",
};

/** Exactly one line, shown for the SELECTED mode only (W4.2). */
export const MODE_DESCRIPTIONS: Record<AutonomyMode, string> = {
  manual: "Every action that reaches a real person waits for your approval card.",
  assisted:
    "Approval cards for everything outward — the agent asks first when targeting is ambiguous, and test emails to your own address just send.",
  auto: "Opted-in actions run without a card, inside your caps and hours. Everything else still asks.",
};

/** The 3-column comparison popover: one line per row (W4.2). */
export const MODE_COMPARISON: { row: string; manual: string; assisted: string; auto: string }[] = [
  { row: "Outward actions", manual: "Always ask", assisted: "Always ask", auto: "Ask unless opted in" },
  { row: "Ambiguous targeting", manual: "Card", assisted: "Question first", auto: "Question first" },
  { row: "Test email to you", manual: "Card", assisted: "Just sends", auto: "Just sends" },
  { row: "Drafts & edits", manual: "Auto + revert", assisted: "Auto + revert", auto: "Auto + revert" },
  { row: "Social publishing", manual: "Always asks", assisted: "Always asks", auto: "Always asks" },
];

/**
 * The consequence line for switching to `nextMode`, computed from actual
 * settings (W4.6). Empty string when nothing changes (same mode).
 */
export function modeConsequence(current: AutonomySettings, nextMode: AutonomyMode): string {
  if (nextMode === current.mode) return "";
  const n = current.policy.autoApproveTools.length;
  if (nextMode === "auto") {
    const opted =
      n === 0
        ? "Nothing is opted in yet, so everything still asks until you opt actions in below."
        : `${n} opted-in action${n === 1 ? "" : "s"} will run without cards, inside your caps and hours.`;
    return `${opted} Social publishing always asks.`;
  }
  if (nextMode === "manual") {
    const opted = n > 0 ? ` Your ${n} auto opt-in${n === 1 ? "" : "s"} pause${n === 1 ? "s" : ""} until you return to Auto.` : "";
    return `Every outward action will wait for your approval card.${opted}`;
  }
  // assisted
  const opted = n > 0 ? ` Your ${n} auto opt-in${n === 1 ? "" : "s"} pause${n === 1 ? "s" : ""} until you return to Auto.` : "";
  return `Everything outward asks first; the agent asks a clarifying question when targeting is ambiguous.${opted}`;
}
