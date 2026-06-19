/**
 * Intent router for the content agent (auto-detect, no UI button).
 *
 * Each chat turn is classified into one of three modes:
 *   - generate_module : build a whole NEW module (several lessons) → module plan
 *                       → approve → GENERATE every lesson (layered).
 *   - generate_lesson : author/flesh out a full deck for ONE lesson → lesson plan
 *                       → approve → GENERATE → CRITIQUE.
 *   - edit            : a targeted change / question / single small add → the
 *                       fast single-turn loop (still layered, see agentLoop).
 *
 * Two high-precision regex short-circuits skip the model call on unmistakable
 * builds; everything else (incl. small adds like "add a knowledge check") goes
 * to a low-effort structured classifier that defaults to "edit".
 */

import { z } from "zod";
import type { ModelClient } from "./modelClient";
import { AI_CLASSIFIER_EFFORT, AI_CLASSIFIER_MODEL } from "./modelConfig";
import { toStrictJsonSchema } from "./schema";

export type AgentMode = "generate_module" | "generate_lesson" | "edit";

const IntentSchema = z.object({ mode: z.enum(["generate_module", "generate_lesson", "edit"]) });

/** A build verb aimed at a MODULE/COURSE → build a whole module. A module build
 *  almost always NAMES its lessons ("a module with 3 lessons"), so we do NOT
 *  disqualify on the word "lessons" — instead `LESSON_INTO_MODULE` (checked
 *  first) carves out the narrow "add ONE lesson to an existing module" case. */
const MODULE_BUILD = /\b(build|create|generate|make|add|draft|write|put together|flesh out|build out)\b[^.?!]*\b(module|course|curriculum)\b/i;

/** "add/create a lesson TO/IN/UNDER module X" — a single lesson into an existing
 *  module, NOT a new-module build. Takes priority over MODULE_BUILD. */
const LESSON_INTO_MODULE = /\b(add|create|write|build|draft|make)\b[^.?!]*\blessons?\b[^.?!]*\b(to|in|into|under|for|on)\b[^.?!]*\b(module|chapter|unit)\b/i;

/** An explicit "build a lesson/deck" (NOT bare "slide", so "add a slide" stays
 *  an edit). */
const LESSON_BUILD = /\b(build|create|generate|make|write|draft|author|flesh out|build out)\b[^.?!]*\b(lessons?|decks?|slide deck)\b/i;

const CLASSIFY_SYSTEM = `You route a request to a course-building assistant into ONE mode:
- "generate_module": build a whole NEW module, or several lessons, from a topic.
- "generate_lesson": author or substantially flesh out a full slide deck for ONE lesson.
- "edit": any change to existing content, a question, or a SINGLE small addition — e.g. add one knowledge check, add one slide, fix wording, restyle, delete, rename, or reorder.
Default to "edit" unless the user clearly wants a whole module or a full lesson deck generated. Return only the json_schema object.`;

/**
 * Decide the agent mode for this turn. `hasDeck` lightly informs the model
 * (an empty lesson tilts toward generation). Falls back to "edit" if the
 * classifier errors — the conservative choice (never surprise the user with the
 * heavy pipeline + approval gate on an ambiguous message).
 */
export async function classifyIntent(
  model: ModelClient,
  ctx: { hasDeck: boolean },
  userMessage: string
): Promise<AgentMode> {
  const msg = userMessage.trim();

  // High-precision short-circuits (no model call). "add a lesson to module X" is
  // a single lesson; everything else that builds a module → the module pipeline
  // (a module build naming its lessons must NOT be diverted to a single lesson).
  if (LESSON_INTO_MODULE.test(msg)) return "generate_lesson";
  if (MODULE_BUILD.test(msg)) return "generate_module";
  if (LESSON_BUILD.test(msg)) return "generate_lesson";

  const system = `${CLASSIFY_SYSTEM}\n(The current lesson ${ctx.hasDeck ? "already has a slide deck" : "has no slide deck yet"}.)`;
  try {
    const res = await model.runTurn(
      {
        system,
        input: [{ role: "user", content: msg }],
        tools: [],
        effort: AI_CLASSIFIER_EFFORT, // low (gpt-5.4-mini rejects "minimal")
        model: AI_CLASSIFIER_MODEL, // cheap routing; never the strong model
        responseFormat: { name: "intent", schema: toStrictJsonSchema(IntentSchema) },
      },
      () => {}
    );
    const parsed = IntentSchema.safeParse(JSON.parse(res.text || "{}"));
    if (parsed.success) return parsed.data.mode;
  } catch {
    /* fall through to the conservative default */
  }
  return "edit";
}
