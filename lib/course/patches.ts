/**
 * The AI patch system — the ONLY way the course document changes.
 *
 * Both human edits (via commands.ts) and AI commands (via ai/mockClient.ts)
 * produce CoursePatch objects. Every patch is validated against
 * CoursePatchSchema before `applyCoursePatch` runs, so an AI can never
 * mutate arbitrary state. The schema is the source of truth for the patch
 * type (`CoursePatch = z.infer<...>`).
 *
 * Responsibility split:
 *   UPDATE_TEXT            — plain-text fields, addressed by TextTarget
 *   UPDATE_SLIDE_ELEMENT   — element content + per-element style
 *   MOVE/RESIZE/REORDER_…  — element geometry and stacking
 *   UPDATE_SLIDE_BACKGROUND / APPLY_SLIDE_THEME — slide-level visuals
 *   UPDATE_STYLE           — lecture tone (block-level knob)
 *
 * Payloads carry ids (producers generate them via factories.ts) so
 * `applyCoursePatch` stays pure and deterministic: (doc, patch, nowIso) → doc.
 * Custom layouts travel INSIDE the patch as inline placeholders — the
 * reducer never reads browser state.
 */

import { z } from "zod";
import {
  CalloutVariantSchema,
  CourseModuleSchema,
  ElementStyleSchema,
  HomeworkExerciseSchema,
  ImageElementSchema,
  LayoutPlaceholderSchema,
  LessonBlockSchema,
  LessonNodeSchema,
  LectureToneSchema,
  QuizQuestionSchema,
  QuizSettingsSchema,
  RubricCriterionSchema,
  ShapeKindSchema,
  SlideBackgroundSchema,
  SlideElementSchema,
  SlideListContentSchema,
  SlideSchema,
  SlideTemplateSchema,
  SlideThemeIdSchema,
  TextRunSchema,
} from "./schemas";
import { findBlock, findLesson, findModule } from "./queries";
import { degenerateGroupIds } from "./slide/groups";
import { flattenToItems } from "./slide/list";
import { clampFrame, SLIDE_H, SLIDE_W, topZ } from "./slide/geometry";
import { applyLayoutToSlide, findLayout } from "./slide/layouts";
import { simplifySlideDesign } from "./slide/simplify";
import { findTheme, themeRef } from "./slide/themes";
import type {
  CourseDocument,
  ImportedDeckBlock,
  LessonBlock,
  Slide,
  SlideDeckBlock,
  SlideElement,
  VideoLessonBlock,
} from "./types";

/* ───────────────────────────── Targets ────────────────────────────────── */

/** Addresses any plain-text field in the document with one action. */
export const TextTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("course"),
    field: z.enum(["title", "description", "audience"]),
  }),
  z.object({
    kind: z.literal("module"),
    id: z.string(),
    field: z.enum(["title", "description"]),
  }),
  z.object({
    kind: z.literal("lesson"),
    id: z.string(),
    field: z.enum(["title", "objective"]),
  }),
  z.object({
    kind: z.literal("slide"),
    blockId: z.string(),
    slideId: z.string(),
    field: z.enum(["title"]),
  }),
  z.object({
    kind: z.literal("block_field"),
    blockId: z.string(),
    /** Block-type-specific field name, e.g. "paragraph_text", "instructions",
     *  "exercise_prompt", "context", "step". */
    field: z.string(),
    /** Child item id (paragraph/exercise id) or stringified index (steps). */
    itemId: z.string().optional(),
  }),
]);
export type TextTarget = z.infer<typeof TextTargetSchema>;

export const StyleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("block"), blockId: z.string() }),
]);
export type StyleTarget = z.infer<typeof StyleTargetSchema>;

const slideTarget = { blockId: z.string(), slideId: z.string() };

/** Content keys an UPDATE_SLIDE_ELEMENT may touch, gated per type in apply. */
const ElementUpdatesSchema = z
  .object({
    text: z.string(),
    runs: z.array(TextRunSchema),
    items: z.array(z.string()),
    list: SlideListContentSchema,
    code: z.string(),
    language: z.string(),
    src: z.string(),
    alt: z.string(),
    objectFit: z.enum(["cover", "contain"]),
    caption: z.string(),
    attribution: z.string(),
    shape: ShapeKindSchema,
    variant: CalloutVariantSchema,
    orientation: z.enum(["horizontal", "vertical"]),
    rows: z.array(z.array(z.string())),
    headerRow: z.boolean(),
    stickerId: z.string(),
    locked: z.boolean(),
    visible: z.boolean(),
    style: ElementStyleSchema,
  })
  .partial();

/* ───────────────────────────── Patches ────────────────────────────────── */

export const CoursePatchSchema = z.discriminatedUnion("action", [
  /* ── course / module / lesson / block (unchanged from V1) ── */
  z.object({
    action: z.literal("ADD_MODULE"),
    module: CourseModuleSchema,
    atIndex: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("ADD_LESSON"),
    moduleId: z.string(),
    lesson: LessonNodeSchema,
    atIndex: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("DELETE_MODULE"),
    moduleId: z.string(),
  }),
  z.object({
    action: z.literal("DELETE_LESSON"),
    lessonId: z.string(),
  }),
  z.object({
    action: z.literal("REORDER_MODULE"),
    moduleId: z.string(),
    toIndex: z.number().int(),
  }),
  z.object({
    action: z.literal("REORDER_LESSON"),
    lessonId: z.string(),
    toModuleId: z.string().optional(),
    toIndex: z.number().int(),
  }),
  z.object({
    action: z.literal("REORDER_BLOCK"),
    lessonId: z.string(),
    blockId: z.string(),
    toIndex: z.number().int(),
  }),
  z.object({
    action: z.literal("ADD_BLOCK"),
    lessonId: z.string(),
    block: LessonBlockSchema,
    atIndex: z.number().int().optional(),
  }),
  z.object({
    // Replace an existing block's whole content with a new, schema-valid block
    // (id + order preserved). The primitive content-writer tools use this to
    // commit a fully-authored slide deck / quiz / homework / lecture in one
    // validated patch — the clean "write a whole block" op.
    action: z.literal("SET_BLOCK_CONTENT"),
    blockId: z.string(),
    block: LessonBlockSchema,
  }),
  z.object({
    action: z.literal("DELETE_BLOCK"),
    lessonId: z.string(),
    blockId: z.string(),
  }),
  z.object({
    // Patch an imported-deck block's denormalized snapshot (status / pageCount /
    // error / title …). Used as the worker's status flows back to the editor and
    // by retry/replace; never touches storage (that's the deck_imports row).
    action: z.literal("UPDATE_IMPORTED_DECK"),
    blockId: z.string(),
    patch: z.object({
      title: z.string().optional(),
      deckImportId: z.string().optional(),
      sourceType: z.enum(["upload", "google_drive", "onedrive"]).optional(),
      originalFileName: z.string().optional(),
      originalMimeType: z.string().optional(),
      originalFileSize: z.number().int().nonnegative().optional(),
      status: z.enum(["uploaded", "processing", "ready", "failed"]).optional(),
      pageCount: z.number().int().nonnegative().nullable().optional(),
      error: z.string().nullable().optional(),
      updatedAt: z.string().optional(),
    }),
  }),
  z.object({
    // Patch a video block: the denormalized asset snapshot (status flows back
    // from Mux via polling/webhook), the recording config, the trim edit, the
    // description, and the playback settings. Each field is optional so a caller
    // updates exactly what changed. Never stores raw bytes (Mux hosts them).
    action: z.literal("UPDATE_VIDEO_LESSON"),
    blockId: z.string(),
    patch: z.object({
      description: z.string().nullable().optional(),
      asset: z
        .object({
          provider: z.literal("mux").optional(),
          status: z.enum(["empty", "uploading", "processing", "ready", "failed"]).optional(),
          videoAssetId: z.string().nullable().optional(),
          uploadId: z.string().nullable().optional(),
          assetId: z.string().nullable().optional(),
          playbackId: z.string().nullable().optional(),
          durationSeconds: z.number().nonnegative().nullable().optional(),
          aspectRatio: z.string().nullable().optional(),
          thumbnailUrl: z.string().nullable().optional(),
          createdAt: z.string().nullable().optional(),
          updatedAt: z.string().nullable().optional(),
          errorMessage: z.string().nullable().optional(),
        })
        .optional(),
      recording: z
        .object({
          mode: z.enum(["screen_camera", "camera_only", "screen_only"]).nullable().optional(),
          layout: z
            .enum(["screen_with_camera_bubble", "camera_full", "screen_full"])
            .nullable()
            .optional(),
          cameraBubblePosition: z
            .enum(["bottom-right", "bottom-left", "top-right", "top-left"])
            .nullable()
            .optional(),
          includeMic: z.boolean().nullable().optional(),
        })
        .optional(),
      edit: z
        .object({
          trimStartSeconds: z.number().nonnegative().nullable().optional(),
          trimEndSeconds: z.number().nonnegative().nullable().optional(),
        })
        .optional(),
      settings: z
        .object({
          showControls: z.boolean().optional(),
          allowDownload: z.boolean().optional(),
          showTranscript: z.boolean().optional(),
          showChapters: z.boolean().optional(),
        })
        .optional(),
      captions: z
        .object({
          status: z.enum(["none", "generating", "ready", "failed"]).optional(),
          trackId: z.string().nullable().optional(),
          trackName: z.string().nullable().optional(),
          languageCode: z.string().nullable().optional(),
          source: z.enum(["generated", "uploaded"]).nullable().optional(),
          error: z.string().nullable().optional(),
          updatedAt: z.string().nullable().optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    action: z.literal("UPDATE_TEXT"),
    target: TextTargetSchema,
    value: z.string(),
  }),
  z.object({
    action: z.literal("UPDATE_BLOCK_TITLE"),
    blockId: z.string(),
    title: z.string(),
  }),
  z.object({
    action: z.literal("UPDATE_STYLE"),
    target: StyleTargetSchema,
    style: z.object({ tone: LectureToneSchema.optional() }),
  }),
  z.object({
    action: z.literal("UPDATE_PLAN"),
    level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    plan: z
      .object({
        category: z.string().optional(),
        outcomes: z.array(z.string()).optional(),
        prerequisites: z.array(z.string()).optional(),
        teachingStyle: z.string().optional(),
      })
      .optional(),
  }),

  /* ── quiz / homework (unchanged from V1) ── */
  z.object({
    action: z.literal("ADD_QUIZ_QUESTION"),
    blockId: z.string(),
    question: QuizQuestionSchema,
    atIndex: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("UPDATE_QUIZ_QUESTION"),
    blockId: z.string(),
    questionId: z.string(),
    question: QuizQuestionSchema,
  }),
  z.object({
    action: z.literal("ADD_HOMEWORK_EXERCISE"),
    blockId: z.string(),
    exercise: HomeworkExerciseSchema,
    atIndex: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("GENERATE_EXPLANATION"),
    blockId: z.string(),
    questionId: z.string(),
    explanation: z.string(),
  }),

  /* ── quiz / homework (assessment enhancements) ── */
  z.object({
    action: z.literal("UPDATE_QUIZ_SETTINGS"),
    blockId: z.string(),
    /** Merged over the existing settings (partial update). */
    settings: QuizSettingsSchema,
  }),
  z.object({
    action: z.literal("DELETE_QUIZ_QUESTION"),
    blockId: z.string(),
    questionId: z.string(),
  }),
  z.object({
    action: z.literal("REORDER_QUIZ_QUESTION"),
    blockId: z.string(),
    questionId: z.string(),
    toIndex: z.number().int(),
  }),
  z.object({
    action: z.literal("UPDATE_HOMEWORK_META"),
    blockId: z.string(),
    /** Only the provided keys are written. */
    meta: z.object({
      deliverableType: z
        .enum(["none", "text_response", "file_upload", "external_link"])
        .optional(),
      estimatedMinutes: z.number().min(0).optional(),
      objectiveId: z.string().optional(),
    }),
  }),
  z.object({
    action: z.literal("DELETE_HOMEWORK_EXERCISE"),
    blockId: z.string(),
    exerciseId: z.string(),
  }),
  z.object({
    action: z.literal("REORDER_HOMEWORK_EXERCISE"),
    blockId: z.string(),
    exerciseId: z.string(),
    toIndex: z.number().int(),
  }),
  z.object({
    action: z.literal("SET_RUBRIC"),
    blockId: z.string(),
    rubric: z.array(RubricCriterionSchema),
  }),
  z.object({
    action: z.literal("ADD_RUBRIC_CRITERION"),
    blockId: z.string(),
    criterion: RubricCriterionSchema,
    atIndex: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("UPDATE_RUBRIC_CRITERION"),
    blockId: z.string(),
    criterionId: z.string(),
    criterion: RubricCriterionSchema,
  }),
  z.object({
    action: z.literal("DELETE_RUBRIC_CRITERION"),
    blockId: z.string(),
    criterionId: z.string(),
  }),
  z.object({
    action: z.literal("REORDER_RUBRIC_CRITERION"),
    blockId: z.string(),
    criterionId: z.string(),
    toIndex: z.number().int(),
  }),

  /* ── slide lifecycle ── */
  z.object({
    action: z.literal("ADD_SLIDE"),
    blockId: z.string(),
    slide: SlideSchema,
    atIndex: z.number().int().optional(),
  }),
  z.object({
    // Replace ONE slide's layout + elements in place (id/order/background/
    // speaker-notes preserved) — the slide-level analog of SET_BLOCK_CONTENT.
    // Lets an agent switch a single slide's layout and fill it in one validated
    // op without disturbing any other slide.
    action: z.literal("SET_SLIDE_CONTENT"),
    ...slideTarget,
    layout: z.string(),
    elements: z.array(SlideElementSchema),
    /** Ambient backdrop to keep behind the elements (materialize-on-eject keeps
     *  the structured glow/dots). Omit to clear it. */
    backdrop: z.literal("structured").optional(),
  }),
  z.object({
    // Make a slide a renderer-owned STRUCTURED slide (or replace its template).
    // The freeform `elements` are kept but ignored while a template is set.
    action: z.literal("SET_SLIDE_TEMPLATE"),
    ...slideTarget,
    template: SlideTemplateSchema,
  }),
  z.object({
    // Path-addressed edit of a structured slide's content, e.g.
    // path ["title","text"] or ["steps", 1, "heading", "text"] or ["steps"]
    // (a whole array, for add/remove/reorder). The result is re-validated.
    action: z.literal("UPDATE_TEMPLATE_CONTENT"),
    ...slideTarget,
    path: z.array(z.union([z.string(), z.number()])),
    value: z.unknown(),
  }),
  z.object({ action: z.literal("DELETE_SLIDE"), ...slideTarget }),
  z.object({
    action: z.literal("DUPLICATE_SLIDE"),
    ...slideTarget,
    newSlideId: z.string(),
    /** Consumed in element order. */
    newElementIds: z.array(z.string()),
    atIndex: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("REORDER_SLIDE"),
    ...slideTarget,
    toIndex: z.number().int(),
  }),

  /* ── slide elements ── */
  z.object({
    action: z.literal("ADD_SLIDE_ELEMENT"),
    ...slideTarget,
    element: SlideElementSchema,
  }),
  z.object({
    action: z.literal("UPDATE_SLIDE_ELEMENT"),
    ...slideTarget,
    elementId: z.string(),
    updates: ElementUpdatesSchema,
  }),
  z.object({
    action: z.literal("DELETE_SLIDE_ELEMENT"),
    ...slideTarget,
    elementId: z.string(),
  }),
  z.object({
    action: z.literal("DUPLICATE_SLIDE_ELEMENT"),
    ...slideTarget,
    elementId: z.string(),
    newElementId: z.string(),
    offset: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
  z.object({
    action: z.literal("MOVE_SLIDE_ELEMENT"),
    ...slideTarget,
    elementId: z.string(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    action: z.literal("RESIZE_SLIDE_ELEMENT"),
    ...slideTarget,
    elementId: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({
    action: z.literal("REORDER_SLIDE_ELEMENT"),
    ...slideTarget,
    elementId: z.string(),
    direction: z.enum(["forward", "backward", "front", "back"]),
  }),

  /* ── slide layout / visuals ── */
  z.object({
    action: z.literal("APPLY_SLIDE_LAYOUT"),
    ...slideTarget,
    layoutId: z.string(),
    preserveExistingContent: z.boolean(),
    /** Inline placeholders for custom layouts (reducer never reads storage). */
    placeholders: z.array(LayoutPlaceholderSchema).optional(),
    /** Id pool for placeholder-seeded elements. */
    newElementIds: z.array(z.string()),
  }),
  z.object({
    action: z.literal("UPDATE_SLIDE_BACKGROUND"),
    ...slideTarget,
    background: SlideBackgroundSchema,
  }),
  z.object({
    action: z.literal("APPLY_SLIDE_THEME"),
    blockId: z.string(),
    /** Omit to theme every slide in the deck. */
    slideId: z.string().optional(),
    themeId: SlideThemeIdSchema,
  }),
  z.object({
    action: z.literal("INSERT_IMAGE"),
    ...slideTarget,
    element: ImageElementSchema,
  }),
  z.object({
    action: z.literal("REPLACE_IMAGE"),
    ...slideTarget,
    elementId: z.string(),
    src: z.string(),
    alt: z.string().optional(),
  }),
  z.object({
    action: z.literal("GENERATE_ALT_TEXT"),
    ...slideTarget,
    elementId: z.string(),
    alt: z.string(),
  }),
  z.object({
    action: z.literal("UPDATE_SPEAKER_NOTES"),
    ...slideTarget,
    speakerNotes: z.string(),
  }),
  z.object({ action: z.literal("SIMPLIFY_SLIDE_DESIGN"), ...slideTarget }),

  /* ── 2-point lines ── */
  z.object({
    action: z.literal("SET_LINE_ENDPOINTS"),
    ...slideTarget,
    elementId: z.string(),
    /** ABSOLUTE logical slide coords; the reducer derives the padded AABB
     *  frame and frame-fraction `points` atomically (one undo step). */
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
  }),

  /* ── nested groups ── */
  z.object({
    action: z.literal("GROUP_ELEMENTS"),
    ...slideTarget,
    elementIds: z.array(z.string()).min(2),
    groupId: z.string(),
    /** Depth to splice the new group id at (= entered-scope length). */
    atDepth: z.number().int().min(0),
  }),
  z.object({
    action: z.literal("UNGROUP_ELEMENTS"),
    ...slideTarget,
    groupId: z.string(),
  }),
  z.object({
    action: z.literal("DUPLICATE_ELEMENTS"),
    ...slideTarget,
    elementIds: z.array(z.string()).min(1),
    newElementIds: z.array(z.string()).min(1),
    /** old group id → producer-generated new id, so groups duplicate as
     *  groups instead of the clones silently joining the originals. */
    groupIdMap: z.record(z.string(), z.string()),
    offset: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
]);

export type CoursePatch = z.infer<typeof CoursePatchSchema>;
export type CoursePatchAction = CoursePatch["action"];

export type PatchResult =
  | { ok: true; doc: CourseDocument; summary: string }
  | { ok: false; error: string };

/* ───────────────────────────── Helpers ────────────────────────────────── */

function fail(error: string): PatchResult {
  return { ok: false, error };
}

/** Re-stamp `order` to match array position after structural changes. */
function normalizeOrders(items: { order: number }[]): void {
  items.forEach((item, i) => {
    item.order = i;
  });
}

function moveItem<T>(arr: T[], from: number, to: number): void {
  const clamped = Math.max(0, Math.min(to, arr.length - 1));
  const [item] = arr.splice(from, 1);
  arr.splice(clamped, 0, item);
}

function insertAt<T>(arr: T[], item: T, atIndex?: number): void {
  const i = atIndex === undefined ? arr.length : Math.max(0, Math.min(atIndex, arr.length));
  arr.splice(i, 0, item);
}

function blockLabel(block: LessonBlock): string {
  return block.title ? `'${block.title}'` : block.type.replace("_", " ");
}

type InnerResult = { ok: true; summary: string } | { ok: false; error: string };

type DeckHit = { deck: SlideDeckBlock; slide: Slide; slideIndex: number };

/** Locate a slide (within the mutable clone). */
function locateSlide(
  next: CourseDocument,
  blockId: string,
  slideId: string
): DeckHit | InnerResult & { ok: false } {
  const hit = findBlock(next, blockId);
  if (!hit || hit.block.type !== "slide_deck")
    return { ok: false as const, error: `Slide deck ${blockId} not found` };
  const slideIndex = hit.block.slides.findIndex((s) => s.id === slideId);
  if (slideIndex === -1)
    return { ok: false as const, error: `Slide ${slideId} not found` };
  return { deck: hit.block, slide: hit.block.slides[slideIndex], slideIndex };
}

function isLocateFail(r: DeckHit | { ok: false; error: string }): r is { ok: false; error: string } {
  return "ok" in r;
}

function locateElement(
  hit: DeckHit,
  elementId: string
): SlideElement | undefined {
  return hit.slide.elements.find((el) => el.id === elementId);
}

/** Drop group ids that no longer have ≥2 units (after deletes/ungroups). */
function normalizeGroups(slide: Slide): void {
  const degenerate = degenerateGroupIds(slide.elements);
  if (degenerate.size === 0) return;
  for (const el of slide.elements) {
    if (!el.groupPath) continue;
    const next = el.groupPath.filter((id) => !degenerate.has(id));
    if (next.length === 0) delete el.groupPath;
    else el.groupPath = next;
  }
}

/**
 * Record a manual element edit so a future AI pass can patch CONTENT without
 * resetting user-owned geometry/style (materialize-on-eject preservation).
 *
 * NOTE: `applyCoursePatch` is source-agnostic, so this currently marks ANY
 * geometry/content patch — fine today because the AI authors structured
 * templates and has no element-level geometry tools; when those land, thread
 * the patch source through so only human edits set these flags. (Also: the
 * auto-grow resize that follows a text edit sets `frame` — a conservative
 * over-mark, never an under-mark.)
 */
function markUserModified(
  el: SlideElement,
  ...aspects: ("frame" | "style" | "content")[]
): void {
  const next = { ...el.userModified };
  for (const a of aspects) next[a] = true;
  el.userModified = next;
}

/** Content keys allowed per element type (style/locked/visible always ok). */
const allowedContentKeys: Record<SlideElement["type"], string[]> = {
  text: ["text", "runs", "list"],
  heading: ["text", "runs"],
  bullet_list: ["items", "list"],
  code_block: ["code", "language"],
  image: ["src", "alt", "objectFit", "caption", "attribution"],
  shape: ["shape"],
  callout: ["text", "variant", "runs"],
  divider: ["orientation"],
  table: ["rows", "headerRow"],
  sticker: ["stickerId"],
};

/* ────────────────────────────── Apply ─────────────────────────────────── */

export function applyCoursePatch(
  doc: CourseDocument,
  patch: CoursePatch,
  nowIso: string
): PatchResult {
  const next = structuredClone(doc);
  const result = applyTo(next, patch);
  if (!result.ok) return result;
  next.metadata.updatedAt = nowIso;
  return { ok: true, doc: next, summary: result.summary };
}

function applyTo(next: CourseDocument, patch: CoursePatch): InnerResult {
  switch (patch.action) {
    case "ADD_MODULE": {
      insertAt(next.modules, patch.module, patch.atIndex);
      normalizeOrders(next.modules);
      return { ok: true, summary: `Added module '${patch.module.title}'` };
    }

    case "ADD_LESSON": {
      const mod = findModule(next, patch.moduleId);
      if (!mod) return fail(`Module ${patch.moduleId} not found`);
      insertAt(mod.lessons, patch.lesson, patch.atIndex);
      normalizeOrders(mod.lessons);
      return {
        ok: true,
        summary: `Added lesson '${patch.lesson.title}' to '${mod.title}'`,
      };
    }

    case "DELETE_MODULE": {
      const idx = next.modules.findIndex((m) => m.id === patch.moduleId);
      if (idx === -1) return fail(`Module ${patch.moduleId} not found`);
      const [removed] = next.modules.splice(idx, 1);
      normalizeOrders(next.modules);
      return { ok: true, summary: `Deleted module '${removed.title}'` };
    }

    case "DELETE_LESSON": {
      const hit = findLesson(next, patch.lessonId);
      if (!hit) return fail(`Lesson ${patch.lessonId} not found`);
      const idx = hit.module.lessons.findIndex((l) => l.id === patch.lessonId);
      const [removed] = hit.module.lessons.splice(idx, 1);
      normalizeOrders(hit.module.lessons);
      return { ok: true, summary: `Deleted lesson '${removed.title}'` };
    }

    case "REORDER_MODULE": {
      const from = next.modules.findIndex((m) => m.id === patch.moduleId);
      if (from === -1) return fail(`Module ${patch.moduleId} not found`);
      moveItem(next.modules, from, patch.toIndex);
      normalizeOrders(next.modules);
      return {
        ok: true,
        summary: `Moved module '${next.modules[Math.min(patch.toIndex, next.modules.length - 1)].title}'`,
      };
    }

    case "REORDER_LESSON": {
      const hit = findLesson(next, patch.lessonId);
      if (!hit) return fail(`Lesson ${patch.lessonId} not found`);
      const targetModule = patch.toModuleId
        ? findModule(next, patch.toModuleId)
        : hit.module;
      if (!targetModule) return fail(`Module ${patch.toModuleId} not found`);
      if (targetModule.id === hit.module.id) {
        const from = hit.module.lessons.findIndex((l) => l.id === patch.lessonId);
        moveItem(hit.module.lessons, from, patch.toIndex);
      } else {
        const from = hit.module.lessons.findIndex((l) => l.id === patch.lessonId);
        const [lesson] = hit.module.lessons.splice(from, 1);
        insertAt(targetModule.lessons, lesson, patch.toIndex);
        normalizeOrders(hit.module.lessons);
      }
      normalizeOrders(targetModule.lessons);
      return { ok: true, summary: `Moved lesson '${hit.lesson.title}'` };
    }

    case "REORDER_BLOCK": {
      const hit = findLesson(next, patch.lessonId);
      if (!hit) return fail(`Lesson ${patch.lessonId} not found`);
      const from = hit.lesson.blocks.findIndex((b) => b.id === patch.blockId);
      if (from === -1) return fail(`Block ${patch.blockId} not found in lesson`);
      moveItem(hit.lesson.blocks, from, patch.toIndex);
      normalizeOrders(hit.lesson.blocks);
      return {
        ok: true,
        summary: `Reordered ${blockLabel(hit.lesson.blocks[Math.min(patch.toIndex, hit.lesson.blocks.length - 1)])}`,
      };
    }

    case "ADD_BLOCK": {
      const hit = findLesson(next, patch.lessonId);
      if (!hit) return fail(`Lesson ${patch.lessonId} not found`);
      insertAt(hit.lesson.blocks, patch.block, patch.atIndex);
      normalizeOrders(hit.lesson.blocks);
      return {
        ok: true,
        summary: `Added ${blockLabel(patch.block)} to '${hit.lesson.title}'`,
      };
    }

    case "SET_BLOCK_CONTENT": {
      const hit = findBlock(next, patch.blockId);
      if (!hit) return fail(`Block ${patch.blockId} not found`);
      const idx = hit.lesson.blocks.findIndex((b) => b.id === patch.blockId);
      // Keep the block's identity + position; take all content from the new
      // block. The id is forced so a writer can't accidentally re-key a block.
      hit.lesson.blocks[idx] = {
        ...patch.block,
        id: patch.blockId,
        order: hit.block.order,
      };
      return { ok: true, summary: `Wrote ${blockLabel(hit.lesson.blocks[idx])} content` };
    }

    case "DELETE_BLOCK": {
      const hit = findLesson(next, patch.lessonId);
      if (!hit) return fail(`Lesson ${patch.lessonId} not found`);
      const idx = hit.lesson.blocks.findIndex((b) => b.id === patch.blockId);
      if (idx === -1) return fail(`Block ${patch.blockId} not found in lesson`);
      const [removed] = hit.lesson.blocks.splice(idx, 1);
      normalizeOrders(hit.lesson.blocks);
      return { ok: true, summary: `Deleted ${blockLabel(removed)}` };
    }

    case "UPDATE_IMPORTED_DECK": {
      const hit = findBlock(next, patch.blockId);
      if (!hit) return fail(`Block ${patch.blockId} not found`);
      if (hit.block.type !== "imported_deck")
        return fail(`Block ${patch.blockId} is not an imported deck`);
      const idx = hit.lesson.blocks.findIndex((b) => b.id === patch.blockId);
      const cur = hit.lesson.blocks[idx] as ImportedDeckBlock;
      const p = patch.patch;
      const merged: ImportedDeckBlock = { ...cur };
      if (p.title !== undefined) merged.title = p.title;
      if (p.deckImportId !== undefined) merged.deckImportId = p.deckImportId;
      if (p.sourceType !== undefined) merged.sourceType = p.sourceType;
      if (p.originalFileName !== undefined) merged.originalFileName = p.originalFileName;
      if (p.originalMimeType !== undefined) merged.originalMimeType = p.originalMimeType;
      if (p.originalFileSize !== undefined) merged.originalFileSize = p.originalFileSize;
      if (p.status !== undefined) merged.status = p.status;
      if (p.pageCount !== undefined) merged.pageCount = p.pageCount ?? undefined;
      if (p.error !== undefined) merged.error = p.error ?? undefined;
      if (p.updatedAt !== undefined) merged.updatedAt = p.updatedAt;
      hit.lesson.blocks[idx] = merged;
      return { ok: true, summary: `Updated imported deck ${blockLabel(merged)}` };
    }

    case "UPDATE_VIDEO_LESSON": {
      const hit = findBlock(next, patch.blockId);
      if (!hit) return fail(`Block ${patch.blockId} not found`);
      if (hit.block.type !== "video")
        return fail(`Block ${patch.blockId} is not a video lesson`);
      const idx = hit.lesson.blocks.findIndex((b) => b.id === patch.blockId);
      const cur = hit.lesson.blocks[idx] as VideoLessonBlock;
      const p = patch.patch;
      // Null clears an optional field; undefined leaves it untouched. Merge each
      // sub-object shallowly so a partial asset update keeps the other ids.
      const merged: VideoLessonBlock = {
        ...cur,
        asset: { ...cur.asset },
        recording: { ...cur.recording },
        edit: { ...cur.edit },
        settings: { ...cur.settings },
      };
      if (p.description !== undefined) merged.description = p.description ?? undefined;
      const assign = <T extends object>(target: T, src: Partial<Record<keyof T, unknown>> | undefined) => {
        if (!src) return;
        for (const [k, v] of Object.entries(src)) {
          if (v === undefined) continue;
          (target as Record<string, unknown>)[k] = v === null ? undefined : v;
        }
      };
      assign(merged.asset, p.asset);
      assign(merged.recording, p.recording);
      assign(merged.edit, p.edit);
      // settings are booleans — no nullable clearing, just overwrite present keys.
      if (p.settings) merged.settings = { ...merged.settings, ...p.settings };
      // captions is an optional sub-object: merge shallowly onto the existing one
      // (or a fresh `none` base), null clearing an optional field like the others.
      if (p.captions) {
        const nextCaptions: VideoLessonBlock["captions"] = { status: "none", ...merged.captions };
        assign(nextCaptions, p.captions);
        merged.captions = nextCaptions;
      }
      hit.lesson.blocks[idx] = merged;
      return { ok: true, summary: `Updated video lesson ${blockLabel(merged)}` };
    }

    case "UPDATE_TEXT":
      return applyTextUpdate(next, patch.target, patch.value);

    case "UPDATE_BLOCK_TITLE": {
      const hit = findBlock(next, patch.blockId);
      if (!hit) return fail(`Block ${patch.blockId} not found`);
      hit.block.title = patch.title;
      return { ok: true, summary: `Renamed block to '${patch.title}'` };
    }

    case "UPDATE_STYLE": {
      const hit = findBlock(next, patch.target.blockId);
      if (!hit) return fail(`Block ${patch.target.blockId} not found`);
      if (patch.style.tone && hit.block.type === "lecture_text") {
        hit.block.tone = patch.style.tone;
        return { ok: true, summary: `Set tone to ${patch.style.tone}` };
      }
      return fail("No applicable style fields for this block");
    }

    case "UPDATE_PLAN": {
      if (patch.level !== undefined) next.level = patch.level;
      if (patch.plan) next.plan = { ...next.plan, ...patch.plan };
      return { ok: true, summary: "Updated course plan" };
    }

    case "ADD_QUIZ_QUESTION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "quiz")
        return fail(`Quiz ${patch.blockId} not found`);
      insertAt(hit.block.questions, patch.question, patch.atIndex);
      return {
        ok: true,
        summary: `Added a question to ${blockLabel(hit.block)}`,
      };
    }

    case "UPDATE_QUIZ_QUESTION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "quiz")
        return fail(`Quiz ${patch.blockId} not found`);
      const idx = hit.block.questions.findIndex((q) => q.id === patch.questionId);
      if (idx === -1) return fail(`Question ${patch.questionId} not found`);
      hit.block.questions[idx] = { ...patch.question, id: patch.questionId };
      return { ok: true, summary: "Updated quiz question" };
    }

    case "ADD_HOMEWORK_EXERCISE": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      insertAt(hit.block.exercises, patch.exercise, patch.atIndex);
      return {
        ok: true,
        summary: `Added exercise '${patch.exercise.title}' to ${blockLabel(hit.block)}`,
      };
    }

    case "GENERATE_EXPLANATION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "quiz")
        return fail(`Quiz ${patch.blockId} not found`);
      const q = hit.block.questions.find((x) => x.id === patch.questionId);
      if (!q) return fail(`Question ${patch.questionId} not found`);
      q.explanation = patch.explanation;
      return { ok: true, summary: "Added an explanation to a quiz question" };
    }

    case "UPDATE_QUIZ_SETTINGS": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "quiz")
        return fail(`Quiz ${patch.blockId} not found`);
      hit.block.settings = { ...hit.block.settings, ...patch.settings };
      return { ok: true, summary: "Updated quiz settings" };
    }

    case "DELETE_QUIZ_QUESTION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "quiz")
        return fail(`Quiz ${patch.blockId} not found`);
      const idx = hit.block.questions.findIndex((q) => q.id === patch.questionId);
      if (idx === -1) return fail(`Question ${patch.questionId} not found`);
      hit.block.questions.splice(idx, 1);
      return { ok: true, summary: "Deleted quiz question" };
    }

    case "REORDER_QUIZ_QUESTION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "quiz")
        return fail(`Quiz ${patch.blockId} not found`);
      const from = hit.block.questions.findIndex((q) => q.id === patch.questionId);
      if (from === -1) return fail(`Question ${patch.questionId} not found`);
      moveItem(hit.block.questions, from, patch.toIndex);
      return { ok: true, summary: "Reordered quiz question" };
    }

    case "UPDATE_HOMEWORK_META": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      // Only the provided keys exist on the parsed meta object.
      Object.assign(hit.block, patch.meta);
      return { ok: true, summary: "Updated assignment settings" };
    }

    case "DELETE_HOMEWORK_EXERCISE": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      const idx = hit.block.exercises.findIndex((e) => e.id === patch.exerciseId);
      if (idx === -1) return fail(`Exercise ${patch.exerciseId} not found`);
      hit.block.exercises.splice(idx, 1);
      return { ok: true, summary: "Deleted exercise" };
    }

    case "REORDER_HOMEWORK_EXERCISE": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      const from = hit.block.exercises.findIndex((e) => e.id === patch.exerciseId);
      if (from === -1) return fail(`Exercise ${patch.exerciseId} not found`);
      moveItem(hit.block.exercises, from, patch.toIndex);
      return { ok: true, summary: "Reordered exercise" };
    }

    case "SET_RUBRIC": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      hit.block.rubric = patch.rubric;
      return { ok: true, summary: `Set a ${patch.rubric.length}-criterion rubric` };
    }

    case "ADD_RUBRIC_CRITERION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      if (!hit.block.rubric) hit.block.rubric = [];
      insertAt(hit.block.rubric, patch.criterion, patch.atIndex);
      return { ok: true, summary: `Added rubric criterion '${patch.criterion.name}'` };
    }

    case "UPDATE_RUBRIC_CRITERION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      const rubric = hit.block.rubric;
      const idx = rubric?.findIndex((c) => c.id === patch.criterionId) ?? -1;
      if (!rubric || idx === -1) return fail(`Criterion ${patch.criterionId} not found`);
      rubric[idx] = { ...patch.criterion, id: patch.criterionId };
      return { ok: true, summary: "Updated rubric criterion" };
    }

    case "DELETE_RUBRIC_CRITERION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      const rubric = hit.block.rubric;
      const idx = rubric?.findIndex((c) => c.id === patch.criterionId) ?? -1;
      if (!rubric || idx === -1) return fail(`Criterion ${patch.criterionId} not found`);
      rubric.splice(idx, 1);
      return { ok: true, summary: "Deleted rubric criterion" };
    }

    case "REORDER_RUBRIC_CRITERION": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "homework")
        return fail(`Homework ${patch.blockId} not found`);
      const rubric = hit.block.rubric;
      const from = rubric?.findIndex((c) => c.id === patch.criterionId) ?? -1;
      if (!rubric || from === -1) return fail(`Criterion ${patch.criterionId} not found`);
      moveItem(rubric, from, patch.toIndex);
      return { ok: true, summary: "Reordered rubric criterion" };
    }

    /* ── slide lifecycle ── */

    case "ADD_SLIDE": {
      const hit = findBlock(next, patch.blockId);
      if (!hit || hit.block.type !== "slide_deck")
        return fail(`Slide deck ${patch.blockId} not found`);
      insertAt(hit.block.slides, patch.slide, patch.atIndex);
      normalizeOrders(hit.block.slides);
      return { ok: true, summary: `Added a slide to ${blockLabel(hit.block)}` };
    }

    case "SET_SLIDE_CONTENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      // Keep the slide's identity, position, background/theme, and notes; swap
      // only the layout + elements. A freeform-content write also drops any
      // structured template so the slide goes back to a plain canvas.
      hit.slide.layout = patch.layout;
      hit.slide.elements = patch.elements;
      delete hit.slide.template;
      if (patch.backdrop) hit.slide.backdrop = patch.backdrop;
      else delete hit.slide.backdrop;
      return { ok: true, summary: `Rewrote slide ${hit.slideIndex + 1} (${patch.layout})` };
    }

    case "SET_SLIDE_TEMPLATE": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      hit.slide.template = patch.template;
      hit.slide.layout = patch.template.layoutId;
      return { ok: true, summary: `Set the ${patch.template.layoutId} layout` };
    }

    case "UPDATE_TEMPLATE_CONTENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      if (!hit.slide.template) return fail("Slide has no structured template to edit");
      if (patch.path.length === 0) return fail("Empty content path");
      // Walk to the parent of the target key, then set it.
      let node: unknown = hit.slide.template.content;
      for (let i = 0; i < patch.path.length - 1; i++) {
        if (node == null || typeof node !== "object") return fail(`Bad content path at '${patch.path[i]}'`);
        node = (node as Record<string | number, unknown>)[patch.path[i]];
      }
      if (node == null || typeof node !== "object") return fail("Bad content path");
      (node as Record<string | number, unknown>)[patch.path[patch.path.length - 1]] = patch.value;
      // Re-validate the whole template so a bad path/value can't corrupt the slide.
      const check = SlideTemplateSchema.safeParse(hit.slide.template);
      if (!check.success) return fail(`Invalid template after edit: ${check.error.issues[0]?.message ?? "schema error"}`);
      hit.slide.template = check.data;
      return { ok: true, summary: "Updated structured content" };
    }

    case "DELETE_SLIDE": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      if (hit.deck.slides.length <= 1) return fail("A deck needs at least one slide");
      hit.deck.slides.splice(hit.slideIndex, 1);
      normalizeOrders(hit.deck.slides);
      return { ok: true, summary: "Deleted slide" };
    }

    case "DUPLICATE_SLIDE": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      if (patch.newElementIds.length < hit.slide.elements.length)
        return fail("Not enough newElementIds for slide duplication");
      const clone = structuredClone(hit.slide);
      clone.id = patch.newSlideId;
      clone.elements.forEach((el, i) => {
        el.id = patch.newElementIds[i];
      });
      insertAt(hit.deck.slides, clone, patch.atIndex ?? hit.slideIndex + 1);
      normalizeOrders(hit.deck.slides);
      return { ok: true, summary: `Duplicated slide ${hit.slideIndex + 1}` };
    }

    case "REORDER_SLIDE": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      moveItem(hit.deck.slides, hit.slideIndex, patch.toIndex);
      normalizeOrders(hit.deck.slides);
      return { ok: true, summary: "Reordered slide" };
    }

    /* ── slide elements ── */

    case "ADD_SLIDE_ELEMENT":
    case "INSERT_IMAGE": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = structuredClone(patch.element) as SlideElement;
      const frame = clampFrame(el);
      el.x = frame.x;
      el.y = frame.y;
      el.width = frame.width;
      el.height = frame.height;
      el.zIndex = topZ(hit.slide.elements);
      hit.slide.elements.push(el);
      return {
        ok: true,
        summary:
          patch.action === "INSERT_IMAGE"
            ? "Inserted an image"
            : `Added a ${el.type.replace("_", " ")} element`,
      };
    }

    case "UPDATE_SLIDE_ELEMENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = locateElement(hit, patch.elementId);
      if (!el) return fail(`Element ${patch.elementId} not found`);
      const { style, locked, visible, ...content } = patch.updates;
      const allowed = allowedContentKeys[el.type];
      for (const key of Object.keys(content)) {
        if (!allowed.includes(key)) {
          return fail(`Field '${key}' is not valid for a ${el.type} element`);
        }
      }
      Object.assign(el, content);
      // Rich-text invariant: concat(runs.text) === text. Runs win when
      // supplied; a plain `text` rewrite clears stale formatting.
      if ("runs" in content || "text" in content) {
        const rich = el as SlideElement & { text?: string; runs?: { text: string }[] };
        if (content.runs) {
          rich.text = content.runs.map((r) => r.text).join("");
        } else if ("text" in content && rich.runs) {
          delete rich.runs;
        }
      }
      // Rich-list invariant: `items` (plain fallback) === flatten(list). The rich
      // `list` wins when supplied; a legacy plain-`items` rewrite resets it.
      if (el.type === "bullet_list") {
        const bl = el as Extract<SlideElement, { type: "bullet_list" }>;
        if (content.list) bl.items = flattenToItems(content.list);
        else if ("items" in content) delete bl.list;
      }
      // Lists inside a text box: `text` (plain fallback) === the list's lines.
      // A plain text/runs rewrite (e.g. toggling the last marker off) clears it.
      if (el.type === "text") {
        const te = el as Extract<SlideElement, { type: "text" }>;
        if (content.list) {
          te.text = flattenToItems(content.list).join("\n");
          delete te.runs;
        } else if ("text" in content || "runs" in content) {
          delete te.list;
        }
      }
      if (style) el.style = { ...el.style, ...style };
      if (locked !== undefined) el.locked = locked;
      if (visible !== undefined) el.visible = visible;
      const aspects: ("style" | "content")[] = [];
      if (Object.keys(content).length > 0) aspects.push("content");
      if (style) aspects.push("style");
      if (aspects.length) markUserModified(el, ...aspects);
      return { ok: true, summary: `Updated ${el.type.replace("_", " ")} element` };
    }

    case "DELETE_SLIDE_ELEMENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const idx = hit.slide.elements.findIndex((el) => el.id === patch.elementId);
      if (idx === -1) return fail(`Element ${patch.elementId} not found`);
      const [removed] = hit.slide.elements.splice(idx, 1);
      normalizeGroups(hit.slide);
      return { ok: true, summary: `Deleted ${removed.type.replace("_", " ")} element` };
    }

    case "DUPLICATE_SLIDE_ELEMENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = locateElement(hit, patch.elementId);
      if (!el) return fail(`Element ${patch.elementId} not found`);
      const clone = structuredClone(el);
      clone.id = patch.newElementId;
      delete clone.groupPath; // a lone duplicate must not join the source group
      const offset = patch.offset ?? { x: 24, y: 24 };
      const frame = clampFrame({ ...clone, x: clone.x + offset.x, y: clone.y + offset.y });
      clone.x = frame.x;
      clone.y = frame.y;
      clone.zIndex = topZ(hit.slide.elements);
      hit.slide.elements.push(clone);
      return { ok: true, summary: `Duplicated ${el.type.replace("_", " ")} element` };
    }

    case "MOVE_SLIDE_ELEMENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = locateElement(hit, patch.elementId);
      if (!el) return fail(`Element ${patch.elementId} not found`);
      const frame = clampFrame({ x: patch.x, y: patch.y, width: el.width, height: el.height });
      el.x = frame.x;
      el.y = frame.y;
      markUserModified(el, "frame");
      return { ok: true, summary: `Moved ${el.type.replace("_", " ")} element` };
    }

    case "RESIZE_SLIDE_ELEMENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = locateElement(hit, patch.elementId);
      if (!el) return fail(`Element ${patch.elementId} not found`);
      const frame = clampFrame({
        x: patch.x ?? el.x,
        y: patch.y ?? el.y,
        width: patch.width,
        height: patch.height,
      });
      el.x = frame.x;
      el.y = frame.y;
      el.width = frame.width;
      el.height = frame.height;
      markUserModified(el, "frame");
      return { ok: true, summary: `Resized ${el.type.replace("_", " ")} element` };
    }

    case "REORDER_SLIDE_ELEMENT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const sorted = [...hit.slide.elements].sort((a, b) => a.zIndex - b.zIndex);
      const idx = sorted.findIndex((el) => el.id === patch.elementId);
      if (idx === -1) return fail(`Element ${patch.elementId} not found`);
      const to =
        patch.direction === "front"
          ? sorted.length - 1
          : patch.direction === "back"
            ? 0
            : patch.direction === "forward"
              ? Math.min(idx + 1, sorted.length - 1)
              : Math.max(idx - 1, 0);
      moveItem(sorted, idx, to);
      sorted.forEach((el, i) => {
        el.zIndex = i;
      });
      return { ok: true, summary: `Sent element ${patch.direction}` };
    }

    /* ── slide layout / visuals ── */

    case "APPLY_SLIDE_LAYOUT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const placeholders = patch.placeholders ?? findLayout(patch.layoutId)?.placeholders;
      if (!placeholders) return fail(`Unknown layout '${patch.layoutId}'`);
      hit.slide.elements = applyLayoutToSlide(
        hit.slide.elements,
        placeholders,
        patch.preserveExistingContent,
        patch.newElementIds
      );
      hit.slide.layout = patch.layoutId;
      // Applying a flat (placeholder) layout returns a structured slide to a
      // plain editable canvas.
      delete hit.slide.template;
      normalizeGroups(hit.slide);
      return {
        ok: true,
        summary: `Applied layout '${patch.layoutId.replace(/[_-]/g, " ")}'`,
      };
    }

    case "UPDATE_SLIDE_BACKGROUND": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      hit.slide.style.background = patch.background;
      return { ok: true, summary: `Set a ${patch.background.type} background` };
    }

    case "APPLY_SLIDE_THEME": {
      const blockHit = findBlock(next, patch.blockId);
      if (!blockHit || blockHit.block.type !== "slide_deck")
        return fail(`Slide deck ${patch.blockId} not found`);
      const theme = findTheme(patch.themeId);
      const targets = patch.slideId
        ? blockHit.block.slides.filter((s) => s.id === patch.slideId)
        : blockHit.block.slides;
      if (patch.slideId && targets.length === 0)
        return fail(`Slide ${patch.slideId} not found`);
      for (const slide of targets) {
        slide.style.theme = themeRef(theme);
        if (slide.style.background.type !== "image") {
          slide.style.background = structuredClone(theme.defaultBackground);
        }
      }
      return {
        ok: true,
        summary: patch.slideId
          ? `Applied theme '${theme.name}'`
          : `Applied theme '${theme.name}' to all ${targets.length} slides`,
      };
    }

    case "REPLACE_IMAGE": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = locateElement(hit, patch.elementId);
      if (!el || el.type !== "image") return fail(`Image ${patch.elementId} not found`);
      el.src = patch.src;
      if (patch.alt !== undefined) el.alt = patch.alt;
      return { ok: true, summary: "Replaced image" };
    }

    case "GENERATE_ALT_TEXT": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = locateElement(hit, patch.elementId);
      if (!el || el.type !== "image") return fail(`Image ${patch.elementId} not found`);
      el.alt = patch.alt;
      return { ok: true, summary: "Wrote image alt text" };
    }

    case "UPDATE_SPEAKER_NOTES": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      hit.slide.speakerNotes = patch.speakerNotes;
      return { ok: true, summary: "Updated speaker notes" };
    }

    case "SIMPLIFY_SLIDE_DESIGN": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      hit.deck.slides[hit.slideIndex] = simplifySlideDesign(hit.slide);
      return { ok: true, summary: "Simplified the slide's design" };
    }

    case "SET_LINE_ENDPOINTS": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const el = locateElement(hit, patch.elementId);
      if (!el) return fail(`Element ${patch.elementId} not found`);
      if (el.type !== "shape" || (el.shape !== "line" && el.shape !== "arrow"))
        return fail("Endpoints only apply to line and arrow shapes");
      const cx = (v: number) => Math.max(0, Math.min(v, SLIDE_W));
      const cy = (v: number) => Math.max(0, Math.min(v, SLIDE_H));
      const x1 = cx(patch.x1), y1 = cy(patch.y1);
      const x2 = cx(patch.x2), y2 = cy(patch.y2);
      // padded AABB: axis-aligned lines keep a usable hit area, and the
      // frame stays the selection/snap/marquee rectangle
      const PAD = 24;
      let fx = Math.min(x1, x2);
      let fw = Math.abs(x2 - x1);
      if (fw < PAD) {
        fx = Math.max(0, Math.min((x1 + x2) / 2 - PAD / 2, SLIDE_W - PAD));
        fw = PAD;
      }
      let fy = Math.min(y1, y2);
      let fh = Math.abs(y2 - y1);
      if (fh < PAD) {
        fy = Math.max(0, Math.min((y1 + y2) / 2 - PAD / 2, SLIDE_H - PAD));
        fh = PAD;
      }
      el.x = fx;
      el.y = fy;
      el.width = fw;
      el.height = fh;
      const r = (v: number) => Math.round(v * 10000) / 10000;
      el.points = {
        x1: r((x1 - fx) / fw),
        y1: r((y1 - fy) / fh),
        x2: r((x2 - fx) / fw),
        y2: r((y2 - fy) / fh),
      };
      return { ok: true, summary: `Reshaped the ${el.shape}` };
    }

    case "GROUP_ELEMENTS": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      const members = hit.slide.elements.filter((el) =>
        patch.elementIds.includes(el.id)
      );
      if (members.length !== patch.elementIds.length)
        return fail("Some elements to group were not found");
      // ≥2 distinct units at the target depth, and every member must already
      // live inside the same scope (path prefix length ≥ atDepth).
      const units = new Set<string>();
      for (const el of members) {
        const path = el.groupPath ?? [];
        if (path.length < patch.atDepth)
          return fail("Element is outside the grouping scope");
        units.add(path.length > patch.atDepth ? path[patch.atDepth] : el.id);
      }
      if (units.size < 2) return fail("Grouping needs at least two units");
      for (const el of members) {
        const path = el.groupPath ?? [];
        el.groupPath = [
          ...path.slice(0, patch.atDepth),
          patch.groupId,
          ...path.slice(patch.atDepth),
        ];
      }
      return { ok: true, summary: `Grouped ${units.size} items` };
    }

    case "UNGROUP_ELEMENTS": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      let touched = 0;
      for (const el of hit.slide.elements) {
        if (!el.groupPath?.includes(patch.groupId)) continue;
        const nextPath = el.groupPath.filter((id) => id !== patch.groupId);
        if (nextPath.length === 0) delete el.groupPath;
        else el.groupPath = nextPath;
        touched++;
      }
      if (touched === 0) return fail(`Group ${patch.groupId} not found`);
      normalizeGroups(hit.slide);
      return { ok: true, summary: "Ungrouped elements" };
    }

    case "DUPLICATE_ELEMENTS": {
      const hit = locateSlide(next, patch.blockId, patch.slideId);
      if (isLocateFail(hit)) return hit;
      if (patch.newElementIds.length < patch.elementIds.length)
        return fail("Not enough newElementIds for duplication");
      const offset = patch.offset ?? { x: 24, y: 24 };
      let z = topZ(hit.slide.elements);
      const clones: SlideElement[] = [];
      for (let i = 0; i < patch.elementIds.length; i++) {
        const el = locateElement(hit, patch.elementIds[i]);
        if (!el) return fail(`Element ${patch.elementIds[i]} not found`);
        const clone = structuredClone(el);
        clone.id = patch.newElementIds[i];
        if (clone.groupPath) {
          clone.groupPath = clone.groupPath.map(
            (gid) => patch.groupIdMap[gid] ?? gid
          );
        }
        const frame = clampFrame({
          ...clone,
          x: clone.x + offset.x,
          y: clone.y + offset.y,
        });
        clone.x = frame.x;
        clone.y = frame.y;
        clone.zIndex = z++;
        clones.push(clone);
      }
      hit.slide.elements.push(...clones);
      normalizeGroups(hit.slide);
      return {
        ok: true,
        summary: `Duplicated ${clones.length} element${clones.length > 1 ? "s" : ""}`,
      };
    }
  }
}

/* ─────────────────────────── Text updates ─────────────────────────────── */

function applyTextUpdate(
  next: CourseDocument,
  target: TextTarget,
  value: string
): InnerResult {
  switch (target.kind) {
    case "course": {
      next[target.field] = value;
      return { ok: true, summary: `Updated course ${target.field}` };
    }
    case "module": {
      const mod = findModule(next, target.id);
      if (!mod) return fail(`Module ${target.id} not found`);
      mod[target.field] = value;
      return { ok: true, summary: `Updated module ${target.field}` };
    }
    case "lesson": {
      const hit = findLesson(next, target.id);
      if (!hit) return fail(`Lesson ${target.id} not found`);
      hit.lesson[target.field] = value;
      return { ok: true, summary: `Updated lesson ${target.field}` };
    }
    case "slide": {
      const hit = locateSlide(next, target.blockId, target.slideId);
      if (isLocateFail(hit)) return hit;
      hit.slide.title = value;
      return { ok: true, summary: "Updated slide title" };
    }
    case "block_field":
      return applyBlockFieldUpdate(next, target, value);
  }
}

function applyBlockFieldUpdate(
  next: CourseDocument,
  target: Extract<TextTarget, { kind: "block_field" }>,
  value: string
): InnerResult {
  const hit = findBlock(next, target.blockId);
  if (!hit) return fail(`Block ${target.blockId} not found`);
  const block = hit.block;
  const label = blockLabel(block);

  switch (block.type) {
    case "lecture_text": {
      if (target.field === "paragraph_text" && target.itemId) {
        const para = block.paragraphs.find((p) => p.id === target.itemId);
        if (!para) return fail(`Paragraph ${target.itemId} not found`);
        para.text = value;
        return { ok: true, summary: `Updated a paragraph in ${label}` };
      }
      // Appends a paragraph; itemId carries the producer-generated id so the
      // apply stays deterministic.
      if (target.field === "add_paragraph" && target.itemId) {
        block.paragraphs.push({ id: target.itemId, kind: "paragraph", text: value });
        return { ok: true, summary: `Added a paragraph to ${label}` };
      }
      break;
    }
    case "homework": {
      if (target.field === "instructions") {
        block.instructions = value;
        return { ok: true, summary: `Updated instructions in ${label}` };
      }
      if (target.itemId) {
        const ex = block.exercises.find((e) => e.id === target.itemId);
        if (!ex) return fail(`Exercise ${target.itemId} not found`);
        if (target.field === "exercise_title") ex.title = value;
        else if (target.field === "exercise_prompt") ex.prompt = value;
        else if (target.field === "exercise_hint") ex.hint = value;
        else if (target.field === "exercise_solution") ex.solution = value;
        else break;
        return { ok: true, summary: `Updated an exercise in ${label}` };
      }
      break;
    }
    case "example": {
      if (target.field === "context" || target.field === "explanation" || target.field === "takeaway") {
        block[target.field] = value;
        return { ok: true, summary: `Updated ${target.field} in ${label}` };
      }
      if (target.field === "step" && target.itemId !== undefined) {
        const idx = Number(target.itemId);
        if (!Number.isInteger(idx) || idx < 0 || idx >= block.steps.length)
          return fail(`Step index ${target.itemId} out of range`);
        block.steps[idx] = value;
        return { ok: true, summary: `Updated a step in ${label}` };
      }
      if (target.field === "add_step") {
        block.steps.push(value);
        return { ok: true, summary: `Added a step to ${label}` };
      }
      break;
    }
    case "exercise": {
      if (target.field === "prompt" || target.field === "hint" || target.field === "solution") {
        block[target.field] = value;
        return { ok: true, summary: `Updated ${target.field} in ${label}` };
      }
      break;
    }
    default:
      break;
  }
  return fail(`Field '${target.field}' is not editable on a ${block.type} block`);
}
