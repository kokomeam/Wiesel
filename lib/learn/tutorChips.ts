/**
 * TUTOR-1 Amendment A4, Wave 4 — DERIVED suggestion chips (D-9, pure, zod-free).
 *
 * Replaces the static 4-chip array with chips derived from the ACTIVE lesson, the
 * learner's MASTERY (weakest flagged concept / review count), and CONVERSATION
 * context (has the session started). Chips are deduplicated by ACTION (their sent
 * message), consistent with A3 §4. The "Quiz me on this lesson" chip keeps its
 * EXACT string — `invocationPolicy.PRACTICE_REQUEST_RE` depends on it — so a
 * derived chip set never breaks the practice classifier.
 */

export interface TutorSuggestionChip {
  key: string;
  /** The chip's visible text. */
  label: string;
  /** The message sent to the tutor when tapped. */
  message: string;
}

export interface ChipState {
  /** The active lesson's title (from the ambient), or null on the landing. */
  lessonTitle: string | null;
  /** The learner's weakest flagged concept title (from the review queue), or null. */
  weakestConceptTitle: string | null;
  /** How many concepts are flagged for review (drives the review chip copy). */
  reviewCount: number;
  /** Whether the conversation has any turns yet (plan vs. summarize). */
  hasHistory: boolean;
}

/** The exact string the practice classifier pins (invocationPolicy). Do not edit. */
export const QUIZ_CHIP_MESSAGE = "Quiz me on this lesson";

/** Trim a title for a compact chip label (word-boundary, ellipsized). */
function short(title: string, max = 26): string {
  const t = title.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/u, "")}…`;
}

/**
 * Derive the suggestion chips for the current state. Deterministic + pure. Always
 * returns the "Quiz me on this lesson" chip (pinned). The explain/review/plan
 * chips vary with lesson title, mastery, and conversation. Deduped by action.
 */
export function deriveSuggestionChips(state: ChipState): TutorSuggestionChip[] {
  const chips: TutorSuggestionChip[] = [];

  // 1 · Explain — varies with the active lesson.
  chips.push(
    state.lessonTitle
      ? { key: "explain", label: `Explain ${short(state.lessonTitle)} simply`, message: `Explain ${state.lessonTitle} simply` }
      : { key: "explain", label: "Explain this simply", message: "Explain this simply" }
  );

  // 2 · Quiz — PINNED string (the practice classifier depends on it).
  chips.push({ key: "quiz", label: "Quiz me on this lesson", message: QUIZ_CHIP_MESSAGE });

  // 3 · Review — varies with MASTERY: name the weakest flagged concept when known.
  if (state.weakestConceptTitle) {
    chips.push({ key: "review", label: `Review ${short(state.weakestConceptTitle)}`, message: `Help me review ${state.weakestConceptTitle}` });
  } else if (state.reviewCount > 0) {
    chips.push({ key: "review", label: "Review what I've missed", message: "What should I review next?" });
  } else {
    chips.push({ key: "review", label: "What should I review next?", message: "What should I review next?" });
  }

  // 4 · Plan vs. Summarize — varies with conversation context.
  chips.push(
    state.hasHistory
      ? { key: "recap", label: "Summarize what we covered", message: "Summarize what we've covered so far" }
      : { key: "plan", label: "Make me a study plan", message: "Make me a study plan" }
  );

  // Dedup by ACTION (message), order-preserving (A3 §4).
  const seen = new Set<string>();
  return chips.filter((c) => (seen.has(c.message) ? false : (seen.add(c.message), true)));
}
