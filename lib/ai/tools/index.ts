/**
 * Tool registry: assembles every tool, exposes provider-neutral tool
 * definitions for the model (strict JSON schemas from each tool's Zod params),
 * and runs a tool by name with full argument validation.
 */

import { toStrictJsonSchema } from "../schema";
import { debugAgent } from "../debugLog";
import type { ToolDefinition } from "../modelClient";
import { analyticsTools } from "./analytics";
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
  ...analyticsTools,
];

/** Tools the GENERATE/CRITIQUE phases may use — AUTHORING only: read context +
 *  write/edit slides, decks, quizzes, lectures. Deliberately EXCLUDES the
 *  structural + destructive tools (create/delete module/lesson/block, reorder)
 *  so a generation phase can't go off-script and churn the course tree — the
 *  module/lesson pipeline owns structure; generation only fills it in. */
export const AUTHORING_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...readTools, ...writerTools, ...slideTools, ...structuredSlideTools].map((t) => t.name)
);

/** Course-level READ tools the GENERATE/REPAIR phases must NOT call — the course
 *  context, the lesson, the PLAN, and the authored-so-far set are ALREADY carried
 *  verbatim in the context message + the generation-state summary every turn, so
 *  re-running these just burns turns (the death-spiral REPAIR was caught doing).
 *  The slide-inspection reads (get_deck/get_slide/get_block) stay available. */
const GENERATE_EXCLUDED_READS: ReadonlySet<string> = new Set([
  "get_course_context",
  "list_modules",
  "list_lessons",
  "get_lesson",
  "list_course_outline",
]);

/** Writer tools the GENERATE/REPAIR phases must NOT have:
 *  - `write_slide_deck` — FRESH-deck only; structured slides go in via the granular
 *    tools, so generation honors the plan's structured layout.
 *  - `write_quiz` / `write_homework` — Decision B: quiz/homework are authored OFF the
 *    slide loop by a CONCURRENT deterministic aux call (phases.ts `authorAuxBlocks`)
 *    and recovered by a deterministic RETRY — never by a model-repair pass. Leaving
 *    these here would re-arm the repair loop with tools the parallel path owns, so a
 *    durable aux gap could hand the model a tool it shouldn't use. `write_lecture_text`
 *    STAYS (still authored inline). */
const GENERATE_EXCLUDED_WRITERS: ReadonlySet<string> = new Set([
  "write_slide_deck",
  "write_quiz",
  "write_homework",
]);

/** The even-narrower set for the PLAN-driven GENERATE/REPAIR phases: STRUCTURED
 *  slide authoring + lecture text, plus only the slide-inspection reads. EXCLUDES
 *  `write_slide_deck`, the FLAT slide ops, the aux writers (see
 *  `GENERATE_EXCLUDED_WRITERS`), AND the course-level reads (context/modules/lessons
 *  already in context+state). (The edit path keeps the full `AUTHORING_TOOL_NAMES`,
 *  which still includes write_quiz/write_homework — "add a quiz" in chat works.) */
export const GENERATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...readTools.filter((t) => !GENERATE_EXCLUDED_READS.has(t.name)).map((t) => t.name),
  // create_block is the ONLY structural tool allowed — it makes the empty
  // slide_deck the structured slides go into (additive + safe; the off-script
  // risk was create_lesson/delete_*, which stay excluded).
  ...structuralTools.filter((t) => t.name === "create_block").map((t) => t.name),
  ...structuredSlideTools.map((t) => t.name),
  ...writerTools.filter((t) => !GENERATE_EXCLUDED_WRITERS.has(t.name)).map((t) => t.name),
]);

/** The ANALYST subagent's set (maintenance runs): the six analytics read tools
 *  PLUS the content reads — so its evidence can quote the actual question
 *  wording, not just the numbers. Strictly read-only; no confirm-pausing tools. */
export const ANALYST_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...analyticsTools.map((t) => t.name),
  ...readTools.map((t) => t.name),
]);

/** The REMEDIATION subagent's set: everything the human-facing edit path has
 *  (AUTHORING — already excludes ALL structural/destructive/confirm-pausing
 *  tools) plus the two analytics reads useful for verifying its own fix. */
export const REMEDIATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...AUTHORING_TOOL_NAMES,
  "get_question_item_stats",
  "get_slide_dwell_outliers",
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
  } catch (err) {
    // DIAGNOSTIC: a parse failure here is the TRUNCATION signature — the model hit
    // its output cap mid-JSON, so the tool-call arguments are cut off. Log the size +
    // head/tail so we can see it's truncated (unclosed) rather than malformed.
    debugAgent("tool_args_parse_fail", {
      tool: name,
      rawLen: rawArgs.length,
      head: rawArgs.slice(0, 300),
      tail: rawArgs.slice(-300),
      parseError: err instanceof Error ? err.message : String(err),
    });
    throw new ToolError(`Invalid JSON arguments for ${name}`);
  }

  // Lenient tools validate per-item inside execute (partial success), so a single
  // malformed entry can't reject the whole call. The model schema is still strict.
  if (tool.lenientArgs) {
    return tool.execute(json as never, ctx);
  }

  const parsed = tool.params.safeParse(json);
  if (!parsed.success) {
    throw new ToolError(`Invalid arguments for ${name}: ${parsed.error.message}`);
  }
  return tool.execute(parsed.data, ctx);
}

export { ToolError } from "./types";
export type { Tool, ToolContext, ToolOutcome, VisualGenContext } from "./types";
