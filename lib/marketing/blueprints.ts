/**
 * Sequence blueprints — the Campaign Planner's explicit content (Amendment 1).
 *
 * Replaces the old fixed "4-email default" with a per-GOAL blueprint: a length
 * range, a default length, an ordered stage list (each with a copywriting
 * framework hint the quality rubric scores against — see ./quality.ts), and a
 * timing rule. This is PRODUCT-OWNED data (like the studio's SLIDE_LAYOUTS
 * registry), not a database table — it changes with product decisions, not
 * per-campaign state.
 *
 * The Planner selects a blueprint by goal (§3), the creator can add/remove
 * steps within [minLength,maxLength], and the choice is recorded on
 * `marketing_campaign.config.blueprintKey` so analytics can compare blueprints
 * later. A blueprint may `allowDeadlineDoubleSend`: a same-day second send on
 * the offer's deadline evening — ALWAYS its own separately-approved step, never
 * silently added.
 */

export type CampaignGoal =
  | "launch_course"
  | "welcome_interest_list"
  | "reengage_students"
  | "convert_interest"
  | "promote_discount"
  | "follow_up_no_response";

/** The copywriting framework each stage is scored against (quality.ts). */
export type CopyFramework = "PAS" | "claim_mechanism_proof" | "objection_reframe_evidence" | "offer_transformation_deadline";

export interface BlueprintStage {
  key: string;
  name: string;
  framework: CopyFramework;
  /** Day offset from enrollment (the default drip timing). */
  dayOffset: number;
}

export interface SequenceBlueprint {
  key: string;
  goal: CampaignGoal;
  label: string;
  minLength: number;
  maxLength: number;
  defaultLength: number;
  stages: BlueprintStage[];
  /** Free-text timing guidance shown in the wizard (Screen 3). */
  timingNote: string;
  /** May the Planner propose a same-day second send on a real deadline? Always
   *  a distinct, separately-approved step — never silently appended. */
  allowDeadlineDoubleSend: boolean;
}

export const BLUEPRINTS: Record<CampaignGoal, SequenceBlueprint> = {
  launch_course: {
    key: "launch_course",
    goal: "launch_course",
    label: "Launch this course",
    minLength: 4,
    maxLength: 7,
    defaultLength: 5,
    stages: [
      { key: "welcome_problem", name: "Welcome + Problem", framework: "PAS", dayOffset: 0 },
      { key: "solution_credibility", name: "Solution + Credibility", framework: "claim_mechanism_proof", dayOffset: 2 },
      { key: "objection_handling", name: "Objection handling", framework: "objection_reframe_evidence", dayOffset: 4 },
      { key: "offer_cta", name: "Offer / CTA", framework: "offer_transformation_deadline", dayOffset: 7 },
      { key: "last_chance", name: "Last-chance", framework: "offer_transformation_deadline", dayOffset: 9 },
    ],
    timingNote:
      "Drip over 7–10 days. If the offer has a real deadline, compress so the final email lands on deadline day — most enrollments land on the last day.",
    allowDeadlineDoubleSend: true,
  },
  welcome_interest_list: {
    key: "welcome_interest_list",
    goal: "welcome_interest_list",
    label: "Welcome people who joined the interest list",
    minLength: 2,
    maxLength: 5,
    defaultLength: 3,
    stages: [
      { key: "deliver_value", name: "Deliver value", framework: "PAS", dayOffset: 0 },
      { key: "story_credibility", name: "Story / credibility", framework: "claim_mechanism_proof", dayOffset: 2 },
      { key: "soft_cta", name: "Soft CTA", framework: "offer_transformation_deadline", dayOffset: 5 },
    ],
    timingNote: "Every 2–3 days.",
    allowDeadlineDoubleSend: false,
  },
  reengage_students: {
    key: "reengage_students",
    goal: "reengage_students",
    label: "Re-engage previous students",
    minLength: 3,
    maxLength: 3,
    defaultLength: 3,
    stages: [
      { key: "whats_new", name: "What's new", framework: "PAS", dayOffset: 0 },
      { key: "value_win", name: "Value / win", framework: "claim_mechanism_proof", dayOffset: 3 },
      { key: "invitation", name: "Invitation", framework: "offer_transformation_deadline", dayOffset: 6 },
    ],
    timingNote: "Every 3 days.",
    allowDeadlineDoubleSend: false,
  },
  convert_interest: {
    key: "convert_interest",
    goal: "convert_interest",
    label: "Convert interest-list leads into enrolled students",
    minLength: 2,
    maxLength: 3,
    defaultLength: 3,
    stages: [
      { key: "objection_faq", name: "Objection / FAQ", framework: "objection_reframe_evidence", dayOffset: 0 },
      { key: "proof", name: "Proof", framework: "claim_mechanism_proof", dayOffset: 2 },
      { key: "final_cta", name: "Final CTA", framework: "offer_transformation_deadline", dayOffset: 4 },
    ],
    timingNote: "Every 2 days.",
    allowDeadlineDoubleSend: true,
  },
  promote_discount: {
    key: "promote_discount",
    goal: "promote_discount",
    label: "Promote a discount",
    minLength: 3,
    maxLength: 4,
    defaultLength: 4,
    stages: [
      { key: "announce", name: "Announce", framework: "PAS", dayOffset: 0 },
      { key: "value_proof", name: "Value + proof", framework: "claim_mechanism_proof", dayOffset: 1 },
      { key: "deadline_reminder", name: "Deadline reminder", framework: "offer_transformation_deadline", dayOffset: 2 },
      { key: "last_hours", name: "Last hours", framework: "offer_transformation_deadline", dayOffset: 3 },
    ],
    // Amendment 1: anchored to a REAL end date; the compliance gate blocks this
    // blueprint (fake-scarcity rule) when no real end date is on the brief.
    timingNote: "Anchored to the real end date — requires a real offer deadline in the Campaign Brief (blocked otherwise, fake-scarcity rule).",
    allowDeadlineDoubleSend: true,
  },
  follow_up_no_response: {
    key: "follow_up_no_response",
    goal: "follow_up_no_response",
    label: "Follow up after no response",
    minLength: 2,
    maxLength: 2,
    defaultLength: 2,
    stages: [
      { key: "fresh_angle", name: "Fresh angle", framework: "PAS", dayOffset: 0 },
      { key: "one_question_close", name: "One-question close", framework: "offer_transformation_deadline", dayOffset: 3 },
    ],
    timingNote: "Every 3–4 days.",
    allowDeadlineDoubleSend: false,
  },
};

export const CAMPAIGN_GOALS = Object.keys(BLUEPRINTS) as CampaignGoal[];

export function getBlueprint(goal: string): SequenceBlueprint | null {
  return (BLUEPRINTS as Record<string, SequenceBlueprint>)[goal] ?? null;
}

/** Clamp a requested stage count into [min,max], defaulting when unset. Adding/
 *  removing steps within range is the creator's prerogative (§ rules). */
export function clampLength(blueprint: SequenceBlueprint, requested?: number | null): number {
  if (!requested) return blueprint.defaultLength;
  return Math.max(blueprint.minLength, Math.min(blueprint.maxLength, requested));
}

/** The stage list trimmed/repeated to exactly `length` steps — trims from the
 *  END (last-chance/deadline stages) first when shrinking below default so the
 *  earliest funnel stages (welcome/problem/solution) are always kept; repeats
 *  the last non-deadline stage's cadence spacing when growing beyond default
 *  is not needed since maxLength already caps the registry's own list length. */
export function stagesForLength(blueprint: SequenceBlueprint, length: number): BlueprintStage[] {
  const n = Math.max(blueprint.minLength, Math.min(blueprint.maxLength, length));
  if (n >= blueprint.stages.length) return blueprint.stages;
  return blueprint.stages.slice(0, n);
}
