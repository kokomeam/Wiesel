/**
 * Machine-readable component manifest.
 *
 * The single registry AI agents read to learn what component types exist,
 * what each is for, what children it may contain, and which patch actions
 * may target it. Exposed three ways:
 *   1. this TypeScript object (frontend)
 *   2. GET /api/ai/component-manifest (JSON)
 *   3. the "AI Structure" panel in the editor inspector
 */

import type { AIMeta, BlockType, SlideElement, SlideElementType } from "./types";

export interface ComponentManifestEntry {
  /** Plain-language description an agent can reason about. */
  description: string;
  /** Component types allowed as direct children, if any. */
  allowedChildren?: string[];
  /** Patch-action names that may target this component (see patches.ts). */
  allowedActions: string[];
  /** Default semantic tags stamped onto new instances. */
  semanticTags: string[];
}

export type ComponentTypeName =
  | "course"
  | "module"
  | "lesson"
  | "slide"
  | "slide_element"
  | "image_element"
  | "callout_element"
  | "sticker_element"
  | "quiz_question"
  | "rubric_criterion"
  | BlockType;

/** Manifest type for a slide element — images and callouts get their own
 *  richer manifest entries; everything else shares slide_element. */
export function manifestTypeForElementType(type: SlideElementType): ComponentTypeName {
  if (type === "image") return "image_element";
  if (type === "callout") return "callout_element";
  if (type === "sticker") return "sticker_element";
  return "slide_element";
}

export function manifestTypeForElement(el: SlideElement): ComponentTypeName {
  return manifestTypeForElementType(el.type);
}

export const componentManifest: Record<ComponentTypeName, ComponentManifestEntry> = {
  course: {
    description:
      "The root course document: ordered modules plus theme and metadata.",
    allowedChildren: ["module"],
    allowedActions: ["ADD_MODULE", "DELETE_MODULE", "REORDER_MODULE", "UPDATE_TEXT", "UPDATE_PLAN"],
    semanticTags: ["course"],
  },
  module: {
    description:
      "A themed unit of the course (e.g. a week) containing ordered lessons.",
    allowedChildren: ["lesson"],
    allowedActions: ["ADD_LESSON", "DELETE_LESSON", "DELETE_MODULE", "REORDER_MODULE", "REORDER_LESSON", "UPDATE_TEXT"],
    semanticTags: ["module", "unit"],
  },
  lesson: {
    description:
      "A teachable unit containing slides, lecture text, quizzes, and exercises.",
    allowedChildren: [
      "slide_deck",
      "lecture_text",
      "quiz",
      "homework",
      "exercise",
      "example",
      "resource",
    ],
    allowedActions: ["ADD_BLOCK", "DELETE_LESSON", "REORDER_LESSON", "REORDER_BLOCK", "UPDATE_TEXT"],
    semanticTags: ["lesson", "teachable-unit"],
  },
  slide_deck: {
    description: "A collection of presentation slides for teaching a lesson.",
    allowedChildren: ["slide"],
    allowedActions: [
      "ADD_SLIDE",
      "DELETE_SLIDE",
      "DUPLICATE_SLIDE",
      "REORDER_SLIDE",
      "APPLY_SLIDE_THEME",
      "UPDATE_BLOCK_TITLE",
      "REORDER_BLOCK",
      "DELETE_BLOCK",
    ],
    semanticTags: ["presentation", "visual-teaching"],
  },
  slide: {
    description:
      "A visual teaching canvas (1280×720) containing positioned, editable layout elements and speaker notes.",
    allowedChildren: ["slide_element", "image_element", "callout_element", "sticker_element"],
    allowedActions: [
      "ADD_SLIDE_ELEMENT",
      "UPDATE_SLIDE_ELEMENT",
      "DELETE_SLIDE_ELEMENT",
      "DUPLICATE_SLIDE_ELEMENT",
      "DUPLICATE_ELEMENTS",
      "GROUP_ELEMENTS",
      "UNGROUP_ELEMENTS",
      "MOVE_SLIDE_ELEMENT",
      "RESIZE_SLIDE_ELEMENT",
      "SET_LINE_ENDPOINTS",
      "REORDER_SLIDE_ELEMENT",
      "APPLY_SLIDE_LAYOUT",
      "SET_SLIDE_TEMPLATE",
      "UPDATE_TEMPLATE_CONTENT",
      "UPDATE_SLIDE_BACKGROUND",
      "APPLY_SLIDE_THEME",
      "INSERT_IMAGE",
      "UPDATE_SPEAKER_NOTES",
      "SIMPLIFY_SLIDE_DESIGN",
      "UPDATE_TEXT",
      "DELETE_SLIDE",
      "DUPLICATE_SLIDE",
      "REORDER_SLIDE",
    ],
    semanticTags: ["slide", "visual", "canvas"],
  },
  slide_element: {
    description:
      "A positioned element on a slide canvas: text, heading, bullet list, code, shape, divider, or table.",
    allowedActions: [
      "UPDATE_SLIDE_ELEMENT",
      "MOVE_SLIDE_ELEMENT",
      "RESIZE_SLIDE_ELEMENT",
      "SET_LINE_ENDPOINTS",
      "REORDER_SLIDE_ELEMENT",
      "DUPLICATE_SLIDE_ELEMENT",
      "DUPLICATE_ELEMENTS",
      "GROUP_ELEMENTS",
      "UNGROUP_ELEMENTS",
      "DELETE_SLIDE_ELEMENT",
    ],
    semanticTags: ["slide-element", "visual"],
  },
  image_element: {
    description:
      "An image placed on a slide with alt text, sizing, crop, and object fit.",
    allowedActions: [
      "REPLACE_IMAGE",
      "GENERATE_ALT_TEXT",
      "UPDATE_SLIDE_ELEMENT",
      "MOVE_SLIDE_ELEMENT",
      "RESIZE_SLIDE_ELEMENT",
      "REORDER_SLIDE_ELEMENT",
      "DUPLICATE_SLIDE_ELEMENT",
      "DELETE_SLIDE_ELEMENT",
    ],
    semanticTags: ["image", "visual", "accessibility"],
  },
  callout_element: {
    description:
      "A highlighted visual note used to emphasize definitions, warnings, or key insights.",
    allowedActions: [
      "UPDATE_SLIDE_ELEMENT",
      "MOVE_SLIDE_ELEMENT",
      "RESIZE_SLIDE_ELEMENT",
      "REORDER_SLIDE_ELEMENT",
      "DUPLICATE_SLIDE_ELEMENT",
      "DELETE_SLIDE_ELEMENT",
    ],
    semanticTags: ["callout", "emphasis"],
  },
  sticker_element: {
    description:
      "An inline icon primitive (lucide glyph) referenced by id from the shared sticker registry, themed to the slide accent. Use to clarify a point — never decorative clutter. Set its icon via UPDATE_SLIDE_ELEMENT { stickerId }.",
    allowedActions: [
      "UPDATE_SLIDE_ELEMENT",
      "MOVE_SLIDE_ELEMENT",
      "RESIZE_SLIDE_ELEMENT",
      "REORDER_SLIDE_ELEMENT",
      "DUPLICATE_SLIDE_ELEMENT",
      "DELETE_SLIDE_ELEMENT",
    ],
    semanticTags: ["sticker", "icon", "visual"],
  },
  lecture_text: {
    description:
      "Structured written lecture content with an adjustable teaching tone.",
    allowedActions: [
      "UPDATE_TEXT",
      "UPDATE_BLOCK_TITLE",
      "UPDATE_STYLE",
      "REORDER_BLOCK",
      "DELETE_BLOCK",
    ],
    semanticTags: ["reading", "explanation"],
  },
  quiz: {
    description:
      "Low-stakes knowledge check: a few questions that confirm understanding with instant feedback and a short explanation. No scores, passing marks, timers, or attempt caps.",
    allowedChildren: ["quiz_question"],
    allowedActions: [
      "ADD_QUIZ_QUESTION",
      "UPDATE_QUIZ_QUESTION",
      "DELETE_QUIZ_QUESTION",
      "REORDER_QUIZ_QUESTION",
      "UPDATE_QUIZ_SETTINGS",
      "GENERATE_EXPLANATION",
      "UPDATE_BLOCK_TITLE",
      "REORDER_BLOCK",
      "DELETE_BLOCK",
    ],
    semanticTags: ["assessment", "knowledge-check", "low-stakes"],
  },
  quiz_question: {
    description:
      "One knowledge-check question: multiple choice, multiple select, true/false, or short answer, with an explanation shown as instant feedback. No points or difficulty.",
    allowedActions: [
      "UPDATE_QUIZ_QUESTION",
      "DELETE_QUIZ_QUESTION",
      "REORDER_QUIZ_QUESTION",
      "GENERATE_EXPLANATION",
    ],
    semanticTags: ["question", "assessment"],
  },
  homework: {
    description:
      "Practice assignment with instructions, a deliverable type, exercises, and an optional qualitative rubric. Practice only — no points or due dates.",
    allowedChildren: ["exercise", "rubric_criterion"],
    allowedActions: [
      "ADD_HOMEWORK_EXERCISE",
      "DELETE_HOMEWORK_EXERCISE",
      "REORDER_HOMEWORK_EXERCISE",
      "UPDATE_HOMEWORK_META",
      "SET_RUBRIC",
      "ADD_RUBRIC_CRITERION",
      "UPDATE_RUBRIC_CRITERION",
      "DELETE_RUBRIC_CRITERION",
      "REORDER_RUBRIC_CRITERION",
      "UPDATE_TEXT",
      "UPDATE_BLOCK_TITLE",
      "REORDER_BLOCK",
      "DELETE_BLOCK",
    ],
    semanticTags: ["practice", "assignment"],
  },
  rubric_criterion: {
    description:
      "One rubric criterion with ordered qualitative performance levels (label + description) that guide feedback and self-checking on a homework deliverable. No points.",
    allowedActions: [
      "UPDATE_RUBRIC_CRITERION",
      "DELETE_RUBRIC_CRITERION",
      "REORDER_RUBRIC_CRITERION",
    ],
    semanticTags: ["rubric", "feedback"],
  },
  exercise: {
    description: "A single standalone practice exercise with optional hint and solution.",
    allowedActions: ["UPDATE_TEXT", "UPDATE_BLOCK_TITLE", "REORDER_BLOCK", "DELETE_BLOCK"],
    semanticTags: ["practice"],
  },
  example: {
    description:
      "A worked, real-world example: context, explanation, steps, takeaway.",
    allowedActions: ["UPDATE_TEXT", "UPDATE_BLOCK_TITLE", "REORDER_BLOCK", "DELETE_BLOCK"],
    semanticTags: ["worked-example", "concrete"],
  },
  resource: {
    description: "External links and references supporting the lesson.",
    allowedActions: ["UPDATE_TEXT", "UPDATE_BLOCK_TITLE", "REORDER_BLOCK", "DELETE_BLOCK"],
    semanticTags: ["reference", "external"],
  },
};

/** Default `ai` envelope for a freshly created node of the given type. */
export function defaultAIMeta(type: ComponentTypeName, purpose?: string): AIMeta {
  const entry = componentManifest[type];
  return {
    purpose: purpose ?? entry.description,
    editable: true,
    allowedActions: [...entry.allowedActions],
    semanticTags: [...entry.semanticTags],
  };
}
