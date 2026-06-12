/**
 * Human-action patch creators.
 *
 * Components call these instead of hand-building patch shapes, so the patch
 * format has exactly two producers: this file (human edits) and ai/rules.ts
 * (mock AI). Factories generate ids, so creators must only run in event
 * handlers — never render.
 */

import {
  createBlock,
  createElement,
  createExercise,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
  newId,
  reidentifySlide,
} from "./factories";
import type { CoursePatch, StyleTarget, TextTarget } from "./patches";
import { SLIDE_H } from "./slide/geometry";
import type { LayoutPlaceholder } from "./slide/layouts";
import type {
  BlockType,
  CourseDocument,
  QuestionKind,
  QuizQuestion,
  ShapeKind,
  Slide,
  SlideBackground,
  SlideElement,
  SlideElementType,
  SlideThemeId,
} from "./types";

/* ─────────────────── course / module / lesson / block ─────────────────── */

export function addModulePatch(doc: CourseDocument, title = "New module"): CoursePatch {
  return { action: "ADD_MODULE", module: createModule(title, doc.modules.length) };
}

export function addLessonPatch(
  moduleId: string,
  lessonCount: number,
  title = "New lesson"
): CoursePatch {
  return { action: "ADD_LESSON", moduleId, lesson: createLesson(title, lessonCount) };
}

export function addBlockPatch(
  lessonId: string,
  type: BlockType,
  atIndex?: number
): CoursePatch {
  return {
    action: "ADD_BLOCK",
    lessonId,
    block: createBlock(type, atIndex ?? 0),
    atIndex,
  };
}

export function deleteBlockPatch(lessonId: string, blockId: string): CoursePatch {
  return { action: "DELETE_BLOCK", lessonId, blockId };
}

export function reorderBlockPatch(
  lessonId: string,
  blockId: string,
  toIndex: number
): CoursePatch {
  return { action: "REORDER_BLOCK", lessonId, blockId, toIndex };
}

export function updateTextPatch(target: TextTarget, value: string): CoursePatch {
  return { action: "UPDATE_TEXT", target, value };
}

export function updateBlockTitlePatch(blockId: string, title: string): CoursePatch {
  return { action: "UPDATE_BLOCK_TITLE", blockId, title };
}

export function updateStylePatch(
  target: StyleTarget,
  style: Extract<CoursePatch, { action: "UPDATE_STYLE" }>["style"]
): CoursePatch {
  return { action: "UPDATE_STYLE", target, style };
}

/* ─────────────────────────── quiz / homework ──────────────────────────── */

export function addQuestionPatch(blockId: string, kind: QuestionKind): CoursePatch {
  return { action: "ADD_QUIZ_QUESTION", blockId, question: createQuestion(kind) };
}

export function updateQuestionPatch(
  blockId: string,
  questionId: string,
  question: QuizQuestion
): CoursePatch {
  return { action: "UPDATE_QUIZ_QUESTION", blockId, questionId, question };
}

export function addExercisePatch(blockId: string, title?: string): CoursePatch {
  return { action: "ADD_HOMEWORK_EXERCISE", blockId, exercise: createExercise(title) };
}

export function changeDifficultyPatch(
  blockId: string,
  difficulty: Extract<CoursePatch, { action: "CHANGE_DIFFICULTY" }>["difficulty"],
  questionId?: string
): CoursePatch {
  return { action: "CHANGE_DIFFICULTY", blockId, questionId, difficulty };
}

/* ─────────────────────────── slide lifecycle ──────────────────────────── */

export function addSlidePatch(
  blockId: string,
  layoutId?: string,
  themeId?: SlideThemeId,
  atIndex?: number
): CoursePatch {
  return { action: "ADD_SLIDE", blockId, slide: createSlide(layoutId, themeId), atIndex };
}

export function deleteSlidePatch(blockId: string, slideId: string): CoursePatch {
  return { action: "DELETE_SLIDE", blockId, slideId };
}

export function duplicateSlidePatch(
  blockId: string,
  slide: Slide,
  atIndex?: number
): CoursePatch {
  return {
    action: "DUPLICATE_SLIDE",
    blockId,
    slideId: slide.id,
    newSlideId: newId("slide"),
    newElementIds: slide.elements.map(() => newId("el")),
    atIndex,
  };
}

/** Paste a clipboard slide: re-identified clone inserted via ADD_SLIDE. */
export function pasteSlidePatch(
  blockId: string,
  slide: Slide,
  atIndex?: number
): CoursePatch {
  return { action: "ADD_SLIDE", blockId, slide: reidentifySlide(slide), atIndex };
}

export function reorderSlidePatch(
  blockId: string,
  slideId: string,
  toIndex: number
): CoursePatch {
  return { action: "REORDER_SLIDE", blockId, slideId, toIndex };
}

/* ─────────────────────────── slide elements ───────────────────────────── */

/** Insert a specific shape with a sensible frame + style for its kind. */
export function addShapePatch(
  blockId: string,
  slideId: string,
  kind: ShapeKind | "rounded_rectangle",
  existingCount: number
): CoursePatch {
  const el = createElement("shape", existingCount);
  if (el.type !== "shape") throw new Error("unreachable");
  const shape: ShapeKind = kind === "rounded_rectangle" ? "rectangle" : kind;
  const horizontal = { x1: 0, y1: 0.5, x2: 1, y2: 0.5 };
  const overrides: Partial<typeof el> =
    kind === "line"
      ? { width: 360, height: 24, style: {}, points: horizontal }
      : kind === "arrow"
        ? { width: 320, height: 64, style: {}, points: horizontal }
        : kind === "rounded_rectangle"
          ? { style: { ...el.style, borderRadius: 24 } }
          : kind === "rectangle"
            ? { style: { ...el.style, borderRadius: 0 } }
            : kind === "triangle"
              ? { width: 240, height: 200 }
              : { width: 220, height: 220 }; // ellipse → circle-ish
  return {
    action: "ADD_SLIDE_ELEMENT",
    blockId,
    slideId,
    element: { ...el, ...overrides, shape },
  };
}

export function addElementPatch(
  blockId: string,
  slideId: string,
  type: SlideElementType,
  existingCount: number
): CoursePatch {
  return {
    action: "ADD_SLIDE_ELEMENT",
    blockId,
    slideId,
    element: createElement(type, existingCount),
  };
}

export function updateElementPatch(
  blockId: string,
  slideId: string,
  elementId: string,
  updates: Extract<CoursePatch, { action: "UPDATE_SLIDE_ELEMENT" }>["updates"]
): CoursePatch {
  return { action: "UPDATE_SLIDE_ELEMENT", blockId, slideId, elementId, updates };
}

/**
 * Commit a text edit with Google-Slides auto-grow: the content update plus,
 * when the measured content is taller than the box, a grow-only resize
 * (capped at the slide's bottom edge so the box never shifts upward).
 * Apply via applyMany — text + height land as ONE undo step.
 */
export function commitElementTextPatches(
  blockId: string,
  slideId: string,
  el: SlideElement,
  updates: Extract<CoursePatch, { action: "UPDATE_SLIDE_ELEMENT" }>["updates"],
  measuredHeight?: number
): CoursePatch[] {
  const patches = [updateElementPatch(blockId, slideId, el.id, updates)];
  if (measuredHeight !== undefined) {
    const target = Math.min(Math.ceil(measuredHeight), SLIDE_H - el.y);
    if (target > el.height) {
      patches.push(
        resizeElementPatch(blockId, slideId, el.id, {
          x: el.x,
          y: el.y,
          width: el.width,
          height: target,
        })
      );
    }
  }
  return patches;
}

export function deleteElementPatch(
  blockId: string,
  slideId: string,
  elementId: string
): CoursePatch {
  return { action: "DELETE_SLIDE_ELEMENT", blockId, slideId, elementId };
}

export function duplicateElementPatch(
  blockId: string,
  slideId: string,
  elementId: string
): CoursePatch {
  return {
    action: "DUPLICATE_SLIDE_ELEMENT",
    blockId,
    slideId,
    elementId,
    newElementId: newId("el"),
  };
}

/** Fresh ids for every group id appearing in the elements' paths, so clones
 *  form their own groups instead of silently joining the originals. */
function remapGroupIds(elements: SlideElement[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const el of elements) {
    for (const gid of el.groupPath ?? []) {
      if (!map[gid]) map[gid] = newId("grp");
    }
  }
  return map;
}

/**
 * Paste clipboard elements: fresh element ids, group ids remapped (groups
 * paste as groups). Placement (Google Slides): same slide → +24/+24 offset;
 * different slide → in place; explicit point (context-menu paste) → the
 * clipboard's bounding box centers on it. Reducer clamps to the canvas.
 */
export function pasteElementsPatches(
  blockId: string,
  slideId: string,
  clipboard: SlideElement[],
  placement: { sameSlide: boolean; at?: { x: number; y: number } }
): CoursePatch[] {
  let dx = placement.sameSlide ? 24 : 0;
  let dy = dx;
  if (placement.at) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of clipboard) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }
    dx = Math.round(placement.at.x - (minX + maxX) / 2);
    dy = Math.round(placement.at.y - (minY + maxY) / 2);
  }
  const groupIdMap = remapGroupIds(clipboard);
  return clipboard.map((el) => {
    const clone = structuredClone(el);
    clone.id = newId("el");
    if (clone.groupPath) clone.groupPath = clone.groupPath.map((gid) => groupIdMap[gid]);
    clone.x += dx;
    clone.y += dy;
    return { action: "ADD_SLIDE_ELEMENT", blockId, slideId, element: clone };
  });
}

/** Duplicate a whole selection in ONE patch (one undo): clones keep their
 *  relative arrangement and group structure via remapped group ids. */
export function duplicateElementsPatch(
  blockId: string,
  slideId: string,
  elements: SlideElement[]
): CoursePatch {
  return {
    action: "DUPLICATE_ELEMENTS",
    blockId,
    slideId,
    elementIds: elements.map((el) => el.id),
    newElementIds: elements.map(() => newId("el")),
    groupIdMap: remapGroupIds(elements),
  };
}

/** Paste plain text (from the OS clipboard) as a fresh text element. */
export function pasteTextElementPatch(
  blockId: string,
  slideId: string,
  text: string,
  existingCount: number,
  at?: { x: number; y: number }
): CoursePatch {
  const el = createElement("text", existingCount);
  if (el.type !== "text") throw new Error("unreachable");
  el.text = text;
  if (at) {
    el.x = Math.round(at.x - el.width / 2);
    el.y = Math.round(at.y - el.height / 2);
  }
  return { action: "ADD_SLIDE_ELEMENT", blockId, slideId, element: el };
}

export function groupElementsPatch(
  blockId: string,
  slideId: string,
  elementIds: string[],
  atDepth: number
): CoursePatch {
  return {
    action: "GROUP_ELEMENTS",
    blockId,
    slideId,
    elementIds,
    groupId: newId("grp"),
    atDepth,
  };
}

export function ungroupElementsPatch(
  blockId: string,
  slideId: string,
  groupId: string
): CoursePatch {
  return { action: "UNGROUP_ELEMENTS", blockId, slideId, groupId };
}

export function moveElementPatch(
  blockId: string,
  slideId: string,
  elementId: string,
  x: number,
  y: number
): CoursePatch {
  return { action: "MOVE_SLIDE_ELEMENT", blockId, slideId, elementId, x, y };
}

export function resizeElementPatch(
  blockId: string,
  slideId: string,
  elementId: string,
  frame: { x?: number; y?: number; width: number; height: number }
): CoursePatch {
  return { action: "RESIZE_SLIDE_ELEMENT", blockId, slideId, elementId, ...frame };
}

/** Reshape a line/arrow by its ABSOLUTE endpoints (one undo: the reducer
 *  derives the padded frame + frame-fraction points atomically). */
export function setLineEndpointsPatch(
  blockId: string,
  slideId: string,
  elementId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): CoursePatch {
  return { action: "SET_LINE_ENDPOINTS", blockId, slideId, elementId, x1, y1, x2, y2 };
}

export function reorderElementPatch(
  blockId: string,
  slideId: string,
  elementId: string,
  direction: "forward" | "backward" | "front" | "back"
): CoursePatch {
  return { action: "REORDER_SLIDE_ELEMENT", blockId, slideId, elementId, direction };
}

/* ─────────────────────── slide layout / visuals ───────────────────────── */

export function applyLayoutPatch(
  blockId: string,
  slideId: string,
  layoutId: string,
  preserveExistingContent: boolean,
  placeholderCount: number,
  placeholders?: LayoutPlaceholder[]
): CoursePatch {
  return {
    action: "APPLY_SLIDE_LAYOUT",
    blockId,
    slideId,
    layoutId,
    preserveExistingContent,
    placeholders,
    newElementIds: Array.from({ length: placeholderCount }, () => newId("el")),
  };
}

export function updateBackgroundPatch(
  blockId: string,
  slideId: string,
  background: SlideBackground
): CoursePatch {
  return { action: "UPDATE_SLIDE_BACKGROUND", blockId, slideId, background };
}

export function applyThemePatch(
  blockId: string,
  themeId: SlideThemeId,
  slideId?: string
): CoursePatch {
  return { action: "APPLY_SLIDE_THEME", blockId, slideId, themeId };
}

export function insertImagePatch(
  blockId: string,
  slideId: string,
  image: { src: string; alt: string; objectFit?: "cover" | "contain" },
  existingCount: number
): CoursePatch {
  const el = createElement("image", existingCount);
  if (el.type !== "image") throw new Error("unreachable");
  return {
    action: "INSERT_IMAGE",
    blockId,
    slideId,
    element: { ...el, src: image.src, alt: image.alt, objectFit: image.objectFit ?? "cover" },
  };
}

export function replaceImagePatch(
  blockId: string,
  slideId: string,
  elementId: string,
  src: string,
  alt?: string
): CoursePatch {
  return { action: "REPLACE_IMAGE", blockId, slideId, elementId, src, alt };
}

export function updateSpeakerNotesPatch(
  blockId: string,
  slideId: string,
  speakerNotes: string
): CoursePatch {
  return { action: "UPDATE_SPEAKER_NOTES", blockId, slideId, speakerNotes };
}

export function simplifySlidePatch(blockId: string, slideId: string): CoursePatch {
  return { action: "SIMPLIFY_SLIDE_DESIGN", blockId, slideId };
}

/** Convenience: a styled-element partial for toolbar/inspector style edits. */
export function styleElementPatch(
  blockId: string,
  slideId: string,
  elementId: string,
  style: NonNullable<Extract<CoursePatch, { action: "UPDATE_SLIDE_ELEMENT" }>["updates"]["style"]>
): CoursePatch {
  return updateElementPatch(blockId, slideId, elementId, { style });
}

export type { SlideElement };
