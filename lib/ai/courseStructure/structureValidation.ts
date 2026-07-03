/**
 * Course Structure — HARD validation (the category guardrail).
 *
 * The model proposes a plan; this code makes the WRONG CATEGORY of action hard or
 * impossible — independent of prompt text:
 *   - "add a lesson" ⇒ the plan MUST create a lesson (never just edit a deck);
 *   - "delete empty lessons" ⇒ the plan MUST delete lessons, and may delete ONLY
 *     empty ones (never fill them, never delete a non-empty one);
 *   - "recreate Module 1" ⇒ the plan MUST NOT create a (duplicate) module and must
 *     stay inside the resolved module;
 *   - every referenced id MUST exist in the deterministic snapshot.
 *
 * Validation is driven by SIGNALS detected from the message (a request can combine
 * actions — e.g. "delete the empty lessons AND add three good ones"), not a single
 * exclusive intent. A failure returns a re-ask string (the plan call gets one
 * corrective pass) or, for an unresolved target, a `TargetResolution` the agent
 * surfaces as a clarification.
 */

import { resolveModule } from "./targetResolution";
import type { CourseOutlineSnapshot, CourseStructurePlan, StructureOp, TargetResolution } from "./types";

/** What structural actions the user's message calls for. A message can set several. */
export interface MessageSignals {
  wantsAddLesson: boolean;
  wantsDeleteEmpty: boolean;
  /** An explicit "delete lesson X" (not necessarily empty). */
  wantsDeleteLesson: boolean;
  wantsRename: boolean;
  wantsMove: boolean;
  wantsRecreateModule: boolean;
  /** Complete / finish / fix / fill out an EXISTING module (in place, no new module). */
  wantsRepairModule: boolean;
  wantsDeleteModule: boolean;
  wantsReorder: boolean;
}

const ADD_LESSON = /\b(add|create|new|insert|append|draft|build|make|write|put)\b[^.?!]*\blessons?\b/i;
const DELETE_EMPTY = /\b(delete|remove|clear|prune|get rid of|clean up)\b[^.?!]*\bempty\b[^.?!]*\blessons?\b/i;
const DELETE_EMPTY_ALT = /\bempty\b[^.?!]*\blessons?\b[^.?!]*\b(delete|remove|gone|out)\b/i;
const DELETE_LESSON = /\b(delete|remove|drop|get rid of)\b[^.?!]*\blessons?\b/i;
const RENAME = /\b(rename|re-?title|call it|change[^.?!]*\b(title|name)|name it)\b[^.?!]*/i;
const RENAME_LESSON = /\b(rename|re-?title|name)\b[^.?!]*\blessons?\b/i;
const MOVE_LESSON = /\bmove\b[^.?!]*\blessons?\b[^.?!]*\b(to|into|under)\b/i;
const RECREATE_MODULE = /\b(recreate|re-?create|rebuild|re-?build|regenerate|redo|remake|replace|refresh)\b[^.?!]*\b(module|chapter|unit)\b/i;
const RECREATE_MODULE_SLIDES = /\b(recreate|rebuild|regenerate|redo|replace|refresh)\b[^.?!]*\b(slides?|decks?|content)\b[^.?!]*\b(module|chapter|unit)\b/i;
const DELETE_MODULE = /\b(delete|remove)\b[^.?!]*\b(module|chapter|unit)\b/i;
const REORDER = /\b(reorder|re-?order|reposition|rearrange|move)\b[^.?!]*\b(up|down|before|after|first|last|to position|to the (top|bottom))\b/i;
/** REPAIR an existing module: a complete/fix/fill verb near module|chapter|unit, OR a
 *  module|chapter|unit described as unfinished/empty/missing-a-title. */
const REPAIR_MODULE = /\b(complete|finish|fix|repair|fill|flesh|improve|rework|redo|polish|finali[sz]e|round out|build out|work on)\b[^.?!]*\b(module|chapter|unit)\b|\b(module|chapter|unit)\b[^.?!]*\b(unfinished|incomplete|empty|blank|placeholder|missing|no title|no lessons|empty slides|half[\s-]?(?:done|finished))\b|\b(make|turn|convert)\b[^.?!]*\b(module|chapter|unit)\b[^.?!]*\b(into|about|an?)\b/i;
const NEW_MODULE = /\b(new|another|additional|separate|extra|second|third|one more)\b[^.?!]{0,20}\b(module|chapter|unit)\b/i;

/** Detect which structural actions the message calls for. Conservative — a phrase
 *  that doesn't clearly request a structural change leaves the flag false. */
export function detectSignals(msg: string): MessageSignals {
  const m = msg;
  const recreate = RECREATE_MODULE.test(m) || RECREATE_MODULE_SLIDES.test(m);
  return {
    wantsAddLesson: ADD_LESSON.test(m),
    wantsDeleteEmpty: DELETE_EMPTY.test(m) || DELETE_EMPTY_ALT.test(m),
    // An explicit lesson delete that ISN'T the "empty lessons" case.
    wantsDeleteLesson: DELETE_LESSON.test(m) && !(DELETE_EMPTY.test(m) || DELETE_EMPTY_ALT.test(m)),
    wantsRename: RENAME_LESSON.test(m) || (RENAME.test(m) && /\blessons?\b/i.test(m)),
    wantsMove: MOVE_LESSON.test(m),
    wantsRecreateModule: recreate,
    // Repair-in-place of an existing module (complete/fix/fill an unfinished module).
    // Not a "new module" request.
    wantsRepairModule: REPAIR_MODULE.test(m) && !NEW_MODULE.test(m),
    // "delete … module" — but NOT when the delete clearly targets LESSONS (e.g.
    // "delete the empty lessons in Module 1", where "Module 1" is a location).
    wantsDeleteModule: DELETE_MODULE.test(m) && !recreate && !DELETE_LESSON.test(m),
    wantsReorder: REORDER.test(m) && !MOVE_LESSON.test(m),
  };
}

/** True if the message asks for ANY structural change (used to route + to flag a
 *  no-op plan). */
export function hasAnyStructureSignal(s: MessageSignals): boolean {
  return (
    s.wantsAddLesson ||
    s.wantsDeleteEmpty ||
    s.wantsDeleteLesson ||
    s.wantsRename ||
    s.wantsMove ||
    s.wantsRecreateModule ||
    s.wantsRepairModule ||
    s.wantsDeleteModule ||
    s.wantsReorder
  );
}

export interface PlanValidationResult {
  ok: boolean;
  /** Human-readable rule violations (joined into the re-ask / error message). */
  errors: string[];
  /** When a named target couldn't be resolved to one id → the agent clarifies
   *  instead of guessing (never acts on an ambiguous destructive target). */
  resolution?: TargetResolution;
}

const has = (ops: StructureOp[], kind: StructureOp["op"]) => ops.some((o) => o.op === kind);

/** Look up a lesson's snapshot record (for the empty check + existence). */
function lessonRecord(snapshot: CourseOutlineSnapshot, lessonId: string) {
  for (const m of snapshot.modules) {
    const l = m.lessons.find((x) => x.lessonId === lessonId);
    if (l) return { lesson: l, moduleId: m.moduleId };
  }
  return null;
}

/**
 * HARD-validate a structure plan against the message signals + the snapshot.
 * Returns ok:false with errors (a re-ask) or a `resolution` to clarify. Pure.
 */
export function validateStructurePlan(
  plan: CourseStructurePlan,
  signals: MessageSignals,
  snapshot: CourseOutlineSnapshot,
  message: string
): PlanValidationResult {
  const errors: string[] = [];
  const ops = plan.ops;

  // 0. Every referenced id must exist in the snapshot (no hallucinated targets).
  const moduleIds = new Set(snapshot.modules.map((m) => m.moduleId));
  for (const op of ops) {
    if (op.op === "create_lesson" && !moduleIds.has(op.moduleId)) errors.push(`create_lesson targets a module that doesn't exist (moduleId=${op.moduleId}).`);
    if (op.op === "move_lesson" && op.toModuleId && !moduleIds.has(op.toModuleId)) errors.push(`move_lesson targets a module that doesn't exist (toModuleId=${op.toModuleId}).`);
    if ((op.op === "delete_module" || op.op === "reorder_module" || op.op === "rename_module") && !moduleIds.has(op.moduleId)) errors.push(`${op.op} targets a module that doesn't exist (moduleId=${op.moduleId}).`);
    if ((op.op === "delete_lesson" || op.op === "rename_lesson" || op.op === "move_lesson" || op.op === "reorder_lesson") && !lessonRecord(snapshot, op.lessonId))
      errors.push(`${op.op} targets a lesson that doesn't exist (lessonId=${op.lessonId}).`);
  }

  // generateContentFor integrity: each entry targets a real existing lesson OR a
  // tempRef minted by a create_lesson op (never a dangling handle).
  const createTempRefs = new Set(ops.filter((o): o is Extract<StructureOp, { op: "create_lesson" }> => o.op === "create_lesson").map((o) => o.tempRef));
  for (const g of plan.generateContentFor) {
    if (g.tempRef && !createTempRefs.has(g.tempRef)) errors.push(`generateContentFor references tempRef "${g.tempRef}" which no create_lesson op produces.`);
    if (g.lessonId && !lessonRecord(snapshot, g.lessonId)) errors.push(`generateContentFor references a lesson that doesn't exist (lessonId=${g.lessonId}).`);
    if (!g.tempRef && !g.lessonId) errors.push("generateContentFor entry must set exactly one of tempRef (new lesson) or lessonId (existing lesson).");
  }

  // 1. ADD a lesson ⇒ the plan MUST create one (never satisfy by editing a deck).
  if (signals.wantsAddLesson && !has(ops, "create_lesson")) {
    errors.push("The request asks to ADD a lesson, but the plan creates no lesson (use a create_lesson op — do NOT just edit an existing deck).");
  }
  // If the message named a specific module to add to, the create op must target it.
  if (signals.wantsAddLesson && has(ops, "create_lesson")) {
    const modRes = resolveModule(message, snapshot);
    if (modRes.status === "clear") {
      const wrong = ops.filter((o): o is Extract<StructureOp, { op: "create_lesson" }> => o.op === "create_lesson" && o.moduleId !== modRes.id);
      if (wrong.length) errors.push(`The request targets ${modRes.label}, but a create_lesson op adds to a different module — add the lesson(s) to ${modRes.label} (moduleId=${modRes.id}).`);
    } else if (modRes.status === "ambiguous" && /\b(module|chapter|unit)\b/i.test(message)) {
      return { ok: false, errors, resolution: modRes };
    }
  }

  // 2. DELETE EMPTY lessons ⇒ MUST delete at least one, and ONLY empty ones.
  if (signals.wantsDeleteEmpty) {
    const deletes = ops.filter((o): o is Extract<StructureOp, { op: "delete_lesson" }> => o.op === "delete_lesson");
    if (deletes.length === 0) errors.push("The request asks to DELETE the empty lessons, but the plan deletes nothing (use delete_lesson ops — do NOT fill the empty lessons instead).");
    for (const d of deletes) {
      const rec = lessonRecord(snapshot, d.lessonId);
      if (rec && !rec.lesson.isEmpty) errors.push(`delete_lesson would remove a NON-empty lesson "${rec.lesson.title}" (lessonId=${d.lessonId}); under a "delete empty lessons" request only empty lessons may be deleted.`);
    }
  }

  // 3. RECREATE a module ⇒ never mint a duplicate module; stay inside the resolved one.
  if (signals.wantsRecreateModule) {
    const modRes = resolveModule(message, snapshot);
    if (modRes.status === "ambiguous") return { ok: false, errors, resolution: modRes };
    if (modRes.status === "unsafe") return { ok: false, errors, resolution: modRes };
    const targetModuleId = modRes.id;
    // create_lesson ops must add to the SAME module being recreated.
    for (const o of ops) {
      if (o.op === "create_lesson" && o.moduleId !== targetModuleId) errors.push(`Recreating ${modRes.label}: a create_lesson op adds to a different module (moduleId=${o.moduleId}) — rebuild inside ${modRes.label} (moduleId=${targetModuleId}), never a new module.`);
      if (o.op === "delete_lesson") {
        const rec = lessonRecord(snapshot, o.lessonId);
        if (rec && rec.moduleId !== targetModuleId) errors.push(`Recreating ${modRes.label}: a delete_lesson op targets a lesson in a different module — only touch ${modRes.label}.`);
      }
    }
    // Must actually do something: rebuild lessons OR regenerate decks in the module.
    const touchesModule =
      has(ops, "create_lesson") ||
      has(ops, "delete_lesson") ||
      plan.generateContentFor.some((g) => (g.lessonId && lessonRecord(snapshot, g.lessonId)?.moduleId === targetModuleId) || g.tempRef);
    if (!touchesModule) errors.push(`Recreating ${modRes.label}: the plan does nothing to it — either rebuild its lessons (delete_lesson + create_lesson) or regenerate its lessons' decks (generateContentFor with replaceExisting).`);
  }

  // 3b. REPAIR / COMPLETE an existing module ⇒ stay IN PLACE inside the resolved
  //     module; never mint a new one (no create_module op exists), and DO something
  //     (rename it, touch its lessons, or regenerate its decks).
  if (signals.wantsRepairModule) {
    const modRes = resolveModule(message, snapshot);
    if (modRes.status === "ambiguous") return { ok: false, errors, resolution: modRes };
    if (modRes.status === "unsafe") return { ok: false, errors, resolution: modRes };
    const targetModuleId = modRes.id;
    for (const o of ops) {
      if (o.op === "create_lesson" && o.moduleId !== targetModuleId) errors.push(`Repairing ${modRes.label}: a create_lesson op adds to a DIFFERENT module (moduleId=${o.moduleId}) — repair inside ${modRes.label} (moduleId=${targetModuleId}), never a new module.`);
      if (o.op === "rename_module" && o.moduleId !== targetModuleId) errors.push(`Repairing ${modRes.label}: a rename_module op targets a different module.`);
      if ((o.op === "delete_lesson" || o.op === "rename_lesson") && lessonRecord(snapshot, o.lessonId) && lessonRecord(snapshot, o.lessonId)!.moduleId !== targetModuleId)
        errors.push(`Repairing ${modRes.label}: an op targets a lesson in a different module — only touch ${modRes.label}.`);
    }
    const touchesModule =
      has(ops, "rename_module") ||
      has(ops, "create_lesson") ||
      has(ops, "delete_lesson") ||
      has(ops, "rename_lesson") ||
      plan.generateContentFor.some((g) => (g.lessonId && lessonRecord(snapshot, g.lessonId)?.moduleId === targetModuleId) || g.tempRef);
    if (!touchesModule) errors.push(`Repairing ${modRes.label}: the plan does nothing to it — set its title (rename_module), fill/replace its empty lessons' decks (generateContentFor with replaceExisting), or add the missing lessons (create_lesson in the same module).`);
  }

  // 4. RENAME a lesson ⇒ MUST rename (not just edit a deck title).
  if (signals.wantsRename && !has(ops, "rename_lesson")) {
    errors.push("The request asks to RENAME a lesson, but the plan has no rename_lesson op (lesson metadata, not a slide title).");
  }

  // 5. DELETE a module ⇒ MUST delete it.
  if (signals.wantsDeleteModule && !has(ops, "delete_module")) {
    errors.push("The request asks to DELETE a module, but the plan has no delete_module op.");
  }

  // 6. MOVE a lesson ⇒ MUST move it.
  if (signals.wantsMove && !has(ops, "move_lesson")) {
    errors.push("The request asks to MOVE a lesson, but the plan has no move_lesson op.");
  }

  // 7. No-op guard: a clearly structural request that produced nothing.
  if (hasAnyStructureSignal(signals) && ops.length === 0 && plan.generateContentFor.length === 0 && !plan.clarification) {
    errors.push("The request asks for a structural change, but the plan contains no operations.");
  }

  return { ok: errors.length === 0, errors };
}
