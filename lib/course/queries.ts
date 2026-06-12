/**
 * Pure lookups over a CourseDocument. No mutation, no React.
 */

import {
  componentManifest,
  manifestTypeForElement,
  type ComponentManifestEntry,
} from "./manifest";
import type {
  CourseDocument,
  CourseModule,
  LessonBlock,
  LessonNode,
  Selection,
  Slide,
  SlideDeckBlock,
  SlideElement,
} from "./types";

export function findModule(
  doc: CourseDocument,
  moduleId: string
): CourseModule | undefined {
  return doc.modules.find((m) => m.id === moduleId);
}

export function findLesson(
  doc: CourseDocument,
  lessonId: string
): { lesson: LessonNode; module: CourseModule } | undefined {
  for (const m of doc.modules) {
    const lesson = m.lessons.find((l) => l.id === lessonId);
    if (lesson) return { lesson, module: m };
  }
  return undefined;
}

export function findBlock(
  doc: CourseDocument,
  blockId: string
): { block: LessonBlock; lesson: LessonNode; module: CourseModule } | undefined {
  for (const m of doc.modules) {
    for (const l of m.lessons) {
      const block = l.blocks.find((b) => b.id === blockId);
      if (block) return { block, lesson: l, module: m };
    }
  }
  return undefined;
}

export function findSlide(
  doc: CourseDocument,
  blockId: string,
  slideId: string
): { slide: Slide; deck: SlideDeckBlock; lesson: LessonNode } | undefined {
  const hit = findBlock(doc, blockId);
  if (!hit || hit.block.type !== "slide_deck") return undefined;
  const slide = hit.block.slides.find((s) => s.id === slideId);
  return slide ? { slide, deck: hit.block, lesson: hit.lesson } : undefined;
}

export function findElement(
  doc: CourseDocument,
  blockId: string,
  slideId: string,
  elementId: string
): { element: SlideElement; slide: Slide; deck: SlideDeckBlock } | undefined {
  const hit = findSlide(doc, blockId, slideId);
  if (!hit) return undefined;
  const element = hit.slide.elements.find((el) => el.id === elementId);
  return element ? { element, slide: hit.slide, deck: hit.deck } : undefined;
}

export function firstLessonId(doc: CourseDocument): string | undefined {
  for (const m of doc.modules) {
    if (m.lessons.length > 0) return m.lessons[0].id;
  }
  return undefined;
}

export interface ResolvedSelection {
  /** Manifest type name, e.g. "lesson", "quiz", "slide". */
  typeName: string;
  manifestEntry: ComponentManifestEntry;
  /** The selected node itself (shape depends on kind). */
  node: unknown;
  /** Human title for the inspector header. */
  title: string;
  id: string;
  parentId?: string;
  order?: number;
}

/** Resolve the current selection to a node + its manifest entry, or undefined
 *  if the selection points at something that no longer exists. */
export function resolveSelection(
  doc: CourseDocument,
  sel: Selection
): ResolvedSelection | undefined {
  switch (sel.kind) {
    case "course":
      return {
        typeName: "course",
        manifestEntry: componentManifest.course,
        node: doc,
        title: doc.title,
        id: doc.id,
      };
    case "module": {
      const m = findModule(doc, sel.id);
      if (!m) return undefined;
      return {
        typeName: "module",
        manifestEntry: componentManifest.module,
        node: m,
        title: m.title,
        id: m.id,
        parentId: doc.id,
        order: m.order,
      };
    }
    case "lesson": {
      const hit = findLesson(doc, sel.id);
      if (!hit) return undefined;
      return {
        typeName: "lesson",
        manifestEntry: componentManifest.lesson,
        node: hit.lesson,
        title: hit.lesson.title,
        id: hit.lesson.id,
        parentId: hit.module.id,
        order: hit.lesson.order,
      };
    }
    case "block": {
      const hit = findBlock(doc, sel.id);
      if (!hit) return undefined;
      return {
        typeName: hit.block.type,
        manifestEntry: componentManifest[hit.block.type],
        node: hit.block,
        title: hit.block.title ?? hit.block.type,
        id: hit.block.id,
        parentId: hit.lesson.id,
        order: hit.block.order,
      };
    }
    case "slide": {
      const hit = findSlide(doc, sel.blockId, sel.id);
      if (!hit) return undefined;
      const index = hit.deck.slides.findIndex((s) => s.id === sel.id);
      return {
        typeName: "slide",
        manifestEntry: componentManifest.slide,
        node: hit.slide,
        title: hit.slide.title || `Slide ${index + 1}`,
        id: hit.slide.id,
        parentId: hit.deck.id,
        order: index,
      };
    }
    case "element": {
      const hit = findElement(doc, sel.blockId, sel.slideId, sel.id);
      if (!hit) return undefined;
      const typeName = manifestTypeForElement(hit.element);
      return {
        typeName,
        manifestEntry: componentManifest[typeName],
        node: hit.element,
        title: `${hit.element.type.replace("_", " ")} element`,
        id: hit.element.id,
        parentId: hit.slide.id,
        order: hit.element.zIndex,
      };
    }
    case "elements": {
      const hit = findSlide(doc, sel.blockId, sel.slideId);
      if (!hit) return undefined;
      const members = hit.slide.elements.filter((el) => sel.ids.includes(el.id));
      if (members.length < 2) return undefined;
      return {
        typeName: "selection",
        manifestEntry: MULTI_SELECTION_ENTRY,
        node: members,
        title: `${members.length} elements`,
        id: members.map((el) => el.id).join(", "),
        parentId: hit.slide.id,
      };
    }
  }
}

/** Synthetic manifest entry for multi-element selections (not a document
 *  component type — describes what an agent/human can do with the set). */
export const MULTI_SELECTION_ENTRY: ComponentManifestEntry = {
  description:
    "Multiple elements selected on one slide — move, arrange, align, group, or restyle them together.",
  allowedActions: [
    "MOVE_SLIDE_ELEMENT",
    "RESIZE_SLIDE_ELEMENT",
    "REORDER_SLIDE_ELEMENT",
    "UPDATE_SLIDE_ELEMENT",
    "DELETE_SLIDE_ELEMENT",
    "DUPLICATE_ELEMENTS",
    "GROUP_ELEMENTS",
    "UNGROUP_ELEMENTS",
  ],
  semanticTags: ["multi-selection"],
};
