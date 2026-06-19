/**
 * Post-GENERATE VALIDATION — deterministic correctness enforcement (NOT critique).
 *
 * The approved plan is a CONTRACT. After generation, this pure pass inspects the
 * in-memory document against the plan and reports HARD failures that must block a
 * "done" claim (a leftover placeholder slide, missing planned slides, a deck short
 * of its contract, a required quiz/homework that never got built). The pipeline
 * then repairs them — deterministically where it can (delete the placeholder),
 * with one narrow model pass where it must (build the missing slides) — and
 * re-validates before staging the change-set. Soft, subjective quality lives in
 * lintGeneration.ts; this file only decides "is the contract satisfied?".
 *
 * No model, no DB — trivially testable.
 */

import { deleteBlockPatch, deleteSlidePatch } from "@/lib/course/commands";
import type { CoursePatch } from "@/lib/course/patches";
import { findLesson } from "@/lib/course/queries";
import type { CourseDocument, Slide, SlideDeckBlock } from "@/lib/course/types";
import { computePlanCoverage, type PlanCoverage } from "./generationState";
import type { LessonOutline } from "./outline";
import { isEmptySlide, isPlaceholderSlide } from "./slideDiagnostics";

export type HardFailureCode =
  | "NO_DECK"
  | "PLACEHOLDER_SLIDE"
  | "EMPTY_SLIDE"
  | "MISSING_SLIDE_SPECS"
  | "DUPLICATE_SPEC"
  | "REQUIRED_BLOCK_MISSING";

export interface ValidationIssue {
  code: HardFailureCode;
  message: string;
}

export interface ValidationReport {
  /** True when there are NO hard failures (the contract is satisfied). */
  ok: boolean;
  issues: ValidationIssue[];
  coverage: PlanCoverage;
  /** Planned spec ids with no built slide. */
  missingSpecIds: string[];
  /** Specs claimed by more than one slide. */
  duplicateSpecIds: string[];
  /** Slide ids of leftover default placeholders. */
  placeholderSlideIds: string[];
  /** Slide ids of empty (no-content) slides. */
  emptySlideIds: string[];
  /** Auxiliary blocks the plan required but that don't exist. */
  requiredBlocksMissing: ("quiz" | "homework")[];
  /** Planned slide count (the contract). */
  expectedSlides: number;
  /** Real (non-placeholder, non-empty) slides currently in the deck(s). */
  realSlides: number;
  /** The run stopped on a budget/turn cap before the contract was met. */
  budgetExhausted: boolean;
  /** The deck a model-repair pass should author into (first deck, if any). */
  deckBlockId: string | null;
}

/** Hard failures a MODEL repair pass can fix (vs the deterministic ones). */
export function hasModelRepairableFailure(report: ValidationReport): boolean {
  return (
    report.missingSpecIds.length > 0 ||
    report.duplicateSpecIds.length > 0 ||
    report.requiredBlocksMissing.length > 0
  );
}

function lessonDecks(doc: CourseDocument, lessonId: string): SlideDeckBlock[] {
  const lesson = findLesson(doc, lessonId)?.lesson;
  return (lesson?.blocks ?? []).filter((b): b is SlideDeckBlock => b.type === "slide_deck");
}

/**
 * Validate a generated lesson against its approved plan. `opts.checkpointed` =
 * the GENERATE/repair loop stopped on a budget or per-turn cap (so an unmet
 * contract is "ran out of room", not "the model gave up arbitrarily").
 */
export function validateLessonGeneration(
  doc: CourseDocument,
  lessonId: string,
  outline: LessonOutline,
  opts: { checkpointed?: boolean } = {}
): ValidationReport {
  const lesson = findLesson(doc, lessonId)?.lesson;
  const blocks = lesson?.blocks ?? [];
  const decks = lessonDecks(doc, lessonId);
  const slides: Slide[] = decks.flatMap((d) => d.slides);

  const placeholderSlideIds = slides.filter(isPlaceholderSlide).map((s) => s.id);
  const emptySlideIds = slides
    .filter((s) => !isPlaceholderSlide(s) && isEmptySlide(s))
    .map((s) => s.id);
  const junk = new Set([...placeholderSlideIds, ...emptySlideIds]);
  const realSlides = slides.filter((s) => !junk.has(s.id));

  const coverage = computePlanCoverage(doc, lessonId, outline);
  const missingSpecIds = coverage.missingSlideSpecs;

  // Duplicate primary specs: a planned spec claimed by >1 slide.
  const specCounts = new Map<string, number>();
  const plannedSet = new Set(outline.slides.map((s) => s.id));
  for (const s of slides) {
    const id = s.ai?.specId;
    if (id && plannedSet.has(id)) specCounts.set(id, (specCounts.get(id) ?? 0) + 1);
  }
  const duplicateSpecIds = [...specCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  const requiredBlocksMissing: ("quiz" | "homework")[] = [];
  if (outline.quizPlan && !blocks.some((b) => b.type === "quiz")) requiredBlocksMissing.push("quiz");
  if (outline.homeworkPlan && !blocks.some((b) => b.type === "homework")) requiredBlocksMissing.push("homework");

  const expectedSlides = outline.slides.length;
  const issues: ValidationIssue[] = [];

  if (decks.length === 0 && expectedSlides > 0) {
    issues.push({ code: "NO_DECK", message: "The lesson has no slide deck, but the plan called for one." });
  }
  if (placeholderSlideIds.length > 0) {
    issues.push({
      code: "PLACEHOLDER_SLIDE",
      message: `${placeholderSlideIds.length} default placeholder slide(s) remain — they must be removed.`,
    });
  }
  if (emptySlideIds.length > 0) {
    issues.push({ code: "EMPTY_SLIDE", message: `${emptySlideIds.length} empty slide(s) have no content.` });
  }
  if (missingSpecIds.length > 0) {
    issues.push({
      code: "MISSING_SLIDE_SPECS",
      message: `${missingSpecIds.length} of ${expectedSlides} planned slide(s) weren't built (${missingSpecIds.join(", ")}).`,
    });
  }
  if (duplicateSpecIds.length > 0) {
    issues.push({
      code: "DUPLICATE_SPEC",
      message: `${duplicateSpecIds.length} planned spec(s) are claimed by more than one slide (${duplicateSpecIds.join(", ")}).`,
    });
  }
  if (requiredBlocksMissing.length > 0) {
    issues.push({
      code: "REQUIRED_BLOCK_MISSING",
      message: `The plan required a ${requiredBlocksMissing.join(" and ")} block that wasn't created.`,
    });
  }

  const ok = issues.length === 0;
  const budgetExhausted =
    !ok && !!opts.checkpointed && (missingSpecIds.length > 0 || requiredBlocksMissing.length > 0);

  return {
    ok,
    issues,
    coverage,
    missingSpecIds,
    duplicateSpecIds,
    placeholderSlideIds,
    emptySlideIds,
    requiredBlocksMissing,
    expectedSlides,
    realSlides: realSlides.length,
    budgetExhausted,
    deckBlockId: decks[0]?.id ?? null,
  };
}

/**
 * Deterministic repair: remove placeholder + empty SLIDES (no model). A deck whose
 * every slide is junk is dropped whole (DELETE_SLIDE refuses to empty a deck);
 * a deck with real content keeps it and loses only the junk slides. A genuinely
 * empty deck (0 slides — the pre-created authoring target) is left for the model
 * to fill (prune it later with `pruneEmptyDeckPatches` if it never does).
 */
export function placeholderRepairPatches(
  doc: CourseDocument,
  lessonId: string,
  report: ValidationReport
): CoursePatch[] {
  const junk = new Set([...report.placeholderSlideIds, ...report.emptySlideIds]);
  if (junk.size === 0) return [];
  const patches: CoursePatch[] = [];
  for (const deck of lessonDecks(doc, lessonId)) {
    const junkInDeck = deck.slides.filter((s) => junk.has(s.id));
    if (junkInDeck.length === 0) continue;
    const realRemaining = deck.slides.length - junkInDeck.length;
    if (realRemaining <= 0) {
      // Entire deck is junk (e.g. a stray placeholder-only deck) → drop it whole.
      patches.push(deleteBlockPatch(lessonId, deck.id));
    } else {
      for (const s of junkInDeck) patches.push(deleteSlidePatch(deck.id, s.id));
    }
  }
  return patches;
}

/** Drop any slide deck left with zero slides (generation produced nothing) — so
 *  an empty deck is never staged as if it were a finished artifact. Final cleanup
 *  only; during repair the empty deck is the authoring target. */
export function pruneEmptyDeckPatches(doc: CourseDocument, lessonId: string): CoursePatch[] {
  return lessonDecks(doc, lessonId)
    .filter((d) => d.slides.length === 0)
    .map((d) => deleteBlockPatch(lessonId, d.id));
}

/** A compact, user-facing summary of what validation found / fixed (drives the
 *  calm progress lines in the agent panel). */
export function validationSummaryLine(report: ValidationReport): string {
  if (report.ok) return "Final validation passed.";
  const parts: string[] = [];
  if (report.missingSpecIds.length) parts.push(`${report.missingSpecIds.length} missing slide(s)`);
  if (report.placeholderSlideIds.length) parts.push(`${report.placeholderSlideIds.length} placeholder slide(s)`);
  if (report.emptySlideIds.length) parts.push(`${report.emptySlideIds.length} empty slide(s)`);
  if (report.duplicateSpecIds.length) parts.push(`${report.duplicateSpecIds.length} duplicate slide(s)`);
  if (report.requiredBlocksMissing.length) parts.push(`a missing ${report.requiredBlocksMissing.join(" + ")}`);
  return parts.length ? `Found ${parts.join(", ")}.` : "Found issues to repair.";
}
