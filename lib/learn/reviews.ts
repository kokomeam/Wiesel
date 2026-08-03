/**
 * Course reviews (Milestone 9) — the PURE layer: prompt-state contract +
 * the show/dismiss decision logic. Zod-first; no DB imports so the verify
 * suite runs with no key.
 *
 * The authoritative eligibility gate lives in SQL
 * (private.is_review_eligible, migration 20260707020000): enrollment
 * 'completed' OR course progress ≥ 70% — the codebase's existing "almost
 * done" threshold. REVIEW_ELIGIBLE_PROGRESS_PCT below is the documented
 * MIRROR (drift-guarded by verify-analytics.ts); TS never recomputes
 * eligibility — pages read it from the review_prompt_state RPC.
 */

import { z } from "zod";
import type {
  LearnerReview as LearnerReviewShape,
  ReviewPromptState as ReviewPromptStateShape,
} from "./reviewsShared";

/* ─────────────── Constants + pure decision (client-safe) ────────────────
 * Live in reviewsShared.ts (zod-free — CourseReview.tsx rides the public
 * landing bundle, PERF-1 D1); re-exported here for server code + the
 * verify-analytics drift guard. */
export {
  REVIEW_ELIGIBLE_PROGRESS_PCT,
  REVIEW_MAX_PROMPT_DISMISSALS,
  REVIEW_REPROMPT_GAP_DAYS,
  REVIEW_TEXT_MAX_CHARS,
  shouldShowReviewPrompt,
} from "./reviewsShared";
export type { LearnerReview, ReviewPromptState } from "./reviewsShared";

/* ────────────────────────────── Contract ───────────────────────────────── */

export const LearnerReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  reviewText: z.string().nullable(),
  updatedAt: z.string(),
}) satisfies z.ZodType<LearnerReviewShape>;

/** The review_prompt_state RPC's jsonb, parsed. */
export const ReviewPromptStateSchema = z.object({
  enrolled: z.boolean(),
  eligible: z.boolean(),
  review: LearnerReviewSchema.nullable(),
  dismissCount: z.number().int().nonnegative(),
  dismissedAt: z.string().nullable(),
  creatorName: z.string(),
}) satisfies z.ZodType<ReviewPromptStateShape>;

export function parseReviewPromptState(value: unknown): ReviewPromptStateShape {
  return ReviewPromptStateSchema.parse(value);
}

/* Decision logic (shouldShowReviewPrompt) lives in reviewsShared.ts — see
 * the client-safe re-export block above. */
