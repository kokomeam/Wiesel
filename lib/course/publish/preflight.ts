/**
 * Publish pre-flight — PURE. Decides what BLOCKS a publish (errors: the
 * course is structurally unservable or a quiz can't be graded) and what is
 * merely worth flagging (warnings: quality issues, still-processing assets).
 * Warnings are shown but overridable; errors are not.
 *
 * Reuses the existing slide quality linter (lib/course/lint.ts) for per-slide
 * warnings — the TEXT_CLIPPED check silently skips server-side (its DOM
 * measurer is only registered in the editor), which is fine: pre-flight is a
 * gate, not the editor badge.
 */

import { lintSlide } from "@/lib/course/lint";
import type {
  CourseDocument,
  LessonBlock,
  QuizQuestion,
  Slide,
} from "@/lib/course/types";
import type { PreflightIssue, PreflightReport } from "./schemas";

type Where = NonNullable<PreflightIssue["where"]>;

function questionKeyError(q: QuizQuestion): string | null {
  if (!q.prompt.trim()) return "The question has no prompt.";
  switch (q.kind) {
    case "multiple_choice": {
      if (q.choices.length < 2) return "Multiple-choice needs at least two choices.";
      if (!q.choices.some((c) => c.id === q.correctChoiceId))
        return "The correct answer doesn't match any choice.";
      return null;
    }
    case "multi_select": {
      if (q.choices.length < 2) return "Multi-select needs at least two choices.";
      if (q.correctChoiceIds.length === 0) return "No correct choices are marked.";
      const ids = new Set(q.choices.map((c) => c.id));
      if (!q.correctChoiceIds.every((id) => ids.has(id)))
        return "A correct choice id doesn't match any choice.";
      return null;
    }
    case "true_false":
      return null;
    case "short_answer":
      return q.expectedAnswer.trim() ? null : "The expected answer is empty.";
  }
}

/** Structured image slides that are still waiting on (or failed) generation. */
function pendingImageIssue(slide: Slide): string | null {
  const t = slide.template;
  if (!t) return null;
  if (
    t.layoutId === "illustration" ||
    t.layoutId === "image_reference" ||
    t.layoutId === "image_supporting"
  ) {
    const content = t.content as { imageUrl: string; pendingGen?: { status: string } };
    if (content.pendingGen?.status === "failed") return "Its image generation failed.";
    if (content.pendingGen || !content.imageUrl) return "Its image is still being generated.";
  }
  return null;
}

export function runPublishPreflight(doc: CourseDocument): PreflightReport {
  const errors: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];
  const error = (code: string, message: string, where?: Where) =>
    errors.push({ code, severity: "error", message, where });
  const warn = (code: string, message: string, where?: Where) =>
    warnings.push({ code, severity: "warning", message, where });

  if (!doc.title.trim()) {
    error("COURSE_UNTITLED", "Give the course a title before publishing.");
  }
  if (!doc.description?.trim()) {
    warn("NO_DESCRIPTION", "The course has no description — learners see it on the course page.");
  }

  let lessonCount = 0;
  let blockCount = 0;
  let slideCount = 0;
  let hasContent = false;

  for (const m of doc.modules) {
    if (m.lessons.length === 0) {
      warn("EMPTY_MODULE", `Module “${m.title}” has no lessons.`, { moduleId: m.id });
    }
    for (const l of m.lessons) {
      lessonCount++;
      const where: Where = { moduleId: m.id, lessonId: l.id };
      if (l.blocks.length === 0) {
        warn("EMPTY_LESSON", `Lesson “${l.title}” has no content.`, where);
      } else {
        hasContent = true;
      }
      for (const b of l.blocks) {
        blockCount++;
        checkBlock(b, { ...where, blockId: b.id });
      }
    }
  }

  function checkBlock(b: LessonBlock, where: Where): void {
    switch (b.type) {
      case "quiz": {
        if (b.questions.length === 0) {
          warn("EMPTY_QUIZ", `A knowledge check has no questions.`, where);
        }
        for (const q of b.questions) {
          const problem = questionKeyError(q);
          if (problem) {
            error(
              "QUIZ_QUESTION_INVALID",
              `A quiz question can't be graded: ${problem}`,
              { ...where, questionId: q.id }
            );
          }
        }
        return;
      }
      case "slide_deck": {
        for (const slide of b.slides) {
          slideCount++;
          const slideWhere: Where = { ...where, slideId: slide.id };
          const pending = pendingImageIssue(slide);
          if (pending) {
            warn("IMAGE_PENDING", `A slide isn't visual-complete: ${pending}`, slideWhere);
          }
          // Structured/template slides render themselves; the element linter
          // only applies to freeform element slides.
          if (!slide.template) {
            for (const hint of lintSlide(slide, { blockId: b.id })) {
              warn(`SLIDE_${hint.code}`, hint.message, slideWhere);
            }
          }
        }
        return;
      }
      case "imported_deck": {
        if (b.status !== "ready") {
          warn(
            "IMPORTED_DECK_NOT_READY",
            `The imported deck “${b.originalFileName}” isn't processed yet (${b.status}).`,
            where
          );
        }
        return;
      }
      case "video": {
        if (b.asset.status !== "ready") {
          warn(
            "VIDEO_NOT_READY",
            `A video lesson isn't ready to play yet (${b.asset.status}).`,
            where
          );
        }
        return;
      }
      default:
        return;
    }
  }

  if (!hasContent) {
    error("NO_CONTENT", "Add at least one lesson with content before publishing.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      modules: doc.modules.length,
      lessons: lessonCount,
      blocks: blockCount,
      slides: slideCount,
    },
  };
}
