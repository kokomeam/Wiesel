/**
 * OPTIONAL lightweight review — explicitly NOT the old heavy CRITIQUE loop.
 *
 * ONE model call, no tool loop, no regeneration, cheap model by default. It reads
 * the finished deck AS DATA plus the plan + the deterministic lint warnings, and
 * returns at most three SOFT, actionable suggestions for the creator to apply (or
 * ignore). It never mutates the course — it's a review assistant, not a second
 * generation agent. Gated OFF by default; the pipeline only calls it when enabled
 * or when the linter flagged enough rough edges to be worth a second opinion.
 */

import { findLesson } from "@/lib/course/queries";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import type { LoopContext } from "./agentLoop";
import { AI_LIGHT_REVIEW } from "./modelConfig";
import { outlinePromptFragment, type LessonOutline } from "./outline";
import { toStrictJsonSchema } from "./schema";
import { z } from "zod";
import type { LintWarning } from "./lintGeneration";

export interface ReviewSuggestion {
  title: string;
  detail: string;
}

const ReviewSchema = z.object({
  coherent: z.boolean().describe("Does the lesson hold together as a coherent teaching arc?"),
  matchesPlan: z.boolean().describe("Does the generated deck deliver what the plan promised?"),
  topSuggestions: z
    .array(
      z.object({
        title: z.string().describe("A short, concrete improvement (≤ ~8 words)."),
        detail: z.string().describe("One sentence: what to change and why it helps the learner."),
      })
    )
    .describe("At most 3 highest-impact, actionable suggestions. Empty if the lesson is already strong."),
});

const REVIEW_SYSTEM = `You are a calm, experienced instructional reviewer giving a SECOND OPINION on a finished lesson. You are NOT rewriting it and you have no tools. Read the lesson objective, the approved plan, the deck (as data), and the automated lint notes, then answer:
- Is the lesson coherent and does it match the plan?
- Are any slides too thin, or any examples not concrete enough?
- Are there missing practice / check-for-understanding opportunities?
Return at most THREE specific, high-impact suggestions a creator could act on in a minute — or none if it's already strong. Be concrete (name the slide / the idea). Do not invent problems to fill the list. Return only the json_schema object.`;

/** Should the pipeline run the optional light review? Enabled outright, or
 *  triggered when the linter raised at least the configured threshold. */
export function shouldRunLightReview(warnings: LintWarning[]): boolean {
  if (AI_LIGHT_REVIEW.enabled) return true;
  return AI_LIGHT_REVIEW.onLintThreshold && warnings.length >= AI_LIGHT_REVIEW.lintThreshold;
}

/** Lean deck-as-data for the review input (ids kept so suggestions can reference
 *  a slide; heavy `ai`/`style` envelopes dropped). */
function serializeDecks(doc: CourseDocument, lessonId: string): string {
  const lesson = findLesson(doc, lessonId)?.lesson;
  if (!lesson) return "(no lesson)";
  const decks = lesson.blocks.filter((b): b is SlideDeckBlock => b.type === "slide_deck");
  if (!decks.length) return "(no slide deck)";
  const lean = decks.map((d) => ({
    blockId: d.id,
    title: d.title,
    slides: d.slides.map((s) => ({
      slideId: s.id,
      layout: s.template?.layoutId ?? s.layout,
      ...(s.template ? { content: s.template.content } : { elements: s.elements }),
    })),
  }));
  return JSON.stringify(lean);
}

/**
 * Run the single-call light review. Returns up to 3 suggestions (clamped), or an
 * empty array on any failure (the review is strictly optional — never block on
 * it). Counts one call against the shared run budget.
 */
export async function runLightReview(
  c: LoopContext,
  doc: CourseDocument,
  lessonId: string,
  outline: LessonOutline,
  lintWarnings: LintWarning[]
): Promise<ReviewSuggestion[]> {
  if (c.callBudget) {
    if (c.callBudget.remaining <= 0) return [];
    c.callBudget.remaining -= 1;
  }

  const lintLines = lintWarnings.length
    ? `AUTOMATED LINT NOTES:\n${lintWarnings.map((w) => `- ${w.message}`).join("\n")}`
    : "AUTOMATED LINT NOTES: none.";
  const context = [
    outlinePromptFragment(outline),
    "",
    "FINISHED DECK (as data):",
    serializeDecks(doc, lessonId),
    "",
    lintLines,
  ].join("\n");

  try {
    const res = await c.model.runTurn(
      {
        system: REVIEW_SYSTEM,
        input: [
          { role: "developer", content: context },
          { role: "user", content: "Give your top suggestions for this lesson." },
        ],
        tools: [],
        effort: AI_LIGHT_REVIEW.effort,
        model: AI_LIGHT_REVIEW.model,
        responseFormat: { name: "lesson_review", schema: toStrictJsonSchema(ReviewSchema) },
        maxOutputTokens: 8000,
        signal: c.signal,
      },
      () => {}
    );
    const parsed = ReviewSchema.safeParse(JSON.parse(res.text || "{}"));
    if (!parsed.success) return [];
    return parsed.data.topSuggestions.slice(0, 3);
  } catch {
    return [];
  }
}
