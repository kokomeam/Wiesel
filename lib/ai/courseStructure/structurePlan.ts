/**
 * Course Structure — the model-facing plan schema + system prompt.
 *
 * The structure model emits a `CourseStructurePlan` as strict JSON. The Zod schema
 * is the single source of truth (validates the model's output AND generates the
 * strict JSON schema it's constrained by). The prompt frames the agent as a course
 * EDITOR (tree ops), never a slide generator, and forbids the failure modes the
 * Structure agent exists to prevent (duplicate modules, satisfying "add a lesson"
 * by editing a deck, filling "empty lessons" instead of deleting them).
 */

import { z } from "zod";
import type { JsonSchema } from "../modelClient";
import { toStrictJsonSchema } from "../schema";
import type { CourseStructurePlan, StructureOp } from "./types";

const StructureOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create_lesson"),
    moduleId: z.string().describe("EXACT moduleId from the outline to add the lesson to."),
    title: z.string().describe("A specific, meaningful lesson title — NEVER 'New lesson'."),
    objective: z.string().nullable().describe("One-sentence learning objective, or null."),
    atIndex: z.number().int().nullable().describe("0-based insert position in the module, or null to append."),
    tempRef: z.string().describe("A unique handle (e.g. 'L1') so generateContentFor can target this new lesson."),
  }),
  z.object({ op: z.literal("delete_lesson"), lessonId: z.string().describe("EXACT lessonId from the outline.") }),
  z.object({
    op: z.literal("rename_lesson"),
    lessonId: z.string(),
    title: z.string().nullable().describe("New title, or null to leave unchanged."),
    objective: z.string().nullable().describe("New objective, or null to leave unchanged."),
  }),
  z.object({
    op: z.literal("move_lesson"),
    lessonId: z.string(),
    toModuleId: z.string().nullable().describe("Destination moduleId, or null to keep the same module."),
    toIndex: z.number().int().describe("0-based destination position."),
  }),
  z.object({
    op: z.literal("rename_module"),
    moduleId: z.string().describe("EXACT moduleId from the outline."),
    title: z.string().describe("A specific, meaningful module title (e.g. 'Introduction to Economics') — use this to give an untitled module a title."),
  }),
  z.object({ op: z.literal("delete_module"), moduleId: z.string() }),
  z.object({ op: z.literal("reorder_lesson"), lessonId: z.string(), toIndex: z.number().int() }),
  z.object({ op: z.literal("reorder_module"), moduleId: z.string(), toIndex: z.number().int() }),
]);

const GenerateContentBriefSchema = z.object({
  tempRef: z.string().nullable().describe("Set for a lesson created this run (matches a create_lesson tempRef)."),
  lessonId: z.string().nullable().describe("Set for an EXISTING lesson whose deck should be (re)built."),
  title: z.string(),
  objective: z.string(),
  contentRequest: z.string().describe("What the deck should cover, in the user's words (the lesson plan's request)."),
  replaceExisting: z.boolean().describe("Existing lesson only: delete its current slide deck(s) before regenerating."),
});

export const CourseStructurePlanSchema = z.object({
  intent: z.enum([
    "add_lesson",
    "delete_empty_lessons",
    "recreate_module",
    "rename_lesson",
    "move_lesson",
    "delete_lesson",
    "delete_module",
    "reorder",
  ]),
  summary: z.string().describe("One-line, user-facing description of what this plan does."),
  ops: z.array(StructureOpSchema).describe("Ordered structural operations on the course TREE."),
  generateContentFor: z
    .array(GenerateContentBriefSchema)
    .describe("Lessons (new via tempRef, or existing via lessonId) whose decks to generate after the structural ops."),
  clarification: z
    .string()
    .nullable()
    .describe("If the target is genuinely ambiguous, ask a short question here and leave ops empty; else null."),
}) satisfies z.ZodType<CourseStructurePlan>;

// Compile-time guard that the union mirrors the StructureOp type exactly.
type _OpCheck = z.infer<typeof StructureOpSchema> extends StructureOp ? (StructureOp extends z.infer<typeof StructureOpSchema> ? true : never) : never;
const _opCheck: _OpCheck = true;
void _opCheck;

export function structurePlanResponseFormat(): { name: string; schema: JsonSchema } {
  return { name: "course_structure_plan", schema: toStrictJsonSchema(CourseStructurePlanSchema) };
}

/** Parse + validate the model's plan JSON. `plan` undefined on any failure (the
 *  plan call's ONE re-ask uses `errors`). Mirrors the `{ outline?, errors }` shape
 *  `runStructuredPlan`'s validate hook expects (callers map plan→outline). */
export function parseStructurePlan(raw: string): { plan?: CourseStructurePlan; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw || "{}");
  } catch {
    return { errors: ["Output was not valid JSON."] };
  }
  const parsed = CourseStructurePlanSchema.safeParse(json);
  if (!parsed.success) {
    return { errors: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  return { plan: parsed.data, errors: [] };
}

export const STRUCTURE_PLAN_SYSTEM_PROMPT = `You are the Course Structure planner for an AI course studio. You are NOT a slide generator — you EDIT THE COURSE OUTLINE (modules and lessons). You decide WHICH lessons and modules to create, rename, move, reorder, or delete; the slide content for any new or rebuilt lesson is generated by a separate step AFTER you.

ALWAYS distinguish COURSE STRUCTURE from SLIDE CONTENT:
- Course structure = modules, lessons, lesson titles, lesson objectives, lesson order, which lessons live in which module.
- Slide content = slides inside a deck, the text/examples/quizzes on them. You do NOT author those — you only mark which lessons should have their deck (re)built via generateContentFor.

You are given the exact COURSE OUTLINE with stable ids. Rules — follow them exactly:
1. Use the EXACT ids from the outline. NEVER invent a moduleId or lessonId. The current lesson/module (if any) is marked "◀ current".
2. "Add a lesson [to Module X]" → emit a create_lesson op in that module with a SPECIFIC, meaningful title (never "New lesson"), and a generateContentFor entry (tempRef) so its deck gets built. Do NOT satisfy this by editing an existing deck.
3. "Delete the empty lessons" → emit delete_lesson ops for the lessons marked EMPTY. NEVER fill an empty lesson with content unless the user explicitly says to keep and fill it. You MAY also create new, well-titled lessons in the same request.
4. "Recreate / rebuild / redo Module X" → resolve the EXISTING module and rebuild IN PLACE. NEVER create a new module (there is no create-module operation, and a duplicate like "Module 10: Module 1…" is wrong). To rebuild a module's slides, add a generateContentFor entry (lessonId, replaceExisting=true) for each of its lessons; to rebuild its lessons, delete_lesson the old ones and create_lesson new ones in the SAME moduleId.
5. "Rename this lesson" → emit a rename_lesson op (changes the lesson's title/objective metadata), NOT a slide title change.
6. "Move lesson … to Module Y" → emit a move_lesson op.
7. "Complete / finish / fix / fill out an EXISTING module" (e.g. "module one is unfinished, has empty slides, no title — complete it") → REPAIR IT IN PLACE. NEVER create a new module. Concretely: if it has no real title, emit rename_module with a specific title; for each lesson that is EMPTY, add a generateContentFor entry (lessonId, replaceExisting=true) so its deck is (re)built from the user's topics; rename a vaguely/auto-titled lesson with rename_lesson; and create_lesson (in the SAME moduleId) only if the module needs more lessons to cover the topics. The whole repair stays inside that one existing moduleId.
9. If the target is genuinely ambiguous (e.g. two lessons share a title, or "fix the module" with several modules and no clear one), set "clarification" to a short question and leave "ops" empty — do NOT guess.
10. Destructive ops (delete_lesson, delete_module) are shown to the creator for confirmation before they apply — still emit them when the user clearly asked.

Set "intent" to your best single label. Keep "summary" to one natural sentence describing what you'll do (e.g. "I'll add a lesson on hash table resizing to Module 3 and build its slide deck."). Return ONLY the json_schema object.`;
