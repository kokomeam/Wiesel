/**
 * GenerationState — a COMPACT, deterministic snapshot of what the agent has
 * built so far, derived purely from the in-memory course doc (never by asking
 * the model to summarize itself).
 *
 * This is what replaces replaying the full tool transcript every turn: instead of
 * re-sending every prior `get_deck` / `add_slide` output, the bounded-input
 * builder injects this summary — the current TRUTH of the lesson — plus the last
 * few tool events. The agent always knows what exists, what's planned, and what's
 * still missing, at a tiny fixed cost.
 */

import { findLesson } from "@/lib/course/queries";
import type {
  CourseDocument,
  HomeworkBlock,
  LectureTextBlock,
  QuizBlock,
  Slide,
  SlideDeckBlock,
} from "@/lib/course/types";
import type { LessonOutline } from "./outline";
import {
  density,
  isPlaceholderSlide,
  slideTextLength,
  templateTextLength as templateTextLengthLeaf,
  THIN_SLIDE_CHARS as THIN_SLIDE_CHARS_LEAF,
} from "./slideDiagnostics";

/** Re-exported from the leaf so existing importers (phases.ts) stay unchanged. */
export const THIN_SLIDE_CHARS = THIN_SLIDE_CHARS_LEAF;
export const templateTextLength = templateTextLengthLeaf;

export interface RecentChange {
  turn: number;
  toolName: string;
  summary: string;
}

export interface SlideSummary {
  id: string;
  order: number;
  title?: string;
  layout?: string;
  textDensity: "low" | "medium" | "high";
  hasVisual: boolean;
  hasSpeakerNotes: boolean;
  /** The PLAN spec id this slide was authored to satisfy (if stamped). */
  specId?: string;
}

export interface GenerationState {
  phase: string;
  lessonId: string;
  planProgress?: {
    totalSlidesPlanned: number;
    slidesCreated: number;
    slideSpecsCompleted: string[];
    slideSpecsRemaining: string[];
    /** Specs claimed by more than one slide (the model must repurpose/remove). */
    duplicateSpecIds: string[];
    /** Slides carrying no recognized plan spec id (extra / unstamped). */
    slidesWithoutSpec: number;
    /** Default-placeholder slides still present (must be removed before finalize). */
    placeholderSlides: number;
    /** Plan segments that still have at least one unbuilt slide spec. */
    segmentsIncomplete: string[];
    /** Required auxiliary blocks the plan asked for that don't exist yet. */
    requiredBlocksMissing: string[];
  };
  currentArtifacts: {
    slideDecks: Array<{ blockId: string; title: string; slideCount: number; slides: SlideSummary[] }>;
    quizzes: Array<{ blockId: string; title: string; questionCount: number }>;
    homework: Array<{ blockId: string; title: string; exerciseCount: number }>;
    lectureTextBlocks: Array<{ blockId: string; title: string; approxWords: number }>;
  };
  recentChanges: RecentChange[];
  openIssues: string[];
}

function slideSummary(s: Slide): SlideSummary {
  const len = slideTextLength(s);
  return {
    id: s.id,
    order: s.order,
    title: s.title,
    layout: s.template?.layoutId ?? s.layout,
    textDensity: density(len),
    hasVisual:
      s.template?.layoutId === "diagram" ||
      s.template?.layoutId === "illustration" ||
      s.elements.some((e) => e.type === "image" || e.type === "sticker"),
    hasSpeakerNotes: !!s.speakerNotes?.trim(),
    specId: s.ai?.specId,
  };
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Build the deterministic generation-state snapshot from the in-memory doc. */
export function buildGenerationState(
  doc: CourseDocument,
  lessonId: string,
  opts: { phase: string; outline?: LessonOutline; recentChanges?: RecentChange[] }
): GenerationState {
  const lesson = findLesson(doc, lessonId)?.lesson;
  const blocks = lesson?.blocks ?? [];

  const slideDecks = blocks
    .filter((b): b is SlideDeckBlock => b.type === "slide_deck")
    .map((d) => ({
      blockId: d.id,
      title: d.title ?? "Untitled deck",
      slideCount: d.slides.length,
      slides: d.slides.map(slideSummary),
    }));
  const quizzes = blocks
    .filter((b): b is QuizBlock => b.type === "quiz")
    .map((q) => ({ blockId: q.id, title: q.title ?? "Knowledge check", questionCount: q.questions.length }));
  const homework = blocks
    .filter((b): b is HomeworkBlock => b.type === "homework")
    .map((h) => ({ blockId: h.id, title: h.title ?? "Practice", exerciseCount: h.exercises.length }));
  const lectureTextBlocks = blocks
    .filter((b): b is LectureTextBlock => b.type === "lecture_text")
    .map((l) => ({ blockId: l.id, title: l.title ?? "Lecture", approxWords: l.paragraphs.reduce((n, p) => n + wordCount(p.text), 0) }));

  const allSlides = slideDecks.flatMap((d) => d.slides);
  // The raw slides (the summaries drop `template`/`elements` we need for the
  // placeholder + duplicate-spec checks), keyed for the richer plan progress.
  const rawSlides = (lesson?.blocks ?? [])
    .filter((b): b is SlideDeckBlock => b.type === "slide_deck")
    .flatMap((d) => d.slides);

  let planProgress: GenerationState["planProgress"];
  const openIssues: string[] = [];
  if (opts.outline) {
    const planned = opts.outline.slides.map((s) => s.id);
    const plannedSet = new Set(planned);
    // Count how many slides claim each spec id (≥2 = duplicate).
    const specCounts = new Map<string, number>();
    for (const s of rawSlides) {
      const id = s.ai?.specId;
      if (id) specCounts.set(id, (specCounts.get(id) ?? 0) + 1);
    }
    const builtSpecIds = new Set([...specCounts.keys()].filter((id) => plannedSet.has(id)));
    const slideSpecsCompleted = planned.filter((id) => builtSpecIds.has(id));
    const slideSpecsRemaining = planned.filter((id) => !builtSpecIds.has(id));
    const duplicateSpecIds = [...specCounts.entries()]
      .filter(([id, n]) => plannedSet.has(id) && n > 1)
      .map(([id]) => id);
    const slidesWithoutSpec = rawSlides.filter((s) => !s.ai?.specId || !plannedSet.has(s.ai.specId)).length;
    const placeholderSlides = rawSlides.filter(isPlaceholderSlide).length;
    const segmentsIncomplete = opts.outline.segments
      .filter((seg) => seg.slideSpecIds.some((id) => slideSpecsRemaining.includes(id)))
      .map((seg) => seg.name || seg.id);
    const requiredBlocksMissing: string[] = [];
    if (opts.outline.quizPlan && quizzes.length === 0) requiredBlocksMissing.push("quiz");
    if (opts.outline.homeworkPlan && homework.length === 0) requiredBlocksMissing.push("homework");

    planProgress = {
      totalSlidesPlanned: planned.length,
      slidesCreated: allSlides.length,
      slideSpecsCompleted,
      slideSpecsRemaining,
      duplicateSpecIds,
      slidesWithoutSpec,
      placeholderSlides,
      segmentsIncomplete,
      requiredBlocksMissing,
    };
    for (const id of slideSpecsRemaining) {
      const spec = opts.outline.slides.find((s) => s.id === id);
      if (spec) openIssues.push(`BUILD slide spec ${id} ("${spec.title || spec.teachingGoal}") — not yet built`);
    }
    if (placeholderSlides > 0) openIssues.push(`${placeholderSlides} default placeholder slide(s) must be removed`);
    for (const id of duplicateSpecIds) openIssues.push(`spec ${id} is claimed by >1 slide — keep one, repurpose the other`);
    for (const b of requiredBlocksMissing) openIssues.push(`the plan requires a ${b} block — not yet created`);
  }
  for (const d of slideDecks) {
    for (const s of d.slides) {
      if (s.textDensity === "low") openIssues.push(`slide ${s.id} is thin — expand its teaching content`);
      if (!s.hasSpeakerNotes) openIssues.push(`slide ${s.id} has no speaker notes`);
    }
  }

  return {
    phase: opts.phase,
    lessonId,
    planProgress,
    currentArtifacts: { slideDecks, quizzes, homework, lectureTextBlocks },
    recentChanges: opts.recentChanges ?? [],
    openIssues,
  };
}

export interface PlanCoverage {
  plannedSlides: number;
  generatedSlides: number;
  coveredSlideSpecs: number;
  missingSlideSpecs: string[];
  extraSlides: string[];
}

/** Exact plan coverage: match the doc's slides (by their stamped `ai.specId`)
 *  against the outline's slide-spec ids. Drives the post-GENERATE measurement. */
export function computePlanCoverage(doc: CourseDocument, lessonId: string, outline: LessonOutline): PlanCoverage {
  const lesson = findLesson(doc, lessonId)?.lesson;
  const slides = (lesson?.blocks ?? [])
    .filter((b): b is SlideDeckBlock => b.type === "slide_deck")
    .flatMap((d) => d.slides);
  const specIds = new Set(outline.slides.map((s) => s.id));
  const builtSpecIds = new Set(slides.map((s) => s.ai?.specId).filter((x): x is string => !!x));
  const missingSlideSpecs = outline.slides.map((s) => s.id).filter((id) => !builtSpecIds.has(id));
  const coveredSlideSpecs = outline.slides.length - missingSlideSpecs.length;
  const extraSlides = slides.filter((s) => !s.ai?.specId || !specIds.has(s.ai.specId)).map((s) => s.id);
  return {
    plannedSlides: outline.slides.length,
    generatedSlides: slides.length,
    coveredSlideSpecs,
    missingSlideSpecs,
    extraSlides,
  };
}

/** Serialize the state into a compact developer-message string, capped at
 *  `maxChars`. Lines are emitted highest-value first (plan progress → artifacts →
 *  recent changes → openIssues), so an over-cap string is end-truncated from the
 *  lowest-value tail (recentChanges / openIssues) while the plan + artifact
 *  summary is preserved. */
export function serializeGenerationState(state: GenerationState, maxChars: number): string {
  const a = state.currentArtifacts;
  const lines: string[] = ["GENERATION STATE (current truth of this lesson — build from here, do not re-read what's listed):"];

  if (state.planProgress) {
    const p = state.planProgress;
    lines.push(
      `Plan coverage: ${p.slideSpecsCompleted.length}/${p.totalSlidesPlanned} planned slides built (${p.slidesCreated} slide(s) total).` +
        (p.slideSpecsRemaining.length
          ? ` STILL TO BUILD (use these exact slideSpecIds): ${p.slideSpecsRemaining.join(", ")}.`
          : " All planned specs built.")
    );
    if (p.segmentsIncomplete.length) lines.push(`Segments not finished: ${p.segmentsIncomplete.join("; ")}.`);
    if (p.duplicateSpecIds.length) lines.push(`Duplicate specs (>1 slide each): ${p.duplicateSpecIds.join(", ")} — keep one, repurpose the other.`);
    if (p.placeholderSlides > 0) lines.push(`Placeholder slides present: ${p.placeholderSlides} — these get removed automatically; author real slides.`);
    if (p.slidesWithoutSpec > 0) lines.push(`Slides with no plan spec id: ${p.slidesWithoutSpec} — stamp each generated slide with its slideSpecId.`);
    if (p.requiredBlocksMissing.length) lines.push(`Required blocks still missing: ${p.requiredBlocksMissing.join(", ")}.`);
  }

  if (a.slideDecks.length) {
    for (const d of a.slideDecks) {
      lines.push(`Deck "${d.title}" (${d.blockId}) — ${d.slideCount} slide(s):`);
      for (const s of d.slides) {
        const flags = [s.hasSpeakerNotes ? "notes" : "no-notes", s.textDensity, s.specId ? `spec=${s.specId}` : null]
          .filter(Boolean)
          .join("/");
        lines.push(`  #${s.order} ${s.id} [${s.layout}] ${s.title ?? ""} (${flags})`);
      }
    }
  } else {
    lines.push("No slide deck yet.");
  }
  if (a.quizzes.length) lines.push(`Quizzes: ${a.quizzes.map((q) => `${q.title} (${q.questionCount}q)`).join("; ")}.`);
  if (a.homework.length) lines.push(`Homework: ${a.homework.map((h) => `${h.title} (${h.exerciseCount} ex)`).join("; ")}.`);
  if (a.lectureTextBlocks.length) lines.push(`Lecture text: ${a.lectureTextBlocks.map((l) => `${l.title} (~${l.approxWords}w)`).join("; ")}.`);

  if (state.recentChanges.length) {
    lines.push("Recent: " + state.recentChanges.map((c) => `${c.toolName} — ${c.summary}`).join("; ") + ".");
  }
  if (state.openIssues.length) {
    lines.push("Open issues: " + state.openIssues.slice(0, 12).join("; ") + ".");
  }

  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}
