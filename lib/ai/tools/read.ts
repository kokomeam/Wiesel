/**
 * Read / navigate tools. Pure reads over `ctx.doc` (the whole course is already
 * in memory), so multi-lesson jobs explore structure and align to what's
 * already taught without any extra DB round-trips.
 */

import { z } from "zod";
import { findBlock, findLesson } from "@/lib/course/queries";
import type { LessonBlock, LessonNode } from "@/lib/course/types";
import { defineTool, ToolError, type Tool } from "./types";

/** One-line, content-aware summary of a block (for grounding without dumping
 *  the whole payload). */
export function summarizeBlock(block: LessonBlock): string {
  switch (block.type) {
    case "slide_deck": {
      const headings = block.slides
        .map((s) => s.elements.find((e) => e.type === "heading"))
        .map((e) => (e && e.type === "heading" ? e.text : ""))
        .filter(Boolean);
      return `${block.slides.length} slide(s): ${headings.join(" · ") || "untitled"}`;
    }
    case "lecture_text": {
      const ideas = block.paragraphs.filter((p) => p.kind === "key_idea").map((p) => p.text);
      return ideas.length
        ? `lecture — key ideas: ${ideas.join("; ")}`
        : `lecture — ${block.paragraphs.length} paragraph(s)`;
    }
    case "quiz":
      return `knowledge check — ${block.questions.length} question(s)`;
    case "homework":
      return `practice — ${block.exercises.length} exercise(s)`;
    case "exercise":
      return `exercise — ${block.prompt.slice(0, 120)}`;
    case "example":
      return `worked example — ${block.takeaway.slice(0, 120)}`;
    case "resource":
      return `${block.links.length} resource link(s)`;
  }
}

function lessonView(lesson: LessonNode) {
  return {
    lessonId: lesson.id,
    title: lesson.title,
    objective: lesson.objective ?? null,
    blocks: lesson.blocks.map((b) => ({
      blockId: b.id,
      type: b.type,
      title: b.title ?? null,
      summary: summarizeBlock(b),
    })),
  };
}

const getCourseContext = defineTool({
  name: "get_course_context",
  description:
    "Read the course's grounding context: title, description, audience, level, the teaching plan (outcomes, prerequisites, teaching style/tone), and a summary of the current lesson's blocks. Call this FIRST to align output with what the course teaches and how.",
  readOnly: true,
  params: z.object({}),
  execute(_args, ctx) {
    const hit = findLesson(ctx.doc, ctx.lessonId);
    return {
      summary: "Read course context",
      data: {
        course: {
          title: ctx.doc.title,
          description: ctx.doc.description ?? null,
          audience: ctx.doc.audience ?? null,
          level: ctx.doc.level ?? null,
          plan: ctx.doc.plan,
        },
        currentLesson: hit ? lessonView(hit.lesson) : null,
      },
    };
  },
});

const listModules = defineTool({
  name: "list_modules",
  description: "List the course's modules with their lesson counts.",
  readOnly: true,
  params: z.object({}),
  execute(_args, ctx) {
    return {
      summary: `Listed ${ctx.doc.modules.length} module(s)`,
      data: ctx.doc.modules.map((m) => ({
        moduleId: m.id,
        title: m.title,
        lessonCount: m.lessons.length,
      })),
    };
  },
});

const listLessons = defineTool({
  name: "list_lessons",
  description:
    "List lessons, optionally within a single module. Use for multi-lesson jobs to find sibling lessons to flesh out.",
  readOnly: true,
  params: z.object({ moduleId: z.string().nullable() }),
  execute(args, ctx) {
    const modules = args.moduleId
      ? ctx.doc.modules.filter((m) => m.id === args.moduleId)
      : ctx.doc.modules;
    const lessons = modules.flatMap((m) =>
      m.lessons.map((l) => ({
        lessonId: l.id,
        moduleId: m.id,
        title: l.title,
        objective: l.objective ?? null,
        blockCount: l.blocks.length,
      }))
    );
    return { summary: `Listed ${lessons.length} lesson(s)`, data: lessons };
  },
});

const getLesson = defineTool({
  name: "get_lesson",
  description:
    "Read one lesson and a summary of every block it contains. Defaults to the current lesson. Use to see what already exists before writing, so you don't duplicate content.",
  readOnly: true,
  params: z.object({ lessonId: z.string().nullable() }),
  execute(args, ctx) {
    const lessonId = args.lessonId ?? ctx.lessonId;
    const hit = findLesson(ctx.doc, lessonId);
    if (!hit) throw new ToolError(`Lesson ${lessonId} not found`);
    return { summary: `Read lesson "${hit.lesson.title}"`, data: lessonView(hit.lesson) };
  },
});

const getBlock = defineTool({
  name: "get_block",
  description:
    "Read one block's FULL content as JSON (for a targeted edit). Use sparingly — prefer get_lesson summaries unless you need the exact current content.",
  readOnly: true,
  params: z.object({ blockId: z.string() }),
  execute(args, ctx) {
    const hit = findBlock(ctx.doc, args.blockId);
    if (!hit) throw new ToolError(`Block ${args.blockId} not found`);
    return { summary: `Read block "${hit.block.title ?? hit.block.type}"`, data: hit.block };
  },
});

export const readTools: Tool[] = [
  getCourseContext,
  listModules,
  listLessons,
  getLesson,
  getBlock,
];
