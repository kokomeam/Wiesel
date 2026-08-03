/**
 * Zod-free review-prompt pieces for CLIENT bundles (PERF-1 D1).
 *
 * components/learn/CourseReview.tsx (statically imported by the public
 * /learn/[slug] landing) needs only these constants, plain types, and the
 * pure show/gap/cap decision — importing lib/learn/reviews.ts dragged the
 * zod core into the landing bundle. reviews.ts imports and re-exports
 * everything here (server code + the verify-analytics drift guard keep
 * their import paths), and pins its zod schemas to these interfaces with
 * `satisfies z.ZodType<…>` so the two can never drift.
 */

/** SQL mirror — private.is_review_eligible's progress threshold. */
export const REVIEW_ELIGIBLE_PROGRESS_PCT = 70;
/** After a "Maybe later", wait this long before re-surfacing the ask. */
export const REVIEW_REPROMPT_GAP_DAYS = 7;
/** Initial ask + at most 2 re-surfaces — then never again (no nagging). */
export const REVIEW_MAX_PROMPT_DISMISSALS = 3;
/** review_text cap — enforced server-side too (the RPC left()s at 2000). */
export const REVIEW_TEXT_MAX_CHARS = 2000;

export interface LearnerReview {
  rating: number;
  reviewText: string | null;
  updatedAt: string;
}

/** The review_prompt_state RPC's jsonb, parsed (schema in reviews.ts). */
export interface ReviewPromptState {
  enrolled: boolean;
  eligible: boolean;
  review: LearnerReview | null;
  dismissCount: number;
  dismissedAt: string | null;
  creatorName: string;
}

/** The learner-side ask decision: eligible-and-unreviewed, honoring the
 *  re-prompt gap and the lifetime dismissal cap. Pure — callers pass now. */
export function shouldShowReviewPrompt(state: ReviewPromptState, nowMs: number): boolean {
  if (!state.enrolled || !state.eligible || state.review !== null) return false;
  if (state.dismissCount === 0) return true;
  if (state.dismissCount >= REVIEW_MAX_PROMPT_DISMISSALS) return false;
  if (!state.dismissedAt) return true; // defensive: count>0 but no timestamp
  const dismissedMs = Date.parse(state.dismissedAt);
  if (Number.isNaN(dismissedMs)) return true;
  return nowMs - dismissedMs > REVIEW_REPROMPT_GAP_DAYS * 86_400_000;
}
