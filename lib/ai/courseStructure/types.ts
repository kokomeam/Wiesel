/**
 * Course Structure agent — shared types.
 *
 * The Structure agent edits the course TREE (modules → lessons), never slide
 * content. The model proposes a `CourseStructurePlan` (JSON); code validates it
 * HARD against the detected intent + a deterministic `CourseOutlineSnapshot`,
 * then executes it through the validated CoursePatch pipeline. There is NO
 * `create_module` op by design, so "recreate Module 1" can never produce a
 * duplicate module — the wrong category of action is impossible, not merely
 * discouraged by the prompt.
 */

/** The granular structural intent of a user request — detected heuristically from
 *  the message AND declared by the model in its plan; validation checks they agree
 *  and that the plan's ops match (e.g. add_lesson ⇒ a create_lesson op exists). */
export type CourseAgentIntent =
  | "add_lesson"
  | "delete_empty_lessons"
  | "recreate_module"
  | "rename_lesson"
  | "move_lesson"
  | "delete_lesson"
  | "delete_module"
  | "reorder";

/** A flat, model-friendly snapshot of the whole course tree — the grounding the
 *  structure model resolves targets against. Carries NO slide/block payloads (ids
 *  + titles + an emptiness flag only), so it stays small and stable for caching. */
export interface CourseOutlineSnapshot {
  courseId: string;
  courseTitle: string;
  /** The lesson/module the agent is docked beside — resolves "this lesson". */
  selected: { moduleId?: string; lessonId?: string };
  modules: SnapshotModule[];
}

export interface SnapshotModule {
  moduleId: string;
  /** 1-based display number (moduleNumber). */
  number: number;
  /** "Module 3: Hashing" (moduleDisplayName). */
  displayName: string;
  title: string;
  order: number;
  lessonCount: number;
  lessons: SnapshotLesson[];
}

export interface SnapshotLesson {
  lessonId: string;
  index: number;
  title: string;
  objective: string | null;
  blockCount: number;
  /** Deterministic emptiness (no blocks, or only contentless/placeholder blocks). */
  isEmpty: boolean;
  hasDeck: boolean;
  /** Compact one-line description of what the lesson contains (for grounding). */
  contentSummary: string;
}

export type TargetKind = "module" | "lesson";

/** Resolution of a phrase ("Module 3", "this lesson", "the hashing lesson") to a
 *  stable id. NEVER exposes numeric confidence — only these three states. */
export type TargetResolution =
  | { status: "clear"; kind: TargetKind; id: string; label: string }
  | { status: "ambiguous"; kind: TargetKind; candidates: { id: string; label: string }[]; question: string }
  | { status: "unsafe"; reason: string };

/**
 * One structural operation. Each maps 1:1 to a CoursePatch (see
 * `structureTools.ts`). `create_lesson` carries a `tempRef` so later ops and the
 * content-generation step can reference the not-yet-created lesson by a stable
 * handle (the real UUID is minted at execution time).
 *
 * There is deliberately NO `create_module` — the Structure agent can rebuild a
 * module's lessons IN PLACE but can never mint a new (duplicate) module.
 */
export type StructureOp =
  | { op: "create_lesson"; moduleId: string; title: string; objective: string | null; atIndex: number | null; tempRef: string }
  | { op: "delete_lesson"; lessonId: string }
  | { op: "rename_lesson"; lessonId: string; title: string | null; objective: string | null }
  | { op: "move_lesson"; lessonId: string; toModuleId: string | null; toIndex: number }
  | { op: "rename_module"; moduleId: string; title: string }
  | { op: "delete_module"; moduleId: string }
  | { op: "reorder_lesson"; lessonId: string; toIndex: number }
  | { op: "reorder_module"; moduleId: string; toIndex: number };

export type StructureOpKind = StructureOp["op"];

/** A content brief that drives the chained PLAN→GENERATE deck pipeline for a lesson.
 *  It targets EITHER a newly-created lesson (`tempRef`, from a `create_lesson` op) OR
 *  an EXISTING lesson (`lessonId`) whose deck should be (re)built — so "recreate the
 *  slides for Module 1" regenerates the decks inside its current lessons (no new
 *  module, no new lessons). Exactly one of `tempRef`/`lessonId` is set. */
export interface GenerateContentBrief {
  /** Set for a lesson created THIS run (matches a `create_lesson` op's tempRef). */
  tempRef: string | null;
  /** Set for an EXISTING lesson whose deck should be (re)built. */
  lessonId: string | null;
  title: string;
  objective: string;
  /** What the lesson's deck should cover, in the user's words (fed to the lesson
   *  plan as the request). */
  contentRequest: string;
  /** Existing lesson only: delete its current slide deck(s) before regenerating
   *  (the "replace the outdated slides" case). Ignored for a brand-new lesson. */
  replaceExisting: boolean;
}

/** The model's structured plan — validated HARD before any execution. */
export interface CourseStructurePlan {
  /** The model's understanding of the request (checked against the detected intent). */
  intent: CourseAgentIntent;
  /** One-line, user-facing description of what this plan does. */
  summary: string;
  /** Ordered structural ops to execute deterministically. */
  ops: StructureOp[];
  /** New lessons (by tempRef) whose decks should be generated after creation. */
  generateContentFor: GenerateContentBrief[];
  /** When the target is genuinely ambiguous, the model may ask instead of guessing. */
  clarification: string | null;
}
