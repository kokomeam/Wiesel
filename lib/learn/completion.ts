/**
 * PURE lesson/course completion rules (Milestone 2 — fixed and documented).
 *
 * THE RULE: a lesson is complete when
 *   • every trackable CONTENT unit is consumed — all slides of every native
 *     deck viewed, every imported deck paged to the end, every video watched
 *     to ≥ VIDEO_COMPLETE_PCT — AND
 *   • every quiz in the lesson has ≥ 1 submitted attempt (any score — quizzes
 *     are low-stakes knowledge checks, never gates on being RIGHT).
 * A lesson with NO trackable units (only lecture text / examples / exercises /
 * resources / homework) gets an explicit "mark complete" control instead —
 * `markedComplete` is honored ONLY for those lessons, so a trackable lesson
 * can never be self-attested.
 *
 * Course completion = every lesson in the LIVE snapshot complete → the
 * enrollment flips to `completed` (server-side; it never downgrades
 * automatically if a republish later adds lessons — Teachable convention).
 *
 * What counts as trackable (decided against the frozen snapshot):
 *   slide_deck     — has ≥ 1 slide.
 *   imported_deck  — status "ready" with ≥ 1 page (binary: paged to the end).
 *   video          — asset snapshot status "ready" (an unplayable video must
 *                    never make a lesson uncompletable).
 *   quiz           — has ≥ 1 question.
 * Everything else is reading material with no meaningful "done" signal.
 *
 * pct is the mean of per-unit fractions (slides viewed/total; video
 * min(pct/90, 1); binary units 0|1), rounded to an integer. Slide/viewed sets
 * are INTERSECTED with the current snapshot's ids, so a republish that removes
 * slides can only ever help, never strand a learner at 99%.
 */

import type { PublishedLesson, PublicationSnapshot } from "@/lib/course/publish/schemas";
import type { ProgressState } from "./schemas";

export const VIDEO_COMPLETE_PCT = 90;

export type TrackableUnit =
  | { kind: "slides"; blockId: string; slideIds: string[] }
  | { kind: "imported_deck"; blockId: string }
  | { kind: "video"; blockId: string }
  | { kind: "quiz"; blockId: string };

export function lessonTrackables(lesson: PublishedLesson): TrackableUnit[] {
  const units: TrackableUnit[] = [];
  for (const block of lesson.blocks) {
    switch (block.type) {
      case "slide_deck":
        if (block.slides.length > 0) {
          units.push({
            kind: "slides",
            blockId: block.id,
            slideIds: block.slides.map((s) => s.id),
          });
        }
        break;
      case "imported_deck":
        if (block.status === "ready" && (block.pageCount ?? 0) > 0) {
          units.push({ kind: "imported_deck", blockId: block.id });
        }
        break;
      case "video":
        if (block.asset.status === "ready") {
          units.push({ kind: "video", blockId: block.id });
        }
        break;
      case "quiz":
        if (block.questions.length > 0) {
          units.push({ kind: "quiz", blockId: block.id });
        }
        break;
      default:
        break;
    }
  }
  return units;
}

export interface LessonProgressComputation {
  /** False when the lesson has no trackable units (mark-complete lessons). */
  trackable: boolean;
  completed: boolean;
  /** 0–100 integer. */
  pct: number;
}

function unitFraction(
  unit: TrackableUnit,
  state: ProgressState,
  attemptedQuizBlockIds: ReadonlySet<string>
): number {
  switch (unit.kind) {
    case "slides": {
      const viewed = new Set(state.viewedSlides?.[unit.blockId] ?? []);
      const seen = unit.slideIds.filter((id) => viewed.has(id)).length;
      return unit.slideIds.length === 0 ? 1 : seen / unit.slideIds.length;
    }
    case "imported_deck":
      return state.viewedBlocks?.includes(unit.blockId) ? 1 : 0;
    case "video": {
      const pct = state.videoPct?.[unit.blockId] ?? 0;
      return Math.min(pct / VIDEO_COMPLETE_PCT, 1);
    }
    case "quiz":
      return attemptedQuizBlockIds.has(unit.blockId) ? 1 : 0;
  }
}

export function computeLessonProgress(
  lesson: PublishedLesson,
  state: ProgressState,
  attemptedQuizBlockIds: ReadonlySet<string>
): LessonProgressComputation {
  const units = lessonTrackables(lesson);
  if (units.length === 0) {
    const completed = state.markedComplete === true;
    return { trackable: false, completed, pct: completed ? 100 : 0 };
  }
  const fractions = units.map((u) => unitFraction(u, state, attemptedQuizBlockIds));
  const completed = fractions.every((f) => f >= 1);
  const pct = completed
    ? 100
    : Math.min(
        99, // partial progress never rounds up to a false 100
        Math.round((fractions.reduce((a, b) => a + b, 0) / fractions.length) * 100)
      );
  return { trackable: true, completed, pct };
}

/** All lesson ids of a snapshot in reading order (modules → lessons). */
export function snapshotLessonIds(snapshot: PublicationSnapshot): string[] {
  return snapshot.modules.flatMap((m) => m.lessons.map((l) => l.id));
}

export function findSnapshotLesson(
  snapshot: PublicationSnapshot,
  lessonId: string
): PublishedLesson | null {
  for (const courseModule of snapshot.modules) {
    const lesson = courseModule.lessons.find((l) => l.id === lessonId);
    if (lesson) return lesson;
  }
  return null;
}

/** Course completion = every lesson id in the snapshot is in the completed set. */
export function isCourseComplete(
  snapshot: PublicationSnapshot,
  completedLessonIds: ReadonlySet<string>
): boolean {
  const ids = snapshotLessonIds(snapshot);
  return ids.length > 0 && ids.every((id) => completedLessonIds.has(id));
}
