/**
 * Factories for new course nodes.
 *
 * INVARIANT: these are only ever called from event handlers / store actions —
 * never during render — because `newId` uses crypto.randomUUID(). Seed data
 * uses hand-written ids instead, so server and client renders stay identical.
 */

import { componentManifest, defaultAIMeta, manifestTypeForElementType } from "./manifest";
import { defaultFrameFor } from "./slide/geometry";
import { elementFromPlaceholder, findLayout } from "./slide/layouts";
import { DEFAULT_STICKER_ID } from "./slide/stickers";
import { STRUCTURED_LAYOUTS, findStructuredLayout } from "./slide/structuredLayouts";
import { DEFAULT_THEME_ID, findTheme, themeRef } from "./slide/themes";
import type {
  BlockType,
  CourseModule,
  HomeworkExercise,
  LectureParagraph,
  LessonBlock,
  LessonNode,
  QuestionKind,
  QuizQuestion,
  RubricCriterion,
  RubricLevel,
  Slide,
  SlideElement,
  SlideElementType,
  SlideThemeId,
  StructuredLayoutId,
} from "./types";

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Module / lesson / block ids are FULL UUIDs because they are the primary
 * keys of the `modules` / `lessons` / `blocks` Postgres tables (persistence
 * upserts them 1:1). Elements, slides, questions, etc. live inside a block's
 * `content` jsonb, so they keep the short prefixed `newId` form.
 */
export function newRowId(): string {
  return crypto.randomUUID();
}

export function createModule(title = "New module", order = 0): CourseModule {
  return { id: newRowId(), type: "module", title, order, lessons: [] };
}

export function createLesson(title = "New lesson", order = 0): LessonNode {
  return { id: newRowId(), type: "lesson", title, order, blocks: [] };
}

/* ───────────────────────────── Slides ─────────────────────────────────── */

/** A fresh element with sensible frame + content defaults. zIndex is set by
 *  the ADD_SLIDE_ELEMENT reducer (stacked on top). */
export function createElement(
  type: SlideElementType,
  existingCount: number
): SlideElement {
  const frame = defaultFrameFor(type, existingCount);
  const base = {
    id: newId("el"),
    ...frame,
    zIndex: 0,
    style: {},
    ai: defaultAIMeta(manifestTypeForElementType(type)),
  };
  switch (type) {
    case "heading":
      return { ...base, type, text: "Heading" };
    case "text":
      return { ...base, type, text: "Write something…" };
    case "bullet_list":
      return { ...base, type, items: ["First point"] };
    case "code_block":
      return { ...base, type, code: "// code", language: "cpp" };
    case "image":
      return { ...base, type, src: "", alt: "", objectFit: "cover" };
    case "shape":
      return {
        ...base,
        type,
        shape: "rectangle",
        style: { backgroundColor: "#ede9fe", borderRadius: 16 },
      };
    case "callout":
      return { ...base, type, text: "Key point", variant: "tip" };
    case "divider":
      return { ...base, type, orientation: "horizontal" };
    case "table":
      return {
        ...base,
        type,
        rows: [
          ["Column A", "Column B"],
          ["—", "—"],
        ],
        headerRow: true,
      };
    case "sticker":
      return { ...base, type, stickerId: DEFAULT_STICKER_ID };
  }
}

/** A fresh slide built from a layout's placeholders, themed to the deck. */
export function createSlide(
  layoutId = "title_bullets",
  themeId: SlideThemeId = DEFAULT_THEME_ID
): Slide {
  const layout = findLayout(layoutId) ?? findLayout("title_bullets")!;
  const theme = findTheme(themeId);
  return {
    id: newId("slide"),
    type: "slide",
    layout: layout.id,
    style: {
      background: structuredClone(theme.defaultBackground),
      theme: themeRef(theme),
    },
    elements: layout.placeholders.map((p, i) =>
      elementFromPlaceholder(p, newId("el"), i)
    ),
    order: 0,
    ai: {
      formattingRules: layout.ai.qualityRules,
      qualityChecks: ["has heading", "readable contrast", "alt text on images"],
      allowedActions: [...componentManifest.slide.allowedActions],
    },
  };
}

/** A fresh renderer-owned STRUCTURED slide, seeded with the layout's example
 *  content (the manual picker applies this; the AI fills its own content). */
export function createStructuredSlide(
  layoutId: StructuredLayoutId,
  themeId: SlideThemeId = DEFAULT_THEME_ID
): Slide {
  const def = findStructuredLayout(layoutId) ?? STRUCTURED_LAYOUTS[0];
  const theme = findTheme(themeId);
  const template = def.seed();
  return {
    id: newId("slide"),
    type: "slide",
    layout: template.layoutId,
    style: {
      background: structuredClone(theme.defaultBackground),
      theme: themeRef(theme),
    },
    elements: [],
    template,
    order: 0,
    ai: {
      formattingRules: [],
      qualityChecks: ["tight copy", "icons clarify, not clutter"],
      allowedActions: [...componentManifest.slide.allowedActions],
    },
  };
}

/** Deep-clone a slide with fresh ids (for paste-from-clipboard). */
export function reidentifySlide(slide: Slide): Slide {
  const clone = structuredClone(slide);
  clone.id = newId("slide");
  clone.elements.forEach((el) => {
    el.id = newId("el");
  });
  return clone;
}

/* ─────────────────────────── Other blocks ─────────────────────────────── */

export function createParagraph(
  text = "",
  kind: LectureParagraph["kind"] = "paragraph"
): LectureParagraph {
  return { id: newId("para"), kind, text };
}

export function createQuestion(kind: QuestionKind): QuizQuestion {
  const base = {
    id: newId("q"),
    prompt: "New question",
  };
  switch (kind) {
    case "multiple_choice":
      return {
        ...base,
        kind,
        choices: [
          { id: newId("c"), text: "Option A" },
          { id: newId("c"), text: "Option B" },
          { id: newId("c"), text: "Option C" },
        ],
        correctChoiceId: "",
      };
    case "multi_select":
      return {
        ...base,
        kind,
        choices: [
          { id: newId("c"), text: "Option A" },
          { id: newId("c"), text: "Option B" },
          { id: newId("c"), text: "Option C" },
        ],
        correctChoiceIds: [],
      };
    case "true_false":
      return { ...base, kind, correctAnswer: true };
    case "short_answer":
      return { ...base, kind, expectedAnswer: "" };
  }
}

export function createExercise(title = "New exercise"): HomeworkExercise {
  return { id: newId("ex"), title, prompt: "" };
}

export function createRubricLevel(label = "New level"): RubricLevel {
  return { id: newId("lvl"), label };
}

/** A fresh rubric criterion with a sensible qualitative ladder. */
export function createRubricCriterion(name = "New criterion"): RubricCriterion {
  return {
    id: newId("rub"),
    name,
    levels: [
      { id: newId("lvl"), label: "Strong" },
      { id: newId("lvl"), label: "Developing" },
      { id: newId("lvl"), label: "Needs work" },
    ],
  };
}

const blockTitles: Record<BlockType, string> = {
  slide_deck: "Slide deck",
  lecture_text: "Lecture",
  quiz: "Knowledge check",
  homework: "Practice exercise",
  exercise: "Exercise",
  example: "Worked example",
  resource: "Resources",
};

/**
 * Create a fresh block. `opts.emptySlideDeck` makes a slide_deck with NO slides —
 * the AI path uses this so an agent-authored deck never starts with the default
 * "Section title" placeholder slide (the human AddBlockMenu keeps the starter so
 * a person has a slide to edit). See lib/ai/slideDiagnostics for the detector
 * that catches a placeholder if one ever does slip through.
 */
export function createBlock(
  type: BlockType,
  order = 0,
  opts?: { emptySlideDeck?: boolean }
): LessonBlock {
  const base = {
    id: newRowId(),
    title: blockTitles[type],
    order,
    ai: defaultAIMeta(type),
  };
  switch (type) {
    case "slide_deck":
      return { ...base, type, slides: opts?.emptySlideDeck ? [] : [createSlide("title")] };
    case "lecture_text":
      return { ...base, type, tone: "beginner", paragraphs: [createParagraph()] };
    case "quiz":
      return { ...base, type, questions: [] };
    case "homework":
      return {
        ...base,
        type,
        instructions: "",
        deliverableType: "none",
        exercises: [],
      };
    case "exercise":
      return { ...base, type, prompt: "" };
    case "example":
      return { ...base, type, context: "", explanation: "", steps: [], takeaway: "" };
    case "resource":
      return { ...base, type, links: [] };
  }
}

export { componentManifest };
