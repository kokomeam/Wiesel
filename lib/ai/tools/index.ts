/**
 * Tool registry: assembles every tool, exposes provider-neutral tool
 * definitions for the model (strict JSON schemas from each tool's Zod params),
 * and runs a tool by name with full argument validation.
 */

import { toStrictJsonSchema } from "../schema";
import type { ToolDefinition } from "../modelClient";
import { readTools } from "./read";
import { slideTools } from "./slides";
import { structuralTools } from "./structural";
import { structuredSlideTools } from "./structuredSlides";
import { writerTools } from "./writers";
import { ToolError, type Tool, type ToolContext, type ToolOutcome } from "./types";

export const ALL_TOOLS: Tool[] = [
  ...readTools,
  ...structuralTools,
  ...writerTools,
  ...slideTools,
  ...structuredSlideTools,
];

/** Tools the GENERATE/CRITIQUE phases may use — AUTHORING only: read context +
 *  write/edit slides, decks, quizzes, lectures. Deliberately EXCLUDES the
 *  structural + destructive tools (create/delete module/lesson/block, reorder)
 *  so a generation phase can't go off-script and churn the course tree — the
 *  module/lesson pipeline owns structure; generation only fills it in. */
export const AUTHORING_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...readTools, ...writerTools, ...slideTools, ...structuredSlideTools].map((t) => t.name)
);

/** The even-narrower set for the PLAN-driven GENERATE/CRITIQUE phases: read
 *  context + STRUCTURED slide authoring + auxiliary blocks (quiz/homework/
 *  lecture). EXCLUDES `write_slide_deck` and the FLAT slide ops so generation
 *  must honor the plan's structured layout and can't fall back to a flat
 *  tip/text deck. (The edit path keeps the full `AUTHORING_TOOL_NAMES`.) */
export const GENERATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...readTools.map((t) => t.name),
  // create_block is the ONLY structural tool allowed — it makes the empty
  // slide_deck the structured slides go into (additive + safe; the off-script
  // risk was create_lesson/delete_*, which stay excluded).
  ...structuralTools.filter((t) => t.name === "create_block").map((t) => t.name),
  ...structuredSlideTools.map((t) => t.name),
  ...writerTools.filter((t) => t.name !== "write_slide_deck").map((t) => t.name),
]);

const TOOL_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** Strict, model-facing definitions for every tool (cached — schemas are
 *  static). */
let cachedDefs: ToolDefinition[] | null = null;
export function getToolDefinitions(): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toStrictJsonSchema(t.params),
    }));
  }
  return cachedDefs;
}

/**
 * Validate the model's raw JSON arguments against the tool's Zod schema (the
 * real trust boundary), then run it. Throws ToolError on unknown tool / invalid
 * args so the loop can report the problem back to the model and let it retry.
 */
export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);

  let json: unknown;
  try {
    json = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    throw new ToolError(`Invalid JSON arguments for ${name}`);
  }

  const parsed = tool.params.safeParse(json);
  if (!parsed.success) {
    throw new ToolError(`Invalid arguments for ${name}: ${parsed.error.message}`);
  }
  return tool.execute(parsed.data, ctx);
}

export { ToolError } from "./types";
export type { Tool, ToolContext, ToolOutcome } from "./types";
