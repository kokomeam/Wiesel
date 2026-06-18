/**
 * Structural tools — create/delete/reorder modules, lessons, and blocks. Each
 * returns CoursePatches built from the SAME command/factory helpers the studio
 * UI uses, so there is no separate write path.
 */

import { z } from "zod";
import {
  addBlockPatch,
  addModulePatch,
  deleteBlockPatch,
  deleteLessonPatch,
  deleteModulePatch,
  reorderBlockPatch,
} from "@/lib/course/commands";
import { createLesson } from "@/lib/course/factories";
import { moduleDisplayName, moduleNumber } from "@/lib/course/moduleLabel";
import { findBlock, findLesson, findModule } from "@/lib/course/queries";
import type { BlockType } from "@/lib/course/types";
import { defineTool, ToolError, type Tool } from "./types";

const BLOCK_TYPES = [
  "slide_deck",
  "lecture_text",
  "quiz",
  "homework",
  "exercise",
  "example",
  "resource",
] as const satisfies readonly BlockType[];

const createModule = defineTool({
  name: "create_module",
  description: "Add a new module to the course.",
  params: z.object({ title: z.string() }),
  execute(args, ctx) {
    const patch = addModulePatch(ctx.doc, args.title);
    const moduleId = patch.action === "ADD_MODULE" ? patch.module.id : undefined;
    return { summary: `Created module "${args.title}"`, patches: [patch], data: { moduleId } };
  },
});

const createLessonTool = defineTool({
  name: "create_lesson",
  description:
    "Add a new lesson to a module. Defaults to the module of the current lesson. Returns the new lessonId so you can write blocks into it.",
  params: z.object({
    moduleId: z.string().nullable(),
    title: z.string(),
    objective: z.string().nullable(),
  }),
  execute(args, ctx) {
    const moduleId = args.moduleId ?? findLesson(ctx.doc, ctx.lessonId)?.module.id;
    if (!moduleId) throw new ToolError("No module to add the lesson to");
    const mod = ctx.doc.modules.find((m) => m.id === moduleId);
    if (!mod) throw new ToolError(`Module ${moduleId} not found`);
    const lesson = createLesson(args.title, mod.lessons.length);
    if (args.objective) lesson.objective = args.objective;
    return {
      summary: `Created lesson "${args.title}"`,
      patches: [{ action: "ADD_LESSON", moduleId, lesson }],
      data: { lessonId: lesson.id },
    };
  },
});

const createBlockTool = defineTool({
  name: "create_block",
  description:
    "Add a new EMPTY block of a given type to a lesson (defaults to the current lesson), returning its blockId. For slide_deck / lecture_text / quiz / homework prefer the write_* tools, which create AND fill in one step.",
  params: z.object({
    lessonId: z.string().nullable(),
    type: z.enum(BLOCK_TYPES),
    title: z.string().nullable(),
  }),
  execute(args, ctx) {
    const lessonId = args.lessonId ?? ctx.lessonId;
    if (!findLesson(ctx.doc, lessonId)) throw new ToolError(`Lesson ${lessonId} not found`);
    const patch = addBlockPatch(lessonId, args.type);
    if (patch.action === "ADD_BLOCK" && args.title) patch.block.title = args.title;
    const blockId = patch.action === "ADD_BLOCK" ? patch.block.id : undefined;
    return { summary: `Added ${args.type.replace("_", " ")} block`, patches: [patch], data: { blockId } };
  },
});

const deleteBlockTool = defineTool({
  name: "delete_block",
  description: "Delete a block by id.",
  params: z.object({ blockId: z.string() }),
  execute(args, ctx) {
    const hit = findBlock(ctx.doc, args.blockId);
    if (!hit) throw new ToolError(`Block ${args.blockId} not found`);
    return {
      summary: `Deleted ${hit.block.title ?? hit.block.type}`,
      patches: [deleteBlockPatch(hit.lesson.id, args.blockId)],
    };
  },
});

const deleteModuleTool = defineTool({
  name: "delete_module",
  description:
    "Delete a whole module AND everything inside it (all its lessons and their content). DESTRUCTIVE and not undoable — the studio shows the creator a confirmation dialog and PAUSES you until they decide; the tool result reports whether they confirmed or declined. Call this ONLY when the creator clearly asked to remove a module — never to 'replace' content you could edit in place.",
  params: z.object({ moduleId: z.string() }),
  execute(args, ctx) {
    const mod = findModule(ctx.doc, args.moduleId);
    if (!mod) throw new ToolError(`Module ${args.moduleId} not found`);
    const label = moduleDisplayName(moduleNumber(ctx.doc, mod.id), mod.title);
    return {
      summary: `Confirm needed to delete ${label}`,
      patches: [deleteModulePatch(mod.id)],
      confirm: { kind: "module", label },
    };
  },
});

const deleteLessonTool = defineTool({
  name: "delete_lesson",
  description:
    "Delete a whole lesson and all of its blocks. DESTRUCTIVE and not undoable — the studio shows the creator a confirmation dialog and PAUSES you until they decide; the tool result reports their decision. Call this ONLY when the creator clearly asked to remove a lesson.",
  params: z.object({ lessonId: z.string() }),
  execute(args, ctx) {
    const hit = findLesson(ctx.doc, args.lessonId);
    if (!hit) throw new ToolError(`Lesson ${args.lessonId} not found`);
    return {
      summary: `Confirm needed to delete lesson "${hit.lesson.title}"`,
      patches: [deleteLessonPatch(args.lessonId)],
      confirm: { kind: "lesson", label: hit.lesson.title },
    };
  },
});

const reorderBlocks = defineTool({
  name: "reorder_blocks",
  description:
    "Reorder a lesson's blocks to match `orderedBlockIds` (every block id in the lesson, in the new order).",
  params: z.object({
    lessonId: z.string().nullable(),
    orderedBlockIds: z.array(z.string()),
  }),
  execute(args, ctx) {
    const lessonId = args.lessonId ?? ctx.lessonId;
    const hit = findLesson(ctx.doc, lessonId);
    if (!hit) throw new ToolError(`Lesson ${lessonId} not found`);
    // Front-to-back single moves compose to the target permutation (one undo
    // when applied together).
    const patches = args.orderedBlockIds
      .filter((id) => hit.lesson.blocks.some((b) => b.id === id))
      .map((id, i) => reorderBlockPatch(lessonId, id, i));
    return { summary: `Reordered ${patches.length} block(s)`, patches };
  },
});

export const structuralTools: Tool[] = [
  createModule,
  createLessonTool,
  createBlockTool,
  deleteBlockTool,
  deleteModuleTool,
  deleteLessonTool,
  reorderBlocks,
];
