/**
 * Granular, id-addressed, NON-destructive slide tools — the Cursor moment.
 *
 * Every op targets a deck/slide by id and touches only that slide, wrapping the
 * studio's existing slide patches. "Switch slide 1 to two-column" becomes:
 * get_deck → read slide 1's id → set_slide_layout — a targeted op on real
 * state, slides 2..n untouched. write_slide_deck (in writers.ts) stays only as
 * a deliberate "generate a fresh deck" action.
 */

import { z } from "zod";
import { applyLayoutPatch, deleteSlidePatch, reorderSlidePatch, updateElementPatch } from "@/lib/course/commands";
import type { CoursePatch } from "@/lib/course/patches";
import { findBlock, findSlide } from "@/lib/course/queries";
import { findLayout } from "@/lib/course/slide/layouts";
import type { SlideDeckBlock, SlideThemeId } from "@/lib/course/types";
import {
  LAYOUT_IDS,
  SlideContentEntrySchema,
  buildSlide,
  contentToUpdates,
  deriveSlots,
  slotText,
  validateSlideContent,
} from "./slideContent";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";

const LayoutEnum = z.enum(LAYOUT_IDS as [string, ...string[]]);

function deck(ctx: ToolContext, blockId: string): { block: SlideDeckBlock; lessonId: string } {
  const hit = findBlock(ctx.doc, blockId);
  if (!hit || hit.block.type !== "slide_deck") {
    throw new ToolError(`No slide deck with id ${blockId}.`);
  }
  return { block: hit.block, lessonId: hit.lesson.id };
}

function deckThemeId(block: SlideDeckBlock, ctx: ToolContext): SlideThemeId {
  return block.slides[0]?.style.theme.id ?? ctx.doc.theme.slideDefaults.themeId;
}

const slotView = (s: ReturnType<typeof deriveSlots>[number]) => ({
  role: s.role,
  kind: s.kind,
  value: slotText(s.element),
});

/* ─────────────────────────────── reads ────────────────────────────────── */

const getDeck = defineTool({
  name: "get_deck",
  description:
    "Read a slide deck: every slide's id, layout, and current slot contents. Call this before editing so you target the right slide id.",
  readOnly: true,
  params: z.object({ blockId: z.string() }),
  execute(args, ctx) {
    const { block } = deck(ctx, args.blockId);
    return {
      summary: `Read deck (${block.slides.length} slide(s))`,
      data: block.slides.map((s) => ({
        slideId: s.id,
        layout: s.layout,
        slots: deriveSlots(s).map(slotView),
      })),
    };
  },
});

const getSlide = defineTool({
  name: "get_slide",
  description: "Read one slide's layout + current slot contents by id.",
  readOnly: true,
  params: z.object({ blockId: z.string(), slideId: z.string() }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    return {
      summary: "Read slide",
      data: { slideId: hit.slide.id, layout: hit.slide.layout, slots: deriveSlots(hit.slide).map(slotView) },
    };
  },
});

/* ─────────────────────────────── writes ───────────────────────────────── */

const addSlide = defineTool({
  name: "add_slide",
  description:
    "Add ONE slide to a deck at `position` (0-based; omit for end). Pick a `layout` from the catalog that fits the content, then fill its slots by `role`. Emphasis goes in text slots as runs.",
  params: z.object({
    blockId: z.string(),
    position: z.number().int().nullable(),
    layout: LayoutEnum,
    content: z.array(SlideContentEntrySchema),
    notes: z.string().nullable(),
  }),
  execute(args, ctx) {
    const { block, lessonId } = deck(ctx, args.blockId);
    const errors = validateSlideContent(args.layout, args.content);
    if (errors.length) throw new ToolError(errors.join(" "));
    const slide = buildSlide(args.layout, args.content, deckThemeId(block, ctx));
    if (args.notes && args.notes.trim()) slide.speakerNotes = args.notes.trim();
    const patch: CoursePatch = {
      action: "ADD_SLIDE",
      blockId: args.blockId,
      slide,
      ...(args.position != null ? { atIndex: args.position } : {}),
    };
    return {
      summary: `Added a ${args.layout} slide`,
      patches: [patch],
      data: { slideId: slide.id, blockId: args.blockId, lessonId, blockType: "slide_deck" },
    };
  },
});

const updateSlide = defineTool({
  name: "update_slide",
  description:
    "Patch the content of ONE slide by id — provide only the slots you want to change (others stay as-is). Use runs for bold/italic in text slots.",
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    content: z.array(SlideContentEntrySchema),
  }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    const byRole = new Map(deriveSlots(hit.slide).map((s) => [s.role, s]));
    const patches: CoursePatch[] = [];
    const missing: string[] = [];
    for (const entry of args.content) {
      const slot = byRole.get(entry.role);
      if (!slot) { missing.push(entry.role); continue; }
      patches.push(updateElementPatch(args.blockId, args.slideId, slot.element.id, contentToUpdates(slot.element.type, entry)));
    }
    if (patches.length === 0) {
      throw new ToolError(`No matching slots. This slide's slots: ${[...byRole.keys()].join(", ")}.`);
    }
    const note = missing.length ? ` (no slot for: ${missing.join(", ")})` : "";
    return {
      summary: `Updated ${patches.length} slot(s)${note}`,
      patches,
      data: { slideId: args.slideId, blockId: args.blockId, lessonId: hit.lesson.id, blockType: "slide_deck" },
    };
  },
});

const setSlideLayout = defineTool({
  name: "set_slide_layout",
  description:
    "Switch ONE slide to a different layout. Omit `content` to reflow the existing content into the new layout's slots; provide `content` to also (re)fill the slots. Other slides are untouched.",
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    layout: LayoutEnum,
    content: z.array(SlideContentEntrySchema).nullable(),
  }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    const layout = findLayout(args.layout);
    if (!layout) throw new ToolError(`Unknown layout "${args.layout}". Valid: ${LAYOUT_IDS.join(", ")}.`);
    const data = { slideId: args.slideId, blockId: args.blockId, lessonId: hit.lesson.id, blockType: "slide_deck" };

    if (args.content && args.content.length > 0) {
      const errors = validateSlideContent(args.layout, args.content);
      if (errors.length) throw new ToolError(errors.join(" "));
      const built = buildSlide(args.layout, args.content, deckThemeId(hit.deck, ctx));
      const patch: CoursePatch = {
        action: "SET_SLIDE_CONTENT",
        blockId: args.blockId,
        slideId: args.slideId,
        layout: args.layout,
        elements: built.elements,
      };
      return { summary: `Switched slide to ${args.layout} and filled it`, patches: [patch], data };
    }

    // Reflow existing content into the new layout (role-matched).
    const patch = applyLayoutPatch(args.blockId, args.slideId, args.layout, true, layout.placeholders.length);
    return { summary: `Switched slide to ${args.layout}`, patches: [patch], data };
  },
});

const reorderSlides = defineTool({
  name: "reorder_slides",
  description: "Reorder a deck's slides to match `orderedSlideIds` (all slide ids, in the new order).",
  params: z.object({ blockId: z.string(), orderedSlideIds: z.array(z.string()) }),
  execute(args, ctx) {
    const { block, lessonId } = deck(ctx, args.blockId);
    const valid = new Set(block.slides.map((s) => s.id));
    const patches = args.orderedSlideIds
      .filter((id) => valid.has(id))
      .map((id, i) => reorderSlidePatch(args.blockId, id, i));
    return {
      summary: `Reordered ${patches.length} slide(s)`,
      patches,
      data: { blockId: args.blockId, lessonId, blockType: "slide_deck" },
    };
  },
});

const deleteSlideTool = defineTool({
  name: "delete_slide",
  description: "Delete one slide by id (a deck must keep at least one slide).",
  params: z.object({ blockId: z.string(), slideId: z.string() }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    return {
      summary: "Deleted a slide",
      patches: [deleteSlidePatch(args.blockId, args.slideId)],
      data: { slideId: args.slideId, blockId: args.blockId, lessonId: hit.lesson.id, blockType: "slide_deck" },
    };
  },
});

export const slideTools: Tool[] = [
  getDeck,
  getSlide,
  addSlide,
  updateSlide,
  setSlideLayout,
  reorderSlides,
  deleteSlideTool,
];
