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

/** A slide a structured-layout slide is "thin" below this much plain text. */
export const THIN_SLIDE_CHARS = 120;
/** Above this, a slide reads as dense. */
const DENSE_SLIDE_CHARS = 420;

/** Total plain-text length across a structured template's RichText slots (skips
 *  `runs`, which duplicate `.text`). Cheap proxy for "did this slide say much?". */
export function templateTextLength(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((s: number, n) => s + templateTextLength(n), 0);
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  let len = typeof o.text === "string" ? o.text.length : 0;
  for (const [k, v] of Object.entries(o)) if (k !== "runs" && k !== "text") len += templateTextLength(v);
  return len;
}

function slideTextLength(s: Slide): number {
  if (s.template) return templateTextLength(s.template.content);
  // Flat slide: sum element text.
  return s.elements.reduce((n, e) => n + ((e as { text?: string }).text?.length ?? 0), 0);
}

function density(len: number): "low" | "medium" | "high" {
  if (len < THIN_SLIDE_CHARS) return "low";
  if (len > DENSE_SLIDE_CHARS) return "high";
  return "medium";
}

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
    hasVisual: s.elements.some((e) => e.type === "image" || e.type === "sticker"),
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

  let planProgress: GenerationState["planProgress"];
  const openIssues: string[] = [];
  if (opts.outline) {
    const builtSpecIds = new Set(allSlides.map((s) => s.specId).filter((x): x is string => !!x));
    const slideSpecsCompleted = opts.outline.slides.map((s) => s.id).filter((id) => builtSpecIds.has(id));
    const slideSpecsRemaining = opts.outline.slides.map((s) => s.id).filter((id) => !builtSpecIds.has(id));
    planProgress = {
      totalSlidesPlanned: opts.outline.slides.length,
      slidesCreated: allSlides.length,
      slideSpecsCompleted,
      slideSpecsRemaining,
    };
    for (const id of slideSpecsRemaining) {
      const spec = opts.outline.slides.find((s) => s.id === id);
      if (spec) openIssues.push(`slide spec ${id} ("${spec.title || spec.teachingGoal}") not yet built`);
    }
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
      `Plan: ${p.slideSpecsCompleted.length}/${p.totalSlidesPlanned} planned slides built (${p.slidesCreated} slide(s) total).` +
        (p.slideSpecsRemaining.length ? ` Remaining specs: ${p.slideSpecsRemaining.join(", ")}.` : " All planned specs built.")
    );
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
