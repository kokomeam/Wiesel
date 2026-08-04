/**
 * TUTOR-1 W3.3 — the scaffolding rung policy (Directive §3.2).
 *
 * The tutor answers on an escalation LADDER of rungs 0–4 (0 = a probing
 * question, 4 = the full worked answer). How fast it climbs is the course
 * charter's `guidance_style`:
 *
 *   socratic_strict  — open at rung ≤1; climb one rung per stuck signal;
 *                      rung 4 ONLY on an explicit "just show me".
 *   guided_default   — open at rung ≤2; rung 4 after two failed scaffolds
 *                      or an explicit ask.
 *   answer_forward   — open at rung ≤3; rung 4 freely on ask.
 *
 * "Just show me" is IMMEDIATE rung-4 compliance in ALL THREE styles (the
 * order's binding rule): a learner who explicitly asks for the answer gets
 * it — scaffolding is a default, never a wall. The detection is a PURE
 * regex over the learner's message; the loop applies the override AFTER the
 * model's own rung choice, so a style can never veto the explicit ask.
 */

import type { GuidanceStyle } from "./charter";
import type { TurnOutput } from "./outputContract";

export interface RungPolicy {
  /** The highest rung the tutor may OPEN a thread at for this style. */
  maxOpeningRung: 1 | 2 | 3;
  /** The prompt-table text for this style (rides inside L0's full table —
   *  exported per-style for tests and for tools that restate policy). */
  tableText: string;
}

const POLICIES: Record<GuidanceStyle, RungPolicy> = {
  socratic_strict: {
    maxOpeningRung: 1,
    tableText:
      "socratic_strict: open at rung 0-1 (probe, orient). Climb ONE rung per stuck signal. Never rung 4 unless the learner explicitly asks to be shown.",
  },
  guided_default: {
    maxOpeningRung: 2,
    tableText:
      "guided_default: open at rung 1-2 (hint, structure). Climb on stuck signals. Rung 4 after two failed scaffolds or an explicit ask.",
  },
  answer_forward: {
    maxOpeningRung: 3,
    tableText:
      "answer_forward: open at rung 2-3 (walk the approach). Rung 4 freely whenever the learner asks.",
  },
};

export function resolveRungPolicy(style: GuidanceStyle): RungPolicy {
  return POLICIES[style] ?? POLICIES.guided_default;
}

/** Explicit "give me the answer" ask — immediate rung-4 compliance in EVERY
 *  style. Pure; case-insensitive; deliberately narrow (an ambiguous "help"
 *  is a stuck signal, not an override). */
export function detectJustShowMe(message: string): boolean {
  return /just show me|give me the answer|tell me the answer|stop hinting/i.test(message);
}

/**
 * Apply the deterministic scaffolding overrides to a model turn:
 *  - an explicit "just show me" FORCES rung 4 (all styles);
 *  - on the thread's OPENING turn the rung is clamped to the style's cap
 *    (the model may under-shoot, never over-shoot an opener).
 * Pure — returns a new output object when anything changed.
 */
export function applyScaffolding(
  output: TurnOutput,
  opts: { style: GuidanceStyle; isOpeningTurn: boolean; justShowMe: boolean }
): TurnOutput {
  let rung = output.rung;
  if (opts.justShowMe) {
    rung = 4;
  } else if (opts.isOpeningTurn) {
    rung = Math.min(rung, resolveRungPolicy(opts.style).maxOpeningRung) as TurnOutput["rung"];
  }
  return rung === output.rung ? output : { ...output, rung };
}
