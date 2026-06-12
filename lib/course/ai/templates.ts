/**
 * Canned content for the mock AI. Everything here is deterministic — banks
 * are cycled by current item count, never randomized, so the same command on
 * the same document always produces the same patches.
 */

import { newId } from "../factories";
import type {
  HomeworkExercise,
  QuizDifficulty,
  QuizQuestion,
  Slide,
  SlideElement,
} from "../types";

export { PLACEHOLDER_IMAGES, placeholderImageFor } from "../slide/placeholderImages";

/* ─────────────────────────── Quiz questions ───────────────────────────── */

interface QuestionSeed {
  prompt: string;
  choices?: string[];
  correctIndex?: number;
  trueFalse?: boolean;
  shortAnswer?: string;
  explanation: string;
}

const questionBank: QuestionSeed[] = [
  {
    prompt:
      "Two pointers l and r scan a sorted array from both ends. What is the maximum total number of pointer movements?",
    choices: ["n²", "n log n", "n − 1", "2n log n"],
    correctIndex: 2,
    explanation:
      "Each step moves exactly one pointer inward by one, and they start n−1 apart, so they meet after at most n−1 moves.",
  },
  {
    prompt:
      "A sliding window maintains the sum of elements inside it. When the window grows by one element on the right, how is the sum updated?",
    choices: [
      "Recompute the whole window in O(k)",
      "Add the new element in O(1)",
      "Binary search for the new sum",
      "Sort the window first",
    ],
    correctIndex: 1,
    explanation:
      "Window aggregates are maintained incrementally: add the entering element, subtract the leaving one. That is what keeps the total work linear.",
  },
  {
    prompt:
      "Two pointers can find a pair with a given sum in any unsorted array without preprocessing.",
    trueFalse: false,
    explanation:
      "The elimination argument needs sortedness: only then does a too-small sum prove the left element can be retired.",
  },
  {
    prompt:
      "For counting pairs (i, j) with a[i] + a[j] ≤ S in a sorted array, what does (right − left) represent when the window is valid?",
    shortAnswer: "The number of valid pairs ending at right",
    explanation:
      "Every index in [left, right) pairs validly with right, so they can be counted in one O(1) step.",
  },
  {
    prompt:
      "Which invariant must hold for a two-pointer solution to be correct?",
    choices: [
      "Both pointers move in the same direction every step",
      "Each step provably eliminates at least one candidate",
      "The array contains no duplicates",
      "The window size stays constant",
    ],
    correctIndex: 1,
    explanation:
      "Correctness rests on monotone elimination: every move discards candidates that provably cannot be part of the answer.",
  },
  {
    prompt:
      "After sorting, the two-pointer pass itself runs in O(n). Sorting dominates, so the total is O(n log n).",
    trueFalse: true,
    explanation:
      "The pointer walk is linear, but comparison sorting costs O(n log n), which dominates the total.",
  },
];

export function questionFromBank(
  index: number,
  difficulty: QuizDifficulty
): QuizQuestion {
  const seed = questionBank[index % questionBank.length];
  const base = {
    id: newId("q"),
    prompt: seed.prompt,
    explanation: seed.explanation,
    difficulty,
  };
  if (seed.choices) {
    const choices = seed.choices.map((text) => ({ id: newId("c"), text }));
    return {
      ...base,
      kind: "multiple_choice",
      choices,
      correctChoiceId: choices[seed.correctIndex ?? 0].id,
    };
  }
  if (seed.trueFalse !== undefined) {
    return { ...base, kind: "true_false", correctAnswer: seed.trueFalse };
  }
  return { ...base, kind: "short_answer", expectedAnswer: seed.shortAnswer ?? "" };
}

/* ───────────────────────────── Explanations ───────────────────────────── */

export function explanationFor(question: QuizQuestion): string {
  switch (question.kind) {
    case "multiple_choice": {
      const correct = question.choices.find((c) => c.id === question.correctChoiceId);
      return `The correct answer is "${correct?.text ?? "—"}". Work backwards from the invariant: which option keeps every pointer move justified? The others each break the elimination argument.`;
    }
    case "true_false":
      return `This is ${question.correctAnswer ? "true" : "false"}. Test the claim against the core invariant — each step must provably eliminate a candidate — and the answer falls out.`;
    case "short_answer":
      return `Expected: "${question.expectedAnswer}". If your answer differed, re-derive it from the window invariant rather than memorizing the formula.`;
  }
}

/* ──────────────────────────── Lecture text ────────────────────────────── */

/** Deterministic "simplify": lead with a plain-terms cue and trim long
 *  paragraphs at a sentence boundary. */
export function simplifyText(text: string): string {
  if (text.startsWith("In plain terms")) return text;
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const kept: string[] = [];
  let total = 0;
  for (const s of sentences) {
    kept.push(s.trim());
    total += s.length;
    if (total > 220 && kept.length >= 2) break;
  }
  return `In plain terms: ${kept.join(" ")}`;
}

export const analogyParagraph =
  "Analogy: picture two friends closing a zipper from opposite ends. Each tooth they pass is checked exactly once, nobody ever backtracks, and when their hands meet, every tooth has been handled — that is two pointers in one image.";

/* ─────────────────────────── Example blocks ───────────────────────────── */

export const exampleSeed = {
  title: "Worked example: Window of Hay",
  context:
    "Bessie has hay bale weights [2, 5, 7, 8, 12, 13] and wants the longest contiguous run weighing at most 20 in total.",
  explanation:
    "Grow the window on the right; whenever the sum exceeds 20, shrink from the left. Each element enters and leaves at most once.",
  steps: [
    "right takes 2, 5, 7 → sum 14, window length 3.",
    "right takes 8 → sum 22 > 20, shrink: drop 2 → sum 20, length still 3.",
    "right takes 12 → sum 32, shrink twice → window [8, 12], the best stays 3.",
  ],
  takeaway:
    "Both endpoints only move forward, so the total work is O(n) even though the window keeps changing size.",
};

export const concreteAddendum =
  " Concretely: with n = 2·10⁵ and 10⁸ simple operations per second, the O(n²) version needs ~400 seconds while this approach needs ~0.002 — that is the entire difference between TLE and full marks.";

/* ─────────────────────────── Homework extras ──────────────────────────── */

const exerciseBank: Omit<HomeworkExercise, "id">[] = [
  {
    title: "Maximum cows in a window",
    prompt:
      "Given n cow positions, find the largest number of cows within any window of width k. State your pointer invariant first, then implement in O(n log n).",
    hint: "Sort, then advance right; move left only while the window is too wide.",
  },
  {
    title: "Closest pair sum",
    prompt:
      "Given a sorted array and target T, find the pair whose sum is closest to T. Prove no pair is skipped by your pointer moves.",
    hint: "Track the best difference seen; move the pointer on the side that overshoots.",
  },
  {
    title: "Distinct window count",
    prompt:
      "Find the longest window containing at most two distinct values. Generalize: what changes for k distinct values?",
    hint: "Keep a count map; shrink from the left while the map has too many keys.",
  },
];

export function exerciseFromBank(index: number): HomeworkExercise {
  const seed = exerciseBank[index % exerciseBank.length];
  return { id: newId("ex"), ...seed };
}

export function solutionFor(exercise: HomeworkExercise): string {
  return `Sketch: sort if needed, maintain the window invariant from the hint${exercise.hint ? ` ("${exercise.hint}")` : ""}, and argue each pointer moves at most n times. Full marks require stating the invariant before the loop and handling the empty-window edge case.`;
}

/* ─────────────────────────────── Slides ───────────────────────────────── */

function slideHeadingText(slide: Slide): string {
  const heading = slide.elements.find((el) => el.type === "heading");
  return heading?.type === "heading" && heading.text.trim()
    ? heading.text
    : (slide.title ?? "this slide");
}

export function speakerNotesFor(slide: Slide): string {
  return `Walk through "${slideHeadingText(slide)}" slowly: state the claim, run the smallest example by hand, then ask the class to predict the next step before revealing it.`;
}

export function altTextFor(slide: Slide, el: SlideElement): string {
  if (el.type === "image" && el.caption?.trim()) return el.caption;
  return `Illustration supporting "${slideHeadingText(slide)}"`;
}
