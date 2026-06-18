/**
 * AI tools for the renderer-owned STRUCTURED layouts + the new primitives
 * (stickers, font tokens). Like every tool, these are pure over `ctx.doc` and
 * return CoursePatches — the loop applies + persists + stages them.
 *
 * The structured tools' params ARE the strict length-enforcing schemas, so the
 * loop's arg-validation IS the validate→repair loop: an over-long heading or a
 * bad item count comes back to the model as a readable error before it ships.
 */

import { z } from "zod";
import { addStickerPatch, setSlideTemplatePatch, updateElementPatch } from "@/lib/course/commands";
import { createStructuredSlide } from "@/lib/course/factories";
import type { CoursePatch } from "@/lib/course/patches";
import { findBlock, findSlide } from "@/lib/course/queries";
import { FontFamilyIdSchema, FontScaleSchema } from "@/lib/course/schemas";
import { STICKER_IDS } from "@/lib/course/slide/stickers";
import { StructuredTemplateInputSchema } from "@/lib/course/slide/structuredLayouts";
import type { ElementStyle, SlideDeckBlock, SlideTemplate, SlideThemeId } from "@/lib/course/types";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";

const StickerIdEnum = z.enum(STICKER_IDS as [string, ...string[]]);

function deck(ctx: ToolContext, blockId: string): { block: SlideDeckBlock; lessonId: string } {
  const hit = findBlock(ctx.doc, blockId);
  if (!hit || hit.block.type !== "slide_deck") throw new ToolError(`No slide deck with id ${blockId}.`);
  return { block: hit.block, lessonId: hit.lesson.id };
}

function deckThemeId(block: SlideDeckBlock, ctx: ToolContext): SlideThemeId {
  return block.slides[0]?.style.theme.id ?? ctx.doc.theme.slideDefaults.themeId;
}

const addStructuredSlide = defineTool({
  name: "add_structured_slide",
  description:
    "Add ONE DESIGNED (structured) slide. Pick the layoutId whose shape matches the content (see the layout catalog): e.g. a process → process_steps, a definition → key_concept, key numbers → metrics_overview, code → code_walkthrough_steps, 2–3 options compared with a few traits each → comparison_columns, options compared across several shared dimensions → comparison_matrix. Fill every slot, keep copy tight (length limits are enforced — you'll be told to shorten). The renderer owns all arrangement, colors, badges, arrows, numbering, and reflow; you only fill slots.",
  params: z.object({
    blockId: z.string(),
    position: z.number().int().nullable(),
    template: StructuredTemplateInputSchema,
    notes: z.string().nullable(),
  }),
  execute(args, ctx) {
    const { block, lessonId } = deck(ctx, args.blockId);
    const slide = createStructuredSlide(args.template.layoutId, deckThemeId(block, ctx));
    slide.template = args.template as SlideTemplate;
    if (args.notes && args.notes.trim()) slide.speakerNotes = args.notes.trim();
    const patch: CoursePatch = {
      action: "ADD_SLIDE",
      blockId: args.blockId,
      slide,
      ...(args.position != null ? { atIndex: args.position } : {}),
    };
    return {
      summary: `Added a ${args.template.layoutId} slide`,
      patches: [patch],
      data: { slideId: slide.id, blockId: args.blockId, lessonId, blockType: "slide_deck" },
    };
  },
});

const addStructuredSlidesBatch = defineTool({
  name: "add_structured_slides_batch",
  description:
    "Add a BATCH of 1–4 designed (structured) slides in ONE call — author a whole pedagogical SEGMENT at once (e.g. hook+concept, or a worked example, or practice+recap) rather than one slide per call. Each entry is a full structured slide (pick the layoutId whose shape fits the content), plus optional speaker notes and the plan slideSpecId it satisfies. All entries are validated together: if ANY slide's content violates a slot limit, NOTHING is added and you get the errors to fix. Strongly prefer this over repeated add_structured_slide calls.",
  params: z.object({
    deckBlockId: z.string(),
    slides: z
      .array(
        z.object({
          slideSpecId: z.string().nullable(),
          template: StructuredTemplateInputSchema,
          notes: z.string().nullable(),
        })
      )
      .min(1)
      .max(4, "Author at most 4 slides per batch — one segment (1–3 slides) at a time."),
  }),
  execute(args, ctx) {
    const { block, lessonId } = deck(ctx, args.deckBlockId);
    const themeId = deckThemeId(block, ctx);
    const patches: CoursePatch[] = [];
    const slidesAdded: { slideId: string; specId?: string; index: number }[] = [];
    args.slides.forEach((s, i) => {
      const slide = createStructuredSlide(s.template.layoutId, themeId);
      slide.template = s.template as SlideTemplate;
      if (s.notes && s.notes.trim()) slide.speakerNotes = s.notes.trim();
      if (s.slideSpecId && s.slideSpecId.trim()) slide.ai.specId = s.slideSpecId.trim();
      patches.push({ action: "ADD_SLIDE", blockId: args.deckBlockId, slide });
      slidesAdded.push({ slideId: slide.id, specId: s.slideSpecId ?? undefined, index: i });
    });
    return {
      summary: `Added ${patches.length} structured slide${patches.length === 1 ? "" : "s"}`,
      patches,
      data: { blockId: args.deckBlockId, lessonId, blockType: "slide_deck", slidesAdded },
    };
  },
});

const setStructuredSlide = defineTool({
  name: "set_structured_slide",
  description:
    "Convert ONE existing slide into a designed (structured) layout, or replace its structured content. Other slides untouched.",
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    template: StructuredTemplateInputSchema,
  }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    return {
      summary: `Set the ${args.template.layoutId} layout`,
      patches: [setSlideTemplatePatch(args.blockId, args.slideId, args.template as SlideTemplate)],
      data: { slideId: args.slideId, blockId: args.blockId, lessonId: hit.lesson.id, blockType: "slide_deck" },
    };
  },
});

const setTextStyle = defineTool({
  name: "set_text_style",
  description:
    "Set the SIZE token and/or FONT family of ONE text element on a freeform slide. Size is a semantic scale (display/title/heading/body/caption), never raw px; family is sans/serif/mono/display (display = the editorial serif — good for key-concept titles).",
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    elementId: z.string(),
    fontScale: FontScaleSchema.nullable(),
    fontFamily: FontFamilyIdSchema.nullable(),
  }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    const el = hit.slide.elements.find((e) => e.id === args.elementId);
    if (!el) throw new ToolError(`Element ${args.elementId} not found on that slide.`);
    if (!args.fontScale && !args.fontFamily) throw new ToolError("Provide fontScale and/or fontFamily.");
    const style: Pick<ElementStyle, "fontScale" | "fontFamily"> = {};
    if (args.fontScale) style.fontScale = args.fontScale;
    if (args.fontFamily) style.fontFamily = args.fontFamily;
    return {
      summary: "Set text style",
      patches: [updateElementPatch(args.blockId, args.slideId, args.elementId, { style })],
      data: { slideId: args.slideId, blockId: args.blockId, lessonId: hit.lesson.id, blockType: "slide_deck" },
    };
  },
});

const addSticker = defineTool({
  name: "add_sticker",
  description:
    "Place ONE icon sticker (by id, from the sticker catalog) on a freeform slide to clarify a point — use sparingly, skip it when it doesn't help. The icon is themed to the slide accent automatically.",
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    stickerId: StickerIdEnum,
    x: z.number().nullable(),
    y: z.number().nullable(),
  }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    const patch = addStickerPatch(args.blockId, args.slideId, args.stickerId, hit.slide.elements.length);
    if ((args.x != null || args.y != null) && patch.action === "ADD_SLIDE_ELEMENT") {
      patch.element = { ...patch.element, x: args.x ?? patch.element.x, y: args.y ?? patch.element.y };
    }
    return {
      summary: `Added a ${args.stickerId} sticker`,
      patches: [patch],
      data: { slideId: args.slideId, blockId: args.blockId, lessonId: hit.lesson.id, blockType: "slide_deck" },
    };
  },
});

export const structuredSlideTools: Tool[] = [
  addStructuredSlide,
  addStructuredSlidesBatch,
  setStructuredSlide,
  setTextStyle,
  addSticker,
];
