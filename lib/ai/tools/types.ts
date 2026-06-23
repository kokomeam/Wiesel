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

/** An injected, side-effectful capability for generating + storing an
 *  illustration (the ONLY impure tool path). Present only when image generation
 *  is configured (an image-capable model client + an authenticated Supabase
 *  client); absent ⇒ `add_image` reports generation is unavailable. */
export interface VisualGenContext {
  /** Generate an educational illustration and store it; returns a public URL +
   *  storage path (+ pixel dims), or null when unavailable/failed. */
  generateIllustration(input: {
    prompt: string;
    alt: string;
  }): Promise<{ url: string; storagePath: string; width?: number; height?: number } | null>;
  /** Max illustrations per lesson — the tool enforces it against the live deck. */
  maxPerLesson: number;
}

/** What a tool sees when it runs. `doc` is the CURRENT document (the loop keeps
 *  it in sync after each applied mutation). `lessonId` is the lesson the agent
 *  is docked beside — the default target for writes. */
export interface ToolContext {
  doc: CourseDocument;
  courseId: string;
  lessonId: string;
  /** Image-generation capability (injected by the loop for the GENERATE phase). */
  visuals?: VisualGenContext;
  /** The approved plan's ORDERED slide-spec ids (GENERATE/REPAIR only). Lets batch
   *  authoring deterministically stamp each new slide with its spec id — so coverage
   *  matches even when the model omits or mistypes slideSpecId. Empty/absent on the
   *  edit path (no plan). */
  planSpecIds?: string[];
  /** DIAGNOSTIC ONLY: spec id → its plan keyPoint count. Lets a slide-reject log say
   *  whether the plan spec it was fulfilling actually had real points (author ignored
   *  a real brief) vs. an empty/absent brief. Never affects behavior. */
  planSpecPoints?: Record<string, number>;
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
  /**
   * Skip the loop's strict `params.safeParse` gate and hand `execute` the raw
   * parsed JSON instead. The model-facing JSON schema is STILL generated from
   * `params` (so the model sees the full shape) — but a single malformed entry no
   * longer rejects the whole call. The tool MUST then validate defensively and
   * apply what it can (partial success). Used by `add_structured_slides_batch` so
   * one over-long slot doesn't drop a whole segment.
   */
  lenientArgs?: boolean;
  execute(args: z.infer<P>, ctx: ToolContext): ToolOutcome | Promise<ToolOutcome>;
}

/** Helper to declare a tool with inferred arg typing. */
export function defineTool<P extends z.ZodTypeAny>(tool: Tool<P>): Tool<P> {
  return tool;
}
