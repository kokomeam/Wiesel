/**
 * The bad-lesson RATIONALE prompt (TUTOR-1 Wave 5, P5.3).
 *
 * PURE. The nightly Inngest step (lib/inngest/functions/tutorLessonHealth.ts)
 * hands Terra the ALREADY-COMPUTED composite evidence for one flagged lesson and
 * asks for ONE short prose paragraph. The model writes ONLY `rationale` — it never
 * computes, ranks, or invents numbers (the composite is deterministic SQL). This
 * module is the boundary: the prompt names the driving signals + the implicated
 * question, and the strict output schema caps the prose. No Date.now / Math.random.
 */

import { z } from "zod";
import type { LessonHealthInputs } from "./lessonHealth";

/** The most-missed question the rationale may name (compact aggregate, no learner). */
export interface WorstQuestionEvidence {
  questionId: string;
  /** 0..100, or null for short-answer (no distribution). */
  pctCorrect: number | null;
  /** Distinct respondents (already ≥ the rollup's noise floor). */
  n: number;
}

/** Everything the rationale prompt reads for one flagged lesson. Aggregates only. */
export interface LessonHealthEvidence {
  publicationId: string;
  lessonId: string;
  compositeScore: number;
  inputs: LessonHealthInputs;
  worstQuestion: WorstQuestionEvidence | null;
}

/** Terra's bounded output: a single short case. Capped so it stays a caption, not
 *  an essay (a strict json_schema turn). */
export const LessonRationaleOutputSchema = z.object({
  rationale: z.string().min(1).max(400),
});
export type LessonRationaleOutput = z.infer<typeof LessonRationaleOutputSchema>;

/** Human labels for the five inputs (the prompt names the signal, not the column). */
const INPUT_LABELS: Record<keyof LessonHealthInputs, string> = {
  masteryShortfall: "concept mastery shortfall (learners below the mastery threshold)",
  firstAttemptErrorRate: "first-attempt quiz error rate",
  confusionDensity: "learner-reported confusion density",
  dropoutAfterRate: "drop-off entering this lesson",
  rewatchScrubDensity: "video rewatch/scrub (viewers not finishing)",
};

/** Order the inputs strongest-first so the prompt foregrounds the driving signal. */
function rankedInputs(inputs: LessonHealthInputs): Array<{ key: keyof LessonHealthInputs; value: number }> {
  return (Object.keys(INPUT_LABELS) as Array<keyof LessonHealthInputs>)
    .map((key) => ({ key, value: Number.isFinite(inputs[key]) ? inputs[key] : 0 }))
    .sort((a, b) => b.value - a.value);
}

/**
 * PURE. Build the developer input for one flagged lesson. Presents the composite
 * + every input as a percentage, strongest-first, plus the implicated worst
 * question — the concrete facts Terra turns into prose. It NEVER asks the model to
 * compute or rank; those are pre-decided.
 */
export function buildLessonRationalePrompt(ev: LessonHealthEvidence): string {
  const pct = (v: number): string => `${Math.round((Number.isFinite(v) ? v : 0) * 100)}%`;
  const lines: string[] = [];
  lines.push(`Lesson composite health score (0–1, higher = needs more attention): ${ev.compositeScore.toFixed(3)}.`);
  lines.push("Signals, strongest first:");
  for (const { key, value } of rankedInputs(ev.inputs)) {
    lines.push(`  • ${INPUT_LABELS[key]}: ${pct(value)}`);
  }
  if (ev.worstQuestion) {
    const q = ev.worstQuestion;
    const correct = q.pctCorrect === null ? "(short-answer — no distribution)" : `${Math.round(q.pctCorrect)}% correct`;
    lines.push(
      `Most-missed question in this lesson: id "${q.questionId}", ${correct} over ${q.n} respondents.`
    );
  } else {
    lines.push("No single most-missed question dominates (the signal is spread across the lesson).");
  }
  lines.push(
    "Write ONE case (2–3 sentences) for why this lesson needs the creator's attention, grounded ONLY in the above. " +
      "Lead with the strongest signal; name the implicated question when one is given. Do not restate every number."
  );
  return lines.join("\n");
}
