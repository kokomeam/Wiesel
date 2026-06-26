/**
 * AUX content (quiz + homework) authored as ONE structured call, run CONCURRENTLY
 * with slide authoring (ITEM 4). Quiz/homework depend only on the approved PLAN's
 * quizPlan/homeworkPlan — never the slide narrative — so they don't belong on the
 * slide loop's critical path. This is a single non-looping structured-output turn
 * (not a tool loop), so the mock can route it deterministically by responseFormat
 * name even while the slide loop runs.
 *
 * The blocks are built DETERMINISTICALLY from the parsed content (blockBuilders), so
 * this never mutates the DB — it returns the parsed specs and the caller merges the
 * built blocks into the doc before the single reconcile + stage.
 */

import { z } from "zod";
import type { JsonSchema } from "./modelClient";
import { toStrictJsonSchema } from "./schema";
import { questionSchema } from "./tools/writers";
import type { LessonOutline } from "./outline";

const QuizSchema = z.object({
  title: z.string().nullable().describe("Quiz title, or null."),
  questions: z.array(questionSchema).describe("The knowledge-check questions."),
});

const HomeworkSchema = z.object({
  title: z.string().nullable().describe("Homework title, or null."),
  instructions: z.string().describe("What the learner should do."),
  deliverableType: z.enum(["none", "text_response", "file_upload", "external_link"]).describe("How work is submitted; 'none' = self-paced."),
  exercises: z
    .array(z.object({ title: z.string(), prompt: z.string(), hint: z.string().nullable(), solution: z.string().nullable() }))
    .describe("The practice exercises."),
  rubric: z
    .array(z.object({ name: z.string(), description: z.string().nullable(), levels: z.array(z.object({ label: z.string(), description: z.string().nullable() })) }))
    .nullable()
    .describe("Optional qualitative rubric (no points)."),
});

/** The combined aux schema — fill `quiz` and/or `homework` per the plan; null the
 *  one the plan didn't ask for. */
export const AuxContentSchema = z.object({
  quiz: QuizSchema.nullable(),
  homework: HomeworkSchema.nullable(),
});
export type AuxContent = z.infer<typeof AuxContentSchema>;

export const AUX_RESPONSE_NAME = "aux_content";

export function auxContentResponseFormat(): { name: string; schema: JsonSchema } {
  return { name: AUX_RESPONSE_NAME, schema: toStrictJsonSchema(AuxContentSchema) };
}

/** Parse the model's aux JSON; null on any failure (the caller degrades to the
 *  existing validate/repair path, which authors quiz/homework if still missing). */
export function parseAuxContent(raw: string): AuxContent | null {
  try {
    return AuxContentSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export const AUX_SYSTEM_PROMPT =
  "You are authoring ONLY the assessment artifacts for a lesson — a low-stakes knowledge-check quiz and/or a homework practice — from the approved lesson plan. Write real, answerable questions and concrete exercises that check the lesson's skills. Return STRICT JSON: fill `quiz` when a quiz is planned and `homework` when homework is planned; set the other to null. Do NOT write slides. No scores, points, time limits, or due dates.";

/** Build the user instruction for the aux call from the plan's quiz/homework plans. */
export function auxRequest(outline: LessonOutline): string {
  const parts = [`Lesson objective: ${outline.objective}. For: ${outline.targetStudent}.`];
  if (outline.quizPlan) {
    parts.push(
      `QUIZ: ${outline.quizPlan.questionCount} question(s) checking — ${outline.quizPlan.targetSkills.map((t) => `${t.skill} (${t.difficulty})`).join(", ")}.`
    );
  } else {
    parts.push("QUIZ: none — set quiz to null.");
  }
  if (outline.homeworkPlan) {
    parts.push(
      `HOMEWORK: ${outline.homeworkPlan.exerciseCount} exercise(s), ${outline.homeworkPlan.difficulty} — practicing ${outline.homeworkPlan.targetSkills.join(", ")}.`
    );
  } else {
    parts.push("HOMEWORK: none — set homework to null.");
  }
  return parts.join("\n");
}
