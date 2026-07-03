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

export type AgentMode = "generate_module" | "generate_lesson" | "edit" | "structure" | "analyze";

const IntentSchema = z.object({ mode: z.enum(["generate_module", "generate_lesson", "edit", "structure", "analyze"]) });

/** Learner-analytics questions ("why are students dropping off in module 3?",
 *  "which quiz questions are too hard?") → the MAINTENANCE agent. Checked FIRST:
 *  analysis vocabulary never collides with the structure/build verbs, and an
 *  analytics question must never fall into an edit/build pipeline. */
const ANALYZE_RE =
  /\b(analy[sz]e|analytics|dropp(?:ing)?\s*off|drop[- ]?offs?|struggling|falling behind|stuck (?:learners?|students?)|course health|health check|quiz (?:stats|performance|results|analytics)|item analysis|why (?:are|do|is)\b[^.?!]*\b(?:students?|learners?))\b/i;

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

/** Course-STRUCTURE edits (the course TREE — modules/lessons), as opposed to slide
 *  content. "delete empty lessons" needs no module noun; the others do. These route
 *  to the Course Structure agent so the wrong target can't be edited. */
const STRUCTURE_DELETE_EMPTY = /\b(delete|remove|clear|prune|clean up|get rid of)\b[^.?!]*\bempty\b[^.?!]*\blessons?\b/i;
const STRUCTURE_VERB = /\b(delete|remove|recreate|re-?create|rebuild|re-?build|regenerate|redo|remake|rename|re-?title|move|reorder|re-?order|rearrange)\b[^.?!]*\b(lessons?|modules?|chapters?|units?)\b/i;

/** A reference to an EXISTING module (ordinal / "Module N" / current / this / first). */
const EXISTING_MODULE_REF = /\b(module\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)|(?:the\s+)?(?:first|second|third|fourth|fifth|last|current|existing|selected)\s+(?:module|chapter|unit)|this\s+(?:module|chapter|unit))\b/i;
/** A REPAIR / complete / fill-out / rework verb (finish an existing thing, NOT a fresh build). */
const REPAIR_VERB = /\b(complete|finish|fix|repair|fill\s+(?:it|them|this|out)|flesh\s+(?:it|them|this|out)|improve|rework|redo|polish|finali[sz]e|round\s+out|build\s+out|fill\s+out|finish\s+up|work\s+on)\b/i;
/** A description of an EXISTING module being unfinished/empty/missing-a-title. */
const INCOMPLETE_DESC = /\b(unfinished|incomplete|empty|blank|placeholder|missing|half[\s-]?(?:done|finished|built)|no\s+title|without\s+a\s+title|no\s+lessons|empty\s+slides|nothing\s+in\s+it)\b/i;
/** "make / turn Module N into …" — reshape an existing module in place. */
const MAKE_MODULE_INTO = /\b(make|turn|convert|use)\b[^.?!]{0,40}\b(module\s+(?:one|two|three|four|five|\d+)|(?:the\s+)?(?:first|second|third|current|this)\s+(?:module|chapter|unit))\b/i;
/** An EXPLICIT request for a NEW module — must stay generate_module (opts out of repair). */
const NEW_MODULE = /\b(new|another|additional|separate|extra|second|third|one\s+more)\b[^.?!]{0,20}\b(module|chapter|unit)\b|\b(module|chapter|unit)\b[^.?!]{0,20}\bfrom\s+scratch\b/i;

const CLASSIFY_SYSTEM = `You route a request to a course-building assistant into ONE mode:
- "analyze": a question about LEARNER PERFORMANCE or course analytics — drop-off, struggling students, quiz difficulty, engagement, "how is the course doing" — NOT a content edit. The maintenance agent answers with data and proposes fixes.
- "structure": edit the course OUTLINE (the TREE of modules/lessons), NOT authoring slides. This includes: create / delete / rename / move / reorder a LESSON or MODULE; AND repairing / completing / filling out / finishing / fixing / reworking an EXISTING module or lesson (e.g. "complete module one", "module one is unfinished / has empty slides, fill it out", "finish the first module", "make Module 1 an intro economics module"). Setting a missing module/lesson title, replacing empty/placeholder decks, and adding the missing lessons inside an existing module are all "structure".
- "generate_module": build a whole NEW module from a topic — ONLY when the user explicitly asks for a NEW / another / additional module, or does not reference any existing module.
- "generate_lesson": author or substantially flesh out a full slide deck for ONE lesson.
- "edit": any change to existing slide content, a question, or a SINGLE small addition — e.g. add one knowledge check, add one slide to the current deck, fix wording, restyle.
If the user references an EXISTING module/lesson by ordinal ("module one", "Module 1"), position ("the first module"), or selection ("this/current module"), PREFER "structure" over "generate_module" — repair it in place, never duplicate it. Default to "edit" otherwise unless the user clearly wants a whole new module or a full lesson deck generated. Return only the json_schema object.`;

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

  // High-precision short-circuits (no model call). Course-STRUCTURE edits are
  // checked FIRST so they can't be mis-routed to content generation:
  //  - "delete the empty lessons" → structure (delete, don't fill).
  //  - "add a lesson to Module X" → structure (CREATE a lesson in Module X, then
  //    build its deck) — NOT generate_lesson, which would build a deck in the
  //    currently-docked lesson (the bug this whole layer fixes).
  //  - "delete/recreate/rename/move/reorder a lesson|module" → structure.
  // Only AFTER that do the content-build short-circuits run (a NEW module/lesson
  // built from a topic, which is authoring, not tree editing).
  // Analytics questions FIRST — "why are students dropping off in module 3"
  // contains "module" and would otherwise brush the structure/build regexes.
  if (ANALYZE_RE.test(msg)) return "analyze";
  if (STRUCTURE_DELETE_EMPTY.test(msg)) return "structure";
  if (LESSON_INTO_MODULE.test(msg)) return "structure";
  if (STRUCTURE_VERB.test(msg)) return "structure";
  // REPAIR / COMPLETE an EXISTING module → structure (modify in place, NEVER a new
  // module). Checked BEFORE the module-build short-circuit so "complete module one",
  // "module one is unfinished / has empty slides", and "make Module 1 an econ module"
  // can't fall into generate_module. An explicit "new/another module" opts out.
  if (
    !NEW_MODULE.test(msg) &&
    EXISTING_MODULE_REF.test(msg) &&
    (REPAIR_VERB.test(msg) || INCOMPLETE_DESC.test(msg) || MAKE_MODULE_INTO.test(msg))
  ) {
    return "structure";
  }
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
