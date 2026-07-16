/**
 * Clip context assembly (PRD 1.5 §7.1) — wraps the Phase 1 source-context
 * assembler (never a second retriever) and appends the ONE input generic
 * horizontal tools cannot have: QUIZ-MISS CONCEPTS. When analytics rollups
 * exist for this lesson, questions students get wrong become explicit
 * misconception targets ("the thing students get wrong" is the strongest clip
 * subject in this vertical — §7.1). Strictly optional: the engine works
 * without it (no publication, no attempts, no rollups ⇒ empty section).
 *
 * Slide-sync data does NOT exist on this platform (slides are not aligned to
 * video timestamps), so the PRD's "slide text aligned to timestamps where
 * available" input is deliberately absent — documented in docs/clips.md.
 * (The amendment made slide-sync a first-class CONTRACT — see routing.ts —
 * but the producer still doesn't exist; loadLessonSlideSync returns null.)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { assembleSourceContext, type AssembledContext } from "../social/contextAssembly";

type DB = SupabaseClient<Database>;

export interface QuizMissConcept {
  question: string;
  pctCorrect: number;
  respondents: number;
}

/** Sufficiently-answered questions under this bar are misconception signals. */
const QUIZ_MISS_PCT_BAR = 60;
const QUIZ_MISS_MIN_N = 3;
const QUIZ_MISS_MAX = 5;

interface QuizQuestionShape {
  id?: unknown;
  prompt?: unknown;
}

/**
 * Best-effort: rollup_question_stats rows for this lesson (author RLS) joined
 * to question wording from the DRAFT quiz blocks — block/question ids survive
 * publishing verbatim (the node-id invariant), so the join is direct.
 */
export async function loadQuizMissConcepts(
  supabase: DB,
  courseId: string,
  lessonId: string
): Promise<QuizMissConcept[]> {
  try {
    const { data: stats } = await supabase
      .from("rollup_question_stats")
      .select("block_id,question_id,pct_correct,n")
      .eq("course_id", courseId)
      .eq("lesson_id", lessonId)
      .not("pct_correct", "is", null)
      .lt("pct_correct", QUIZ_MISS_PCT_BAR)
      .gte("n", QUIZ_MISS_MIN_N)
      .order("pct_correct", { ascending: true })
      .limit(QUIZ_MISS_MAX);
    if (!stats || stats.length === 0) return [];

    const blockIds = [...new Set(stats.map((s) => s.block_id))];
    const { data: blocks } = await supabase
      .from("blocks")
      .select("id,content")
      .in("id", blockIds);

    const promptByQuestion = new Map<string, string>();
    for (const block of blocks ?? []) {
      const content = block.content as { questions?: QuizQuestionShape[] } | null;
      for (const q of content?.questions ?? []) {
        if (typeof q?.id === "string" && typeof q?.prompt === "string") {
          promptByQuestion.set(`${block.id}:${q.id}`, q.prompt);
        }
      }
    }

    return stats.flatMap((s) => {
      const prompt = promptByQuestion.get(`${s.block_id}:${s.question_id}`);
      if (!prompt) return [];
      return [
        {
          question: prompt,
          pctCorrect: Math.round(Number(s.pct_correct)),
          respondents: s.n,
        },
      ];
    });
  } catch {
    return []; // optional input — never fail selection on analytics access
  }
}

export interface ClipContext {
  /** The grounding text handed to the prompt (course + lesson + quiz-miss). */
  text: string;
  /** The lint whitelist input (creator-authored context). */
  sourceContext: string;
  quizMisses: QuizMissConcept[];
  assembled: AssembledContext;
}

export async function assembleClipContext(
  supabase: DB,
  args: { courseId: string; lessonId: string },
  maxTokens: number
): Promise<ClipContext> {
  const assembled = await assembleSourceContext(
    supabase,
    { sourceType: "lesson", courseId: args.courseId, lessonId: args.lessonId },
    maxTokens
  );
  const quizMisses = await loadQuizMissConcepts(supabase, args.courseId, args.lessonId);

  const missBlock =
    quizMisses.length > 0
      ? [
          "",
          "QUIZ-MISS CONCEPTS (students get these wrong — misconception-centered moments on them score higher):",
          ...quizMisses.map(
            (m) => `- "${m.question}" (${m.pctCorrect}% correct across ${m.respondents} students)`
          ),
        ].join("\n")
      : "";

  return {
    text: `${assembled.text}${missBlock}`,
    sourceContext: assembled.text,
    quizMisses,
    assembled,
  };
}
