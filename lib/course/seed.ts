/**
 * Seed course: "USACO Silver Bootcamp".
 *
 * Hand-written semantic ids and fixed ISO timestamps keep this fully
 * deterministic, so server and client render identically (no hydration
 * mismatches). Week 4's "Two Pointers Basics" lesson is fully populated;
 * slide 3 deliberately trips the quality lint (clipped text, too many bullets, high
 * density, no speaker notes) so hints are visible out of the box.
 */

import {
  componentManifest,
  defaultAIMeta,
  manifestTypeForElementType,
} from "./manifest";
import { PLACEHOLDER_IMAGES } from "./slide/placeholderImages";
import type {
  AIMeta,
  CourseDocument,
  LessonNode,
  SlideElementType,
  SlideThemeRef,
} from "./types";

const CREATED_AT = "2026-06-01T09:00:00.000Z";
const UPDATED_AT = "2026-06-10T14:30:00.000Z";

/** Editorial Warm snapshot (matches lib/course/slide/themes.ts). */
const EDITORIAL_WARM: SlideThemeRef = {
  id: "editorial-warm",
  name: "Editorial Warm",
  accentColor: "#ea580c",
  fontFamily: "sans",
};

const elAI = (type: SlideElementType, purpose: string): AIMeta =>
  defaultAIMeta(manifestTypeForElementType(type), purpose);

const slideAI = (purpose: string, formattingRules: string[]) => ({
  purpose,
  formattingRules,
  qualityChecks: ["has heading", "readable contrast", "alt text on images"],
  allowedActions: [...componentManifest.slide.allowedActions],
});

const twoPointersLesson: LessonNode = {
  id: "lesson-two-pointers",
  type: "lesson",
  title: "Two Pointers Basics",
  objective:
    "Recognize when a sorted-array problem can be solved with two pointers and implement the pattern in O(n).",
  order: 0,
  estimatedMinutes: 45,
  blocks: [
    {
      id: "block-tp-slides",
      type: "slide_deck",
      title: "Two Pointers: Core Idea",
      order: 0,
      ai: {
        ...defaultAIMeta("slide_deck"),
        purpose: "Visually introduce the two-pointer technique before practice.",
        semanticTags: ["presentation", "visual-teaching", "two-pointers"],
      },
      slides: [
        {
          id: "slide-tp-1",
          type: "slide",
          title: "Opener",
          layout: "title",
          order: 0,
          style: {
            background: {
              type: "gradient",
              gradient: { from: "#fffaf3", to: "#ffeedd", direction: "to-br" },
            },
            theme: EDITORIAL_WARM,
          },
          elements: [
            {
              id: "el-tp-1d",
              type: "divider",
              orientation: "horizontal",
              x: 480,
              y: 218,
              width: 320,
              height: 8,
              zIndex: 0,
              style: { backgroundColor: "#ea580c", opacity: 0.5, borderRadius: 4 },
              ai: elAI("divider", "Decorative accent above the title"),
            },
            {
              id: "el-tp-1a",
              type: "heading",
              text: "Two Pointers",
              x: 160,
              y: 270,
              width: 960,
              height: 110,
              zIndex: 1,
              style: { fontSize: 56, textAlign: "center" },
              ai: elAI("heading", "Section title"),
            },
            {
              id: "el-tp-1b",
              type: "text",
              text: "Turning O(n²) scans into a single linear pass.",
              x: 240,
              y: 400,
              width: 800,
              height: 70,
              zIndex: 2,
              style: { fontSize: 24, textAlign: "center" },
              ai: elAI("text", "Subtitle promising the lesson outcome"),
            },
          ],
          speakerNotes:
            "Hook: ask who has TLE'd on a pair-sum problem. Promise: by the end, that loop-in-a-loop becomes one pass.",
          ai: slideAI("Open the lesson with one big idea.", [
            "title slides carry one idea",
            "max 3 elements",
          ]),
        },
        {
          id: "slide-tp-2",
          type: "slide",
          title: "When it applies",
          layout: "image_left_text_right",
          order: 1,
          style: {
            background: {
              type: "gradient",
              gradient: { from: "#fffaf3", to: "#ffeedd", direction: "to-br" },
            },
            theme: EDITORIAL_WARM,
          },
          elements: [
            {
              id: "el-tp-2a",
              type: "heading",
              text: "When does it apply?",
              x: 72,
              y: 64,
              width: 1136,
              height: 80,
              zIndex: 0,
              style: {},
              ai: elAI("heading", "Slide title"),
            },
            {
              id: "el-tp-2img",
              type: "image",
              src: PLACEHOLDER_IMAGES[0].src,
              alt: PLACEHOLDER_IMAGES[0].alt,
              objectFit: "contain",
              x: 72,
              y: 190,
              width: 520,
              height: 440,
              zIndex: 1,
              style: { borderRadius: 16, backgroundColor: "#ffffff" },
              ai: elAI("image", "Diagram showing the two pointers converging"),
            },
            {
              id: "el-tp-2b",
              type: "bullet_list",
              items: [
                "The array (or two arrays) is sorted, or can be sorted",
                "You're looking for a pair / window with a target property",
                "Moving one end has a predictable effect on the answer",
              ],
              x: 648,
              y: 200,
              width: 560,
              height: 280,
              zIndex: 2,
              style: {},
              ai: elAI("bullet_list", "Conditions for applying two pointers"),
            },
            {
              id: "el-tp-2c",
              type: "callout",
              text: "Each pointer only ever moves one direction — that's the whole proof.",
              variant: "tip",
              x: 648,
              y: 500,
              width: 560,
              height: 130,
              zIndex: 3,
              style: {},
              ai: elAI("callout", "Key insight to remember"),
            },
          ],
          speakerNotes:
            "Emphasize the invariant: each pointer only ever moves one direction, so total work is O(n).",
          ai: slideAI("Teach the applicability conditions with a visual.", [
            "max 5 bullets per slide",
            "image has alt text",
          ]),
        },
        {
          // Deliberately messy: trips TOO_MANY_BULLETS, NO_SPEAKER_NOTES,
          // IMAGE_MISSING_ALT, LOW_CONTRAST, TOO_MANY_FONT_SIZES, and
          // TEXT_CLIPPED (el-tp-3d's box is shorter than its wrapped text)
          // so the quality linter and its one-click fixes are demonstrable.
          id: "slide-tp-3",
          type: "slide",
          title: "Pair sum",
          layout: "code_walkthrough",
          order: 2,
          style: {
            background: { type: "solid", color: "#ffffff" },
            theme: EDITORIAL_WARM,
          },
          elements: [
            {
              id: "el-tp-3a",
              type: "heading",
              text: "Pair sum in a sorted array",
              x: 72,
              y: 56,
              width: 1136,
              height: 80,
              zIndex: 0,
              style: { fontSize: 40 },
              ai: elAI("heading", "Slide title"),
            },
            {
              id: "el-tp-3b",
              type: "bullet_list",
              items: [
                "Start left at index 0, right at index n−1",
                "If a[left] + a[right] == target, you're done",
                "If the sum is too small, only moving left rightward can help",
                "If the sum is too big, only moving right leftward can help",
                "Each step eliminates one element from consideration",
                "Pointers cross ⇒ no pair exists — prove it to yourself!",
              ],
              x: 72,
              y: 150,
              width: 660,
              height: 430,
              zIndex: 1,
              style: { fontSize: 21 },
              ai: elAI("bullet_list", "Algorithm walkthrough points"),
            },
            {
              id: "el-tp-3c",
              type: "code_block",
              code: "while (l < r) {\n  long long s = a[l] + a[r];\n  if (s == target) return {l, r};\n  s < target ? l++ : r--;\n}",
              language: "cpp",
              x: 760,
              y: 150,
              width: 448,
              height: 300,
              zIndex: 2,
              style: { fontSize: 18 },
              ai: elAI("code_block", "Reference implementation"),
            },
            {
              id: "el-tp-3d",
              type: "text",
              text: "Pointers never move backwards!",
              x: 760,
              y: 480,
              width: 200,
              height: 44,
              zIndex: 3,
              style: { fontSize: 26, color: "#d4d4d8" },
              ai: elAI("text", "Emphasis line (low contrast AND clipped)"),
            },
            {
              id: "el-tp-3img",
              type: "image",
              src: PLACEHOLDER_IMAGES[1].src,
              alt: "",
              objectFit: "contain",
              x: 80,
              y: 590,
              width: 300,
              height: 110,
              zIndex: 4,
              style: { borderRadius: 12 },
              ai: elAI("image", "Supporting visual (alt text missing)"),
            },
          ],
          ai: slideAI("Walk through the pair-sum algorithm beside its code.", [
            "max 5 bullets per slide",
            "one idea per slide",
          ]),
        },
      ],
    },
    {
      id: "block-tp-lecture",
      type: "lecture_text",
      title: "Why two pointers works",
      order: 1,
      ai: {
        ...defaultAIMeta("lecture_text"),
        purpose: "Build intuition for the exchange argument behind two pointers.",
        semanticTags: ["reading", "explanation", "proof-intuition"],
      },
      tone: "beginner",
      paragraphs: [
        {
          id: "para-tp-1",
          kind: "paragraph",
          text: "The brute-force way to find a pair with a given sum is to try every pair — two nested loops, O(n²) comparisons. On USACO Silver inputs (n up to 2·10⁵), that's 4·10¹⁰ operations: far too slow. Sorting unlocks something better.",
        },
        {
          id: "para-tp-2",
          kind: "key_idea",
          text: "In a sorted array, the sum a[left] + a[right] tells you which pointer is 'wrong'. Too small? No pair involving a[left] can work, because a[right] is already the largest available partner — so left must move. Too large? The mirror argument retires a[right].",
        },
        {
          id: "para-tp-3",
          kind: "paragraph",
          text: "Each comparison permanently eliminates one element, so the pointers meet after at most n−1 steps. That's the whole trick: a structure (sortedness) converts a quadratic search into a linear walk where every step makes provable progress.",
        },
        {
          id: "para-tp-4",
          kind: "aside",
          text: "The same 'each step retires one candidate' argument powers sliding windows, merge steps, and the classic container-with-most-water problem. Learn the argument, not just the loop.",
        },
      ],
    },
    {
      id: "block-tp-example",
      type: "example",
      title: "Worked example: Cow Pairing",
      order: 2,
      ai: {
        ...defaultAIMeta("example"),
        purpose: "Walk through one concrete two-pointer run so the loop invariant is visible.",
        semanticTags: ["worked-example", "concrete", "two-pointers"],
      },
      context:
        "Farmer John has cows with milk outputs [1, 3, 4, 6, 8, 11] and wants to pair two cows producing exactly 14 units together.",
      explanation:
        "Sort is already done. Start with the widest window — smallest and largest cow — and shrink it one provable step at a time.",
      steps: [
        "left = 1, right = 11 → sum 12 < 14, so no pair with cow 1 works: move left.",
        "left = 3, right = 11 → sum 14 ✓ — found it on the second step.",
        "Had the sum overshot, we'd move right instead — note each step discards exactly one cow forever.",
      ],
      takeaway:
        "Two pointers isn't a guess-and-check: every move is justified by sortedness, which is why the answer can't be skipped.",
    },
    {
      id: "block-tp-quiz",
      type: "quiz",
      title: "Checkpoint: Two Pointers",
      order: 3,
      ai: {
        ...defaultAIMeta("quiz"),
        purpose: "Verify the learner can identify when and why two pointers applies.",
        semanticTags: ["assessment", "auto-gradable", "two-pointers"],
      },
      settings: {
        timeLimitMinutes: 10,
        attemptsAllowed: 2,
        passingScore: 70,
        whenToShowAnswers: "after_submit",
      },
      questions: [
        {
          id: "q-tp-1",
          kind: "multiple_choice",
          prompt:
            "Which technique is most appropriate for detecting a pair sum in a sorted array?",
          choices: [
            { id: "q-tp-1-a", text: "DFS" },
            { id: "q-tp-1-b", text: "Two pointers" },
            { id: "q-tp-1-c", text: "Binary heap" },
            { id: "q-tp-1-d", text: "Topological sort" },
          ],
          correctChoiceId: "q-tp-1-b",
          explanation:
            "Two pointers works because the array is sorted, allowing both ends to move inward with a provable elimination at each step.",
          difficulty: "easy",
          points: 1,
        },
        {
          id: "q-tp-2",
          kind: "true_false",
          prompt:
            "In the pair-sum algorithm, a pointer sometimes needs to move backwards to recheck a skipped element.",
          correctAnswer: false,
          explanation:
            "Never — each step permanently eliminates one element. That monotonic movement is exactly what makes the algorithm O(n).",
          difficulty: "medium",
          points: 2,
        },
        {
          id: "q-tp-3",
          kind: "short_answer",
          prompt:
            "What is the overall time complexity of two-pointer pair search on an unsorted array, including the required preprocessing?",
          expectedAnswer: "O(n log n)",
          explanation:
            "The walk itself is O(n), but sorting first costs O(n log n), which dominates.",
          difficulty: "medium",
          points: 2,
        },
      ],
    },
    {
      id: "block-tp-homework",
      type: "homework",
      title: "Practice set: Two Pointers",
      order: 4,
      ai: {
        ...defaultAIMeta("homework"),
        purpose: "Apply the two-pointer pattern to USACO-style problems independently.",
        semanticTags: ["practice", "assignment", "two-pointers"],
      },
      deliverableType: "text_response",
      points: 10,
      estimatedMinutes: 60,
      instructions:
        "Solve both problems in C++ or Python. For each, write one sentence stating the invariant your pointers maintain before you code. Target: both in under 60 minutes.",
      exercises: [
        {
          id: "ex-tp-1",
          title: "Sleepy Cow Herding (adapted)",
          prompt:
            "Given n cow positions on a number line, find the maximum number of cows inside any window of width k. Solve in O(n log n) with a sliding two-pointer window.",
          hint: "Sort positions; advance the right pointer, and move left only while the window exceeds width k.",
        },
        {
          id: "ex-tp-2",
          title: "Triplet sum under limit",
          prompt:
            "Count the number of pairs (i, j), i < j, with a[i] + a[j] ≤ S. Then extend your idea: why does the same trick not directly count triplets?",
          hint: "For each right, every index in [left, right) forms a valid pair — add them in bulk.",
          solution:
            "Sort. For each right pointer, shrink left while a[left]+a[right] > S; add (right − left) to the count. Triplets break the single-invariant property: fixing one element and two-pointering the rest gives O(n²), which is the intended extension.",
        },
      ],
      rubric: [
        {
          id: "rub-tp-1",
          name: "Correct invariant stated",
          description: "The one-sentence invariant is precise and actually maintained by the code.",
          levels: [
            { id: "rub-tp-1-l2", label: "Precise", description: "Stated and provably maintained by the loop.", points: 4 },
            { id: "rub-tp-1-l1", label: "Partial", description: "Stated but imprecise, or only loosely maintained.", points: 2 },
            { id: "rub-tp-1-l0", label: "Missing", description: "No invariant stated.", points: 0 },
          ],
        },
        {
          id: "rub-tp-2",
          name: "Linear pointer movement",
          description: "No pointer ever moves backwards; complexity is O(n) after sorting.",
          levels: [
            { id: "rub-tp-2-l2", label: "Linear", description: "Both pointers move monotonically; O(n) after sorting.", points: 4 },
            { id: "rub-tp-2-l1", label: "Suboptimal", description: "Correct, but with avoidable extra passes.", points: 2 },
            { id: "rub-tp-2-l0", label: "Non-linear", description: "Pointers backtrack or the loop is quadratic.", points: 0 },
          ],
        },
        {
          id: "rub-tp-3",
          name: "Edge cases handled",
          description: "Empty windows, duplicate values, and all-equal arrays are correct.",
          levels: [
            { id: "rub-tp-3-l1", label: "Handled", description: "Empty, duplicate, and all-equal inputs are correct.", points: 2 },
            { id: "rub-tp-3-l0", label: "Unhandled", description: "One or more edge cases fail.", points: 0 },
          ],
        },
      ],
    },
  ],
};

function stubLesson(
  id: string,
  title: string,
  objective: string,
  order: number,
  estimatedMinutes: number
): LessonNode {
  return { id, type: "lesson", title, objective, order, estimatedMinutes, blocks: [] };
}

export const seedCourse: CourseDocument = {
  id: "course-usaco-silver",
  title: "USACO Silver Bootcamp",
  description:
    "A five-week training camp taking competitors from Bronze fundamentals to confident Silver-level problem solving.",
  audience: "Competitive programming students who have passed USACO Bronze.",
  level: "intermediate",
  theme: {
    name: "Studio Violet",
    accent: "violet",
    slideDefaults: { layout: "title_bullets", themeId: "editorial-warm" },
  },
  metadata: {
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    aiReadableVersion: "1.0",
  },
  modules: [
    {
      id: "mod-week-1",
      type: "module",
      title: "Week 1: Foundations",
      description: "Complexity analysis, fast I/O, and the Silver problem-solving mindset.",
      order: 0,
      lessons: [
        stubLesson(
          "lesson-complexity",
          "Complexity & Constraints",
          "Read constraints and predict the required time complexity before coding.",
          0,
          35
        ),
        stubLesson(
          "lesson-fast-io",
          "Fast I/O & Templates",
          "Set up a contest template with fast input handling in C++ and Python.",
          1,
          25
        ),
      ],
    },
    {
      id: "mod-week-2",
      type: "module",
      title: "Week 2: Data Structures",
      description: "Prefix sums, maps and sets, and choosing the right container.",
      order: 1,
      lessons: [
        stubLesson(
          "lesson-prefix-sums",
          "Prefix Sums",
          "Answer range-sum queries in O(1) after linear preprocessing.",
          0,
          40
        ),
        stubLesson(
          "lesson-maps-sets",
          "Maps & Sets",
          "Use ordered and unordered containers to count, dedupe, and look up in O(log n) or O(1).",
          1,
          40
        ),
      ],
    },
    {
      id: "mod-week-3",
      type: "module",
      title: "Week 3: Sorting & Searching",
      description: "Custom sorts, binary search on answers, and greedy orderings.",
      order: 2,
      lessons: [
        stubLesson(
          "lesson-custom-sort",
          "Sorting with Comparators",
          "Sort by custom keys and argue why a greedy ordering is safe.",
          0,
          35
        ),
        stubLesson(
          "lesson-binary-search",
          "Binary Search on the Answer",
          "Recognize monotonic feasibility and binary search over it.",
          1,
          50
        ),
      ],
    },
    {
      id: "mod-week-4",
      type: "module",
      title: "Week 4: Two Pointers",
      description: "Linear-time window and pair techniques on sorted data.",
      order: 3,
      lessons: [
        twoPointersLesson,
        stubLesson(
          "lesson-sliding-window",
          "Sliding Windows",
          "Maintain window aggregates while both endpoints move monotonically.",
          1,
          45
        ),
      ],
    },
    {
      id: "mod-week-5",
      type: "module",
      title: "Week 5: Graph Fundamentals",
      description: "Graph modeling, flood fill, and connected components.",
      order: 4,
      lessons: [
        stubLesson(
          "lesson-graph-modeling",
          "Modeling Problems as Graphs",
          "Translate grids and relationship statements into adjacency lists.",
          0,
          40
        ),
        stubLesson(
          "lesson-flood-fill",
          "Flood Fill & Components",
          "Count and label connected components with BFS/DFS.",
          1,
          45
        ),
      ],
    },
  ],
};
