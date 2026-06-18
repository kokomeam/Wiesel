/**
 * Tool framework types.
 *
 * A Tool is a PURE-ish function over the in-memory CourseDocument: it reads
 * `ctx.doc` and returns either data (read tools) or CoursePatches (write tools).
 * Tools NEVER touch the database or the model directly — the agent loop owns
 * applying patches, persisting, change-tracking, and streaming. This keeps each
 * tool trivially unit-testable and guarantees every mutation flows through the
 * one validated CoursePatch pipeline (the agent has no private write path).
 */

import type { z } from "zod";
import type { CoursePatch } from "@/lib/course/patches";
import type { CourseDocument } from "@/lib/course/types";

/** What a tool sees when it runs. `doc` is the CURRENT document (the loop keeps
 *  it in sync after each applied mutation). `lessonId` is the lesson the agent
 *  is docked beside — the default target for writes. */
export interface ToolContext {
  doc: CourseDocument;
  courseId: string;
  lessonId: string;
}

/** A tool's result. Read tools set `data`; write tools set `patches` (applied +
 *  persisted + change-tracked by the loop) and a one-line human summary. */
export interface ToolOutcome {
  summary: string;
  patches?: CoursePatch[];
  data?: unknown;
  /**
   * When set, this is a DESTRUCTIVE action the user must confirm first. The
   * loop does NOT apply `patches`; instead it pauses the whole agent run, asks
   * the user to confirm (popup), and only applies + continues once they decide.
   * `label` names the target in the dialog (e.g. "Module 2: Graphs").
   */
  confirm?: { kind: "module" | "lesson"; label: string };
}

/** Thrown by a tool for clearly-invalid input (e.g. a referenced block that
 *  doesn't exist). The loop reports it back to the model so it can recover. */
export class ToolError extends Error {}

export interface Tool<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Zod schema = single source of truth: validates the model's arguments AND
   *  generates the strict JSON schema the model is constrained by. */
  params: P;
  readOnly?: boolean;
  execute(args: z.infer<P>, ctx: ToolContext): ToolOutcome | Promise<ToolOutcome>;
}

/** Helper to declare a tool with inferred arg typing. */
export function defineTool<P extends z.ZodTypeAny>(tool: Tool<P>): Tool<P> {
  return tool;
}
