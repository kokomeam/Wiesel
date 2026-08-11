/**
 * TUTOR-1 Amendment A4, Wave 3 — FORWARD-material detection (pure).
 *
 * A question requires FORWARD material when its concept lives ONLY in a lesson the
 * learner has not completed (and isn't the active one) — i.e. no ELIGIBLE lesson
 * covers it. The tutor must NAME where it's covered and decline to teach it ahead
 * of time (A4-17) — never silently omit, never answer from model knowledge.
 */

import type { LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import { questionConcepts, anchorLessonIds } from "./conceptLessons";

export interface ForwardMaterial {
  /** The incomplete lesson that covers the question. */
  lessonId: string;
  /** Its title (for the learner-facing "covered in …"), when known. */
  lessonTitle: string | null;
  /** The concept the question named. */
  concept: string;
}

/**
 * Detect forward material: the FIRST question-concept whose covering lessons are
 * ALL ineligible (not completed, not active). Returns null when every named
 * concept is answerable within an eligible lesson (or none is named).
 */
export function detectForwardMaterial(args: {
  nodes: LessonConceptNode[];
  message: string;
  eligible: Set<string>;
  lessonTitleById?: Map<string, string>;
}): ForwardMaterial | null {
  for (const c of questionConcepts(args.nodes, args.message)) {
    const lessons = anchorLessonIds(c);
    if (lessons.length === 0) continue;
    // Answerable locally if ANY covering lesson is eligible → not forward.
    if (lessons.some((l) => args.eligible.has(l))) continue;
    const lessonId = lessons[0];
    return { lessonId, lessonTitle: args.lessonTitleById?.get(lessonId) ?? null, concept: c.title };
  }
  return null;
}
