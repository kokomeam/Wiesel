/**
 * TUTOR-1 Amendment A4, Wave 3 — the four EXPANSION codes (pure).
 *
 * Tier-2 (completed lessons) retrieval is permitted ONLY under one enumerated,
 * recorded condition. Each detector is independent; `decideExpansion` fuses them
 * in a fixed priority and returns exactly ONE code (or none). Expansion also
 * requires eligible completed lessons to draw from — no code fires into an empty
 * Tier-2 pool. This is what guarantees A4-15 (never expand without a code).
 */

import type { RetrievedChunk } from "./retrieve";

export type ExpansionCode =
  | "explicit_request"
  | "insufficient_local_context"
  | "prerequisite_gap"
  | "multi_concept_span";

/** The learner asked to compare / combine / review across topics, or names other
 *  material. Narrow by design — a bare topic word must not trigger expansion. */
export const EXPLICIT_REQUEST_RE =
  /\b(compare|contrast|versus|vs\.?|combine|relate|tie together|connect(?:s|ion)?|across (?:topics|lessons|units|chapters)|earlier (?:lesson|topic|material)|previous (?:lesson|topic)|other (?:lesson|topic|material)|last (?:week|lesson)|review (?:everything|across|all)|how does (?:this|it) (?:relate|connect|compare))\b/i;

export function detectExplicitRequest(message: string): boolean {
  return EXPLICIT_REQUEST_RE.test(message);
}

/** Every Tier-1 result falls below the relevance threshold τ (or there are none)
 *  ⇒ the active lesson lacks the answer locally. τ gates on cosine SIMILARITY (the
 *  Wave-5 calibration finding: the RRF rank score does not separate relevant from
 *  irrelevant; raw similarity does). */
export function detectInsufficientLocal(tier1: RetrievedChunk[], tau: number): boolean {
  if (tier1.length === 0) return true;
  return tier1.every((c) => c.similarity < tau);
}

/** A prerequisite of an active-lesson concept is weak/absent, AND that
 *  prerequisite is covered by a COMPLETED lesson (so retrieving it is in-scope).
 *  `gapLessonIds` are the covering completed lessons. */
export function detectPrerequisiteGap(
  gapLessonIds: string[],
  completed: Set<string>
): { gap: boolean; lessonIds: string[] } {
  const lessonIds = [...new Set(gapLessonIds.filter((l) => completed.has(l)))];
  return { gap: lessonIds.length > 0, lessonIds };
}

/** The question maps to concepts spanning MORE THAN ONE lesson, and ≥1 of the
 *  non-active spanned lessons is COMPLETED (retrievable). */
export function detectMultiConceptSpan(
  questionLessonIds: Set<string>,
  activeLessonId: string | null,
  completed: Set<string>
): { span: boolean; lessonIds: string[] } {
  const other = [...questionLessonIds].filter((l) => l !== activeLessonId && completed.has(l));
  return { span: questionLessonIds.size > 1 && other.length > 0, lessonIds: other };
}

export interface ExpansionSignals {
  explicitRequest: boolean;
  multiConceptSpan: { span: boolean; lessonIds: string[] };
  prerequisiteGap: { gap: boolean; lessonIds: string[] };
  insufficientLocal: boolean;
  /** The full Tier-2 pool (all completed, non-active lessons). */
  completedLessonIds: string[];
}

export interface ExpansionDecision {
  expand: boolean;
  code: ExpansionCode | null;
  /** The lessons Tier 2 will draw from (⊆ completed). */
  tier2LessonIds: string[];
}

/**
 * Fuse the signals into ONE decision. Priority (first match wins), chosen so the
 * MOST INTENTFUL signal is recorded: the learner explicitly asked → the question
 * spans concepts → a prerequisite is weak → the active lesson is simply thin.
 * Expansion never fires without a target pool.
 */
export function decideExpansion(s: ExpansionSignals): ExpansionDecision {
  if (s.explicitRequest && s.completedLessonIds.length > 0) {
    return { expand: true, code: "explicit_request", tier2LessonIds: s.completedLessonIds };
  }
  if (s.multiConceptSpan.span) {
    return { expand: true, code: "multi_concept_span", tier2LessonIds: s.multiConceptSpan.lessonIds };
  }
  if (s.prerequisiteGap.gap) {
    return { expand: true, code: "prerequisite_gap", tier2LessonIds: s.prerequisiteGap.lessonIds };
  }
  if (s.insufficientLocal && s.completedLessonIds.length > 0) {
    return { expand: true, code: "insufficient_local_context", tier2LessonIds: s.completedLessonIds };
  }
  return { expand: false, code: null, tier2LessonIds: [] };
}
