/**
 * Snapshot builder — PURE. Turns the live draft CourseDocument into the
 * immutable publication snapshot (what students receive) plus the server-only
 * quiz answer keys stripped out of it.
 *
 * Invariants:
 *   • Node ids (module/lesson/block/slide/question) are preserved verbatim so
 *     progress + analytics stay joinable across versions.
 *   • The snapshot never contains a correct answer, accepted answer, or
 *     explanation for any quiz question — those move into the keys.
 *   • Everything is deep-cloned: mutating the draft after building can never
 *     reach into the snapshot.
 */

import type { CourseDocument, QuizBlock, QuizQuestion } from "@/lib/course/types";
import {
  type AnswerKeyEntry,
  type PublicationAnswerKeys,
  type PublicationSnapshot,
  type PublishedLessonBlock,
  type PublishedQuizBlock,
  type PublishedQuizQuestion,
} from "./schemas";

export interface BuiltPublication {
  snapshot: PublicationSnapshot;
  answerKeys: PublicationAnswerKeys;
}

function splitQuestion(q: QuizQuestion): {
  published: PublishedQuizQuestion;
  key: AnswerKeyEntry;
} {
  const base = { id: q.id, prompt: q.prompt, objectiveId: q.objectiveId };
  switch (q.kind) {
    case "multiple_choice":
      return {
        published: {
          ...base,
          kind: "multiple_choice",
          choices: q.choices.map((c) => ({ id: c.id, text: c.text })),
        },
        key: {
          kind: "multiple_choice",
          questionId: q.id,
          correctChoiceId: q.correctChoiceId,
          explanation: q.explanation,
        },
      };
    case "multi_select":
      return {
        published: {
          ...base,
          kind: "multi_select",
          choices: q.choices.map((c) => ({ id: c.id, text: c.text })),
        },
        key: {
          kind: "multi_select",
          questionId: q.id,
          correctChoiceIds: [...q.correctChoiceIds],
          explanation: q.explanation,
        },
      };
    case "true_false":
      return {
        published: { ...base, kind: "true_false" },
        key: {
          kind: "true_false",
          questionId: q.id,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
        },
      };
    case "short_answer":
      return {
        published: { ...base, kind: "short_answer" },
        key: {
          kind: "short_answer",
          questionId: q.id,
          expectedAnswer: q.expectedAnswer,
          acceptedAnswers: q.acceptedAnswers ? [...q.acceptedAnswers] : undefined,
          explanation: q.explanation,
        },
      };
  }
}

function publishQuizBlock(block: QuizBlock): {
  published: PublishedQuizBlock;
  keys: AnswerKeyEntry[];
} {
  const split = block.questions.map(splitQuestion);
  return {
    published: {
      id: block.id,
      type: "quiz",
      title: block.title,
      order: block.order,
      ai: structuredClone(block.ai),
      settings: block.settings ? structuredClone(block.settings) : undefined,
      questions: split.map((s) => s.published),
    },
    keys: split.map((s) => s.key),
  };
}

/** Build the publication snapshot + answer keys from a draft document. */
export function buildPublicationSnapshot(doc: CourseDocument): BuiltPublication {
  const answerKeys: PublicationAnswerKeys = [];

  const modules = doc.modules.map((m) => ({
    id: m.id,
    type: "module" as const,
    title: m.title,
    description: m.description,
    order: m.order,
    lessons: m.lessons.map((l) => ({
      id: l.id,
      type: "lesson" as const,
      title: l.title,
      objective: l.objective,
      order: l.order,
      estimatedMinutes: l.estimatedMinutes,
      blocks: l.blocks.map((b): PublishedLessonBlock => {
        if (b.type === "quiz") {
          const { published, keys } = publishQuizBlock(b);
          if (keys.length > 0) answerKeys.push({ blockId: b.id, keys: { questions: keys } });
          return published;
        }
        return structuredClone(b);
      }),
    })),
  }));

  return {
    snapshot: {
      schemaVersion: 1,
      course: {
        id: doc.id,
        title: doc.title,
        description: doc.description,
        audience: doc.audience,
        level: doc.level,
        plan: structuredClone(doc.plan),
        theme: structuredClone(doc.theme),
      },
      modules,
    },
    answerKeys,
  };
}

/**
 * Field names that must NEVER appear anywhere in a client-reachable
 * publication payload. (`explanation` also lives on non-quiz blocks — e.g.
 * ExampleBlock — so it is checked separately, scoped to quiz blocks, by
 * `findAnswerKeyLeaks`.)
 */
export const FORBIDDEN_SNAPSHOT_KEYS = [
  "correctChoiceId",
  "correctChoiceIds",
  "correctAnswer",
  "expectedAnswer",
  "acceptedAnswers",
] as const;

/**
 * Deep-scan any payload for answer-key leaks. Returns JSON-path-ish strings of
 * every hit (empty array = clean). Used by tests and as a belt-and-braces
 * assertion before publishing.
 */
export function findAnswerKeyLeaks(value: unknown, path = "$"): string[] {
  const leaks: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaks.push(...findAnswerKeyLeaks(item, `${path}[${i}]`)));
    return leaks;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const isQuizNode =
      record.type === "quiz" ||
      (typeof record.kind === "string" &&
        ["multiple_choice", "multi_select", "true_false", "short_answer"].includes(record.kind));
    for (const [key, child] of Object.entries(record)) {
      if ((FORBIDDEN_SNAPSHOT_KEYS as readonly string[]).includes(key)) {
        leaks.push(`${path}.${key}`);
      }
      if (key === "explanation" && isQuizNode) {
        leaks.push(`${path}.${key}`);
      }
      leaks.push(...findAnswerKeyLeaks(child, `${path}.${key}`));
    }
  }
  return leaks;
}
