/**
 * "This course includes" summary (PURE) — counts what a live publication
 * SNAPSHOT actually contains, for the public landing page. Reads only the
 * published document (never draft rows), so the numbers always match what a
 * learner will receive.
 */

import type { PublicationSnapshot } from "@/lib/course/publish/schemas";

export type CourseContentSummary = {
  moduleCount: number;
  lessonCount: number;
  slideDeckCount: number;
  slideCount: number;
  videoCount: number;
  quizCount: number;
  questionCount: number;
  homeworkCount: number;
  /** lecture_text / example / exercise / resource blocks. */
  readingCount: number;
  /** Sum of lesson estimatedMinutes (authored estimates, not measured). */
  totalMinutes: number;
};

export function summarizeCourseContents(snapshot: PublicationSnapshot): CourseContentSummary {
  const summary: CourseContentSummary = {
    moduleCount: snapshot.modules.length,
    lessonCount: 0,
    slideDeckCount: 0,
    slideCount: 0,
    videoCount: 0,
    quizCount: 0,
    questionCount: 0,
    homeworkCount: 0,
    readingCount: 0,
    totalMinutes: 0,
  };
  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) {
      summary.lessonCount++;
      summary.totalMinutes += lesson.estimatedMinutes ?? 0;
      for (const block of lesson.blocks) {
        switch (block.type) {
          case "slide_deck":
            summary.slideDeckCount++;
            summary.slideCount += block.slides.length;
            break;
          case "video":
            summary.videoCount++;
            break;
          case "quiz":
            summary.quizCount++;
            summary.questionCount += block.questions.length;
            break;
          case "homework":
            summary.homeworkCount++;
            break;
          case "lecture_text":
          case "example":
          case "exercise":
          case "resource":
            summary.readingCount++;
            break;
          default:
            break; // imported_deck etc. — not surfaced as an includes line
        }
      }
    }
  }
  return summary;
}

export type CourseIncludeIcon =
  | "slides"
  | "video"
  | "quiz"
  | "homework"
  | "reading"
  | "time"
  | "modules";

export type CourseIncludeItem = { icon: CourseIncludeIcon; label: string };

function n(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatMinutes(totalMinutes: number): string {
  const minutes = Math.round(totalMinutes);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/** Human "what's inside" lines — zero-count items are dropped entirely. */
export function courseIncludesItems(summary: CourseContentSummary): CourseIncludeItem[] {
  const items: CourseIncludeItem[] = [];
  if (summary.moduleCount > 0) {
    items.push({
      icon: "modules",
      label: `${n(summary.moduleCount, "module")} · ${n(summary.lessonCount, "lesson")}`,
    });
  }
  if (summary.slideCount > 0) {
    const decks =
      summary.slideDeckCount > 1 ? ` across ${n(summary.slideDeckCount, "deck")}` : "";
    items.push({ icon: "slides", label: `${n(summary.slideCount, "slide")}${decks}` });
  }
  if (summary.videoCount > 0) {
    items.push({ icon: "video", label: n(summary.videoCount, "video lesson") });
  }
  if (summary.quizCount > 0) {
    const questions =
      summary.questionCount > 0 ? ` (${n(summary.questionCount, "question")})` : "";
    items.push({
      icon: "quiz",
      label: `${n(summary.quizCount, "quiz", "quizzes")}${questions}`,
    });
  }
  if (summary.homeworkCount > 0) {
    items.push({ icon: "homework", label: n(summary.homeworkCount, "homework assignment") });
  }
  if (summary.readingCount > 0) {
    items.push({ icon: "reading", label: n(summary.readingCount, "reading & resource") });
  }
  if (summary.totalMinutes > 0) {
    items.push({ icon: "time", label: `About ${formatMinutes(summary.totalMinutes)} of content` });
  }
  return items;
}
