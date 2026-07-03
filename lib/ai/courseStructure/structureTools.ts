/**
 * Course Structure — deterministic emptiness detection + plan execution.
 *
 * PURE over the in-memory CourseDocument. `executeStructurePlan` translates a
 * validated `CourseStructurePlan`'s ops into CoursePatches (reusing the SAME
 * command/factory helpers the studio UI uses) and applies them in order — so the
 * agent has no private write path and every structural change is a normal,
 * reviewable patch. The model-facing `rename_lesson`/`move_lesson` Tool objects
 * live in `lib/ai/tools/structural.ts`; this file is the executor + the
 * emptiness rule the "delete empty lessons" flow depends on.
 */

import {
  deleteLessonPatch,
  deleteModulePatch,
  updateTextPatch,
} from "@/lib/course/commands";
import { createLesson } from "@/lib/course/factories";
import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import { findLesson, findModule } from "@/lib/course/queries";
import type { CourseDocument, LessonBlock, LessonNode } from "@/lib/course/types";
import { isEmptySlide, isPlaceholderSlide } from "../slideDiagnostics";
import type { CourseStructurePlan, StructureOp } from "./types";

/** A single block carries no meaningful content (deterministic — no model). The
 *  "delete empty lessons" flow is only ever allowed to delete lessons every block
 *  of which is empty by THIS definition. */
export function isBlockEmpty(block: LessonBlock): boolean {
  switch (block.type) {
    case "slide_deck":
      // No slides, or every slide is a default placeholder / has no real content.
      return block.slides.length === 0 || block.slides.every((s) => isPlaceholderSlide(s) || isEmptySlide(s));
    case "imported_deck":
      // A user uploaded a real file — never "empty".
      return false;
    case "video":
      // Empty only until a real recording/upload is attached (status !== "empty").
      return block.asset.status === "empty";
    case "lecture_text":
      return block.paragraphs.every((p) => !p.text.trim());
    case "quiz":
      return block.questions.length === 0;
    case "homework":
      return block.exercises.length === 0;
    case "exercise":
      return !block.prompt.trim();
    case "example":
      return !block.takeaway.trim() && !block.explanation.trim() && !block.context.trim() && block.steps.length === 0;
    case "resource":
      return block.links.length === 0;
  }
}

/** A lesson is EMPTY iff it has no blocks, or every block is contentless. This is
 *  the precise, testable definition the structure validation enforces before any
 *  lesson may be deleted by `delete_empty_lessons`. */
export function isLessonEmpty(lesson: LessonNode): boolean {
  return lesson.blocks.length === 0 || lesson.blocks.every(isBlockEmpty);
}

/** Translate ONE structure op into CoursePatches. `mintLesson` makes a real
 *  LessonNode (so its UUID can be recorded for the tempRef→id map). Returns [] for
 *  an op that resolves to nothing (e.g. a rename with no fields) — validation
 *  rejects those upstream, but execution stays defensive. */
function opToPatches(
  doc: CourseDocument,
  op: StructureOp,
  mintLesson: (op: Extract<StructureOp, { op: "create_lesson" }>) => LessonNode
): CoursePatch[] {
  switch (op.op) {
    case "create_lesson": {
      const mod = findModule(doc, op.moduleId);
      if (!mod) return [];
      const lesson = mintLesson(op);
      return [{ action: "ADD_LESSON", moduleId: op.moduleId, lesson, atIndex: op.atIndex ?? undefined }];
    }
    case "delete_lesson":
      return [deleteLessonPatch(op.lessonId)];
    case "rename_lesson": {
      const patches: CoursePatch[] = [];
      if (op.title != null) patches.push(updateTextPatch({ kind: "lesson", id: op.lessonId, field: "title" }, op.title));
      if (op.objective != null) patches.push(updateTextPatch({ kind: "lesson", id: op.lessonId, field: "objective" }, op.objective));
      return patches;
    }
    case "move_lesson":
      return [{ action: "REORDER_LESSON", lessonId: op.lessonId, toModuleId: op.toModuleId ?? undefined, toIndex: op.toIndex }];
    case "rename_module":
      return [updateTextPatch({ kind: "module", id: op.moduleId, field: "title" }, op.title)];
    case "delete_module":
      return [deleteModulePatch(op.moduleId)];
    case "reorder_lesson":
      return [{ action: "REORDER_LESSON", lessonId: op.lessonId, toIndex: op.toIndex }];
    case "reorder_module":
      return [{ action: "REORDER_MODULE", moduleId: op.moduleId, toIndex: op.toIndex }];
  }
}

/** A lesson the plan created this run, with the tempRef that ties it to a
 *  `generateContentFor` brief. */
export interface CreatedLesson {
  tempRef: string;
  lessonId: string;
  moduleId: string;
  title: string;
}

export interface ExecuteResult {
  doc: CourseDocument;
  applied: boolean;
  createdLessons: CreatedLesson[];
  /** Per-op failures (an op whose patch didn't apply) — surfaced, never silent. */
  errors: string[];
}

/**
 * Apply a validated structure plan to `doc` (PURE — returns a new doc). Ops run in
 * order through `applyCoursePatch`; a `create_lesson` mints a real LessonNode so its
 * UUID is recorded under its tempRef (for the chained deck-generation step). Assumes
 * the plan already passed `validateStructurePlan` — it still applies defensively and
 * reports any op that fails to apply.
 */
export function executeStructurePlan(doc: CourseDocument, plan: CourseStructurePlan, nowIso: string): ExecuteResult {
  let working = doc;
  let applied = false;
  const createdLessons: CreatedLesson[] = [];
  const errors: string[] = [];

  for (const op of plan.ops) {
    const patches = opToPatches(working, op, (createOp) => {
      const mod = findModule(working, createOp.moduleId);
      const order = createOp.atIndex ?? mod?.lessons.length ?? 0;
      const lesson = createLesson(createOp.title, order);
      if (createOp.objective) lesson.objective = createOp.objective;
      createdLessons.push({ tempRef: createOp.tempRef, lessonId: lesson.id, moduleId: createOp.moduleId, title: createOp.title });
      return lesson;
    });
    for (const patch of patches) {
      const res = applyCoursePatch(working, patch, nowIso);
      if (res.ok) {
        working = res.doc;
        applied = true;
      } else {
        errors.push(`${op.op}: ${res.error}`);
      }
    }
  }

  return { doc: working, applied, createdLessons, errors };
}

/** True if a plan contains any op that the scoped agent reconcile cannot persist
 *  (delete/move) — such a plan MUST be persisted via the full reconcile. A pure
 *  create/rename/reorder plan is scoped-reconcile-safe. */
export function planNeedsFullReconcile(plan: CourseStructurePlan): boolean {
  return plan.ops.some(
    (o) => o.op === "delete_lesson" || o.op === "delete_module" || o.op === "move_lesson"
  );
}

/** True if a plan deletes a module or lesson — the destructive gate (confirm
 *  before applying). */
export function planIsDestructive(plan: CourseStructurePlan): boolean {
  return plan.ops.some((o) => o.op === "delete_lesson" || o.op === "delete_module");
}

/** Convenience: does the plan create any lesson (drives chained deck generation)? */
export function planCreatesLessons(plan: CourseStructurePlan): boolean {
  return plan.ops.some((o) => o.op === "create_lesson");
}

/** Resolve `findLesson` for a quick existence check (re-export to keep callers in
 *  one import). */
export { findLesson, findModule };
