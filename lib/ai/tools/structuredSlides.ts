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
import { addBlockPatch, addStickerPatch, setSlideTemplatePatch, updateElementPatch } from "@/lib/course/commands";
import { DIAGRAM_TEMPLATE_IDS, findDiagramTemplate } from "@/lib/course/diagram/catalog";
import { DiagramSpecInputSchema } from "@/lib/course/diagram/schemas";
import { DIAGRAM_KINDS, VISUAL_ROLES, type DiagramContent, type DiagramSpec, type VisualSpec } from "@/lib/course/diagram/types";
import { diagramRequiredElements, validateDiagram } from "@/lib/course/diagram/validate";
import { createStructuredSlide } from "@/lib/course/factories";
import type { CoursePatch } from "@/lib/course/patches";
import { findBlock, findLesson, findSlide } from "@/lib/course/queries";
import { FontFamilyIdSchema, FontScaleSchema } from "@/lib/course/schemas";
import { clampStructuredTemplate } from "@/lib/course/slide/clampStructured";
import { STICKER_IDS } from "@/lib/course/slide/stickers";
import { StructuredTemplateInputSchema } from "@/lib/course/slide/structuredLayouts";
import type { ElementStyle, IllustrationContent, RichText, SlideDeckBlock, SlideTemplate, SlideThemeId } from "@/lib/course/types";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";

const StickerIdEnum = z.enum(STICKER_IDS as [string, ...string[]]);

function deck(ctx: ToolContext, blockId: string): { block: SlideDeckBlock; lessonId: string } {
  const hit = findBlock(ctx.doc, blockId);
  if (!hit || hit.block.type !== "slide_deck") throw new ToolError(`No slide deck with id ${blockId}.`);
  return { block: hit.block, lessonId: hit.lesson.id };
}

/**
 * Resolve the deck to author a batch into. A valid `blockId` is used directly;
 * `null` (or a stale/wrong id) falls back to the docked lesson's FIRST slide deck,
 * creating an empty one if the lesson has none. This makes batch authoring robust
 * to a model that can't perfectly echo the (server-generated) deck id — it just
 * targets "this lesson's deck".
 */
function resolveDeck(
  ctx: ToolContext,
  blockId: string | null
): { deckId: string; lessonId: string; themeId: SlideThemeId; createPatch?: CoursePatch } {
  if (blockId) {
    const hit = findBlock(ctx.doc, blockId);
    if (hit && hit.block.type === "slide_deck") {
      return { deckId: blockId, lessonId: hit.lesson.id, themeId: deckThemeId(hit.block, ctx) };
    }
  }
  const lesson = findLesson(ctx.doc, ctx.lessonId)?.lesson;
  if (!lesson) throw new ToolError(`No lesson ${ctx.lessonId} to add slides to.`);
  const existing = lesson.blocks.find((b): b is SlideDeckBlock => b.type === "slide_deck");
  if (existing) return { deckId: existing.id, lessonId: lesson.id, themeId: deckThemeId(existing, ctx) };
  // No deck yet — create an EMPTY one in the same batch (never a placeholder).
  const createPatch = addBlockPatch(lesson.id, "slide_deck", undefined, { emptySlideDeck: true });
  const deckId = createPatch.action === "ADD_BLOCK" ? createPatch.block.id : "";
  return { deckId, lessonId: lesson.id, themeId: ctx.doc.theme.slideDefaults.themeId, createPatch };
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
    "Add a BATCH of designed (structured) slides in ONE call — author a whole pedagogical SEGMENT at once (e.g. hook+concept, or a worked example, or practice+recap) rather than one slide per call. Pass the lesson's slide-deck blockId as deckBlockId (or null to target this lesson's deck). Each entry is a full structured slide (pick the layoutId whose shape fits the content), plus optional speaker notes and the plan slideSpecId it satisfies. Keep copy tight, but DON'T worry about exact lengths: any slot that runs slightly long is AUTO-SHORTENED server-side and the slide is still saved — formatting is never bounced back to you. Every valid slide is SAVED independently; only a slide that's missing required content comes back. Author 1–4 per batch (one segment at a time) and strongly prefer this over repeated add_structured_slide calls.",
  // Validate + CLAMP per-slide inside execute so one over-long slot can't drop the
  // whole segment (the model schema is still the strict per-slide template).
  lenientArgs: true,
  params: z.object({
    deckBlockId: z.string().nullable(),
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
  execute(rawArgs, ctx) {
    const args = rawArgs as { deckBlockId?: string | null; slides?: unknown };
    const rawSlides = Array.isArray(args.slides) ? args.slides : [];
    if (rawSlides.length === 0) throw new ToolError("add_structured_slides_batch needs a non-empty `slides` array.");

    const { deckId, lessonId, themeId, createPatch } = resolveDeck(ctx, args.deckBlockId ?? null);
    const patches: CoursePatch[] = [];
    const slidesAdded: { slideId: string; specId?: string; index: number }[] = [];
    const clampedSlides: { index: number; slideSpecId?: string; shortened: string[] }[] = [];
    const failed: { index: number; slideSpecId?: string; errors: string }[] = [];

    rawSlides.forEach((entry, i) => {
      const e = (entry ?? {}) as { slideSpecId?: string | null; template?: unknown; notes?: string | null };
      // CLAMP-not-reject: over-length slots are auto-shortened + the slide saved.
      // Only a template that's invalid for a non-length reason (missing required
      // content / too few items) is unsaveable and comes back.
      const res = clampStructuredTemplate(e.template);
      if (!res.template) {
        failed.push({ index: i, slideSpecId: e.slideSpecId ?? undefined, errors: res.error ?? "invalid template" });
        return;
      }
      const slide = createStructuredSlide(res.template.layoutId, themeId);
      slide.template = res.template;
      if (typeof e.notes === "string" && e.notes.trim()) slide.speakerNotes = e.notes.trim();
      if (typeof e.slideSpecId === "string" && e.slideSpecId.trim()) slide.ai.specId = e.slideSpecId.trim();
      patches.push({ action: "ADD_SLIDE", blockId: deckId, slide });
      slidesAdded.push({ slideId: slide.id, specId: e.slideSpecId ?? undefined, index: i });
      if (res.clamped) clampedSlides.push({ index: i, slideSpecId: e.slideSpecId ?? undefined, shortened: res.clampedPaths });
    });

    // Only materialize a fresh deck if at least one slide actually lands in it.
    if (createPatch && slidesAdded.length > 0) patches.unshift(createPatch);

    const addedN = slidesAdded.length;
    const failedN = failed.length;
    const clampedN = clampedSlides.length;
    const parts = [`Added ${addedN} structured slide${addedN === 1 ? "" : "s"}`];
    if (clampedN) parts.push(`${clampedN} auto-shortened to fit`);
    const summary =
      failedN === 0
        ? clampedN
          ? `${parts[0]} (${parts[1]})`
          : parts[0]
        : `${parts[0]}${clampedN ? ` (${parts[1]})` : ""}; ${failedN} couldn't be built (missing content) — re-send those`;
    return {
      summary,
      patches,
      data: {
        blockId: deckId,
        lessonId,
        blockType: "slide_deck",
        slidesAdded,
        // Non-blocking note: slides that saved but had a slot trimmed to fit.
        ...(clampedN ? { autoShortened: clampedSlides } : {}),
        // Only genuinely-unsaveable slides (missing required content) come back.
        ...(failedN
          ? {
              failed: failed.map((f) => ({
                index: f.index,
                slideSpecId: f.slideSpecId,
                fix: `Re-send ONLY this slide with the missing content filled in: ${f.errors}`,
              })),
            }
          : {}),
      },
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

/* ─────────────────────────── Programmatic diagrams ────────────────────── */

const DiagramRoleEnum = z.enum(VISUAL_ROLES);
const DiagramTemplateEnum = z.enum(DIAGRAM_TEMPLATE_IDS as [string, ...string[]]);

/** Accuracy-critical kinds: a wrong shape/label here actively MISLEADS, so these
 *  are flagged for hard validation. */
function accuracyCriticalKind(d: DiagramSpec): boolean {
  if (d.kind === "supply_demand") return true;
  if (d.kind === "graph_diagram") return true;
  if (d.kind === "array_diagram") return !!d.sorted; // binary search
  return false;
}

const rt = (s: string): RichText => ({ text: s.trim() });

/** Shared content-builder for add_diagram / set_diagram: resolve the diagram
 *  (custom or seeded from a template), validate it deterministically, and wrap it
 *  in a DiagramContent with a complete VisualSpec (source = programmatic). */
function buildDiagramContent(args: {
  title: string;
  caption: string | null;
  takeaways: string[] | null;
  role: (typeof VISUAL_ROLES)[number];
  pedagogicalPurpose: string;
  altText: string;
  reason: string | null;
  templateId: string | null;
  diagram: DiagramSpec | null;
}): DiagramContent {
  let diagram: DiagramSpec;
  let templateCritical: boolean | undefined;
  if (args.diagram) {
    diagram = args.diagram;
  } else if (args.templateId) {
    const tpl = findDiagramTemplate(args.templateId);
    if (!tpl) throw new ToolError(`Unknown diagram template "${args.templateId}". Valid: ${DIAGRAM_TEMPLATE_IDS.join(", ")}.`);
    diagram = tpl.seed();
    templateCritical = tpl.accuracyCritical;
  } else {
    throw new ToolError("Provide a templateId (recommended for canonical diagrams) OR a custom `diagram`.");
  }
  const errs = validateDiagram(diagram);
  if (errs.length) throw new ToolError(`That diagram isn't valid: ${errs.join("; ")}`);

  if (!args.altText.trim()) throw new ToolError("Every visual needs alt text.");
  const takeaways = (args.takeaways ?? []).map((t) => t.trim()).filter(Boolean).map(rt);
  const spec: VisualSpec = {
    role: args.role,
    pedagogicalPurpose: args.pedagogicalPurpose.trim(),
    altText: args.altText.trim(),
    requiredElements: diagramRequiredElements(diagram),
    placement: takeaways.length ? "left" : "center",
    source: "programmatic",
    mustBeAccurate: templateCritical ?? accuracyCriticalKind(diagram),
    reason: args.reason?.trim() || undefined,
  };
  return {
    title: rt(args.title),
    caption: args.caption?.trim() ? rt(args.caption) : undefined,
    takeaways: takeaways.length ? takeaways : undefined,
    spec,
    diagram,
  };
}

const diagramParams = {
  title: z.string().describe("Slide title."),
  caption: z.string().nullable().describe("The teaching takeaway under the visual — what the learner should NOTICE. 1–2 sentences."),
  takeaways: z.array(z.string()).nullable().describe("Optional 0–4 key points shown beside the diagram."),
  role: DiagramRoleEnum.describe("The pedagogical job this visual does (graph / concept_diagram / tree_or_graph / flowchart / data_chart / …)."),
  pedagogicalPurpose: z.string().describe("WHY this visual earns its place — the teaching it enables."),
  altText: z.string().describe("Accessible description of the visual (required)."),
  reason: z.string().nullable().describe("Human-facing justification: 'added because …'."),
  templateId: DiagramTemplateEnum.nullable().describe(`Catalog template to seed an ACCURATE diagram from (recommended for canonical visuals): ${DIAGRAM_TEMPLATE_IDS.join(", ")}.`),
  diagram: DiagramSpecInputSchema.nullable().describe(`A custom diagram (overrides templateId). Pick a kind: ${DIAGRAM_KINDS.join(", ")}.`),
} as const;

const DIAGRAM_TOOL_HINT =
  "Add a programmatic teaching VISUAL — a diagram/graph the renderer draws as crisp, ACCURATE SVG (supply & demand, a plot, a bar chart, an array with pointers, a tree, a node-link graph, a flowchart, a number line, a Venn). Use it ONLY when a diagram materially improves teaching (a topic conventionally taught with a graph; a structure/process/relationship; a worked example that benefits from visual tracing) — never as decoration. Prefer a templateId for canonical diagrams (the geometry is then correct by construction); supply a custom `diagram` otherwise. Every visual REQUIRES alt text + a pedagogical purpose.";

const addDiagram = defineTool({
  name: "add_diagram",
  description: DIAGRAM_TOOL_HINT + " Pass the lesson's slide-deck blockId (or null to target this lesson's deck) and, if it satisfies a plan spec, its slideSpecId.",
  params: z.object({
    deckBlockId: z.string().nullable(),
    slideSpecId: z.string().nullable(),
    position: z.number().int().nullable(),
    ...diagramParams,
  }),
  execute(args, ctx) {
    const { deckId, lessonId, themeId, createPatch } = resolveDeck(ctx, args.deckBlockId);
    const content = buildDiagramContent({ ...args, diagram: (args.diagram ?? null) as DiagramSpec | null });
    const slide = createStructuredSlide("diagram", themeId);
    slide.template = { layoutId: "diagram", content };
    if (args.slideSpecId && args.slideSpecId.trim()) slide.ai.specId = args.slideSpecId.trim();
    const patches: CoursePatch[] = [];
    if (createPatch) patches.push(createPatch);
    patches.push({ action: "ADD_SLIDE", blockId: deckId, slide, ...(args.position != null ? { atIndex: args.position } : {}) });
    return {
      summary: `Added a ${content.diagram.kind} diagram`,
      patches,
      data: { slideId: slide.id, blockId: deckId, lessonId, blockType: "slide_deck", diagramKind: content.diagram.kind },
    };
  },
});

const setDiagram = defineTool({
  name: "set_diagram",
  description: "Convert ONE existing slide into a programmatic diagram, or replace its diagram content. " + DIAGRAM_TOOL_HINT,
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    ...diagramParams,
  }),
  execute(args, ctx) {
    const hit = findSlide(ctx.doc, args.blockId, args.slideId);
    if (!hit) throw new ToolError(`Slide ${args.slideId} not found in deck ${args.blockId}.`);
    const content = buildDiagramContent({ ...args, diagram: (args.diagram ?? null) as DiagramSpec | null });
    return {
      summary: `Set a ${content.diagram.kind} diagram`,
      patches: [setSlideTemplatePatch(args.blockId, args.slideId, { layoutId: "diagram", content })],
      data: { slideId: args.slideId, blockId: args.blockId, lessonId: hit.lesson.id, blockType: "slide_deck", diagramKind: content.diagram.kind },
    };
  },
});

/** Count the illustration slides already in a lesson's decks (the per-lesson cap). */
function illustrationCount(ctx: ToolContext): number {
  const lesson = findLesson(ctx.doc, ctx.lessonId)?.lesson;
  if (!lesson) return 0;
  let n = 0;
  for (const b of lesson.blocks) {
    if (b.type !== "slide_deck") continue;
    for (const s of b.slides) if (s.template?.layoutId === "illustration") n += 1;
  }
  return n;
}

const addImage = defineTool({
  name: "add_image",
  description:
    "Add an educational ILLUSTRATION slide — an AI-generated image for a concept a picture conveys better than text when NO diagram type fits (a historical scene, a biological structure, a real-world analogy, an evocative concept image). The image is generated from your prompt and STORED automatically; you supply required alt text. Do NOT use this for anything accuracy-critical (a graph, chart, or labeled figure) — those MUST be a programmatic diagram (add_diagram). Keep prompts concrete and free of embedded text/labels (image models render text poorly).",
  params: z.object({
    deckBlockId: z.string().nullable(),
    slideSpecId: z.string().nullable(),
    prompt: z.string().describe("A concrete description of the illustration: the subject, the composition, the setting — NO embedded words/labels/captions in the image itself."),
    alt: z.string().describe("Required alt text describing the image for accessibility (and AI grounding)."),
    title: z.string().nullable().describe("Optional slide title above the image."),
    caption: z.string().nullable().describe("Optional caption under the image — what the learner should notice."),
  }),
  async execute(args, ctx) {
    if (!ctx.visuals) {
      throw new ToolError("Image generation is unavailable right now — teach this with a programmatic diagram (add_diagram) or in prose instead.");
    }
    if (!args.alt.trim()) throw new ToolError("add_image requires alt text.");
    if (illustrationCount(ctx) >= ctx.visuals.maxPerLesson) {
      throw new ToolError(`This lesson already has the maximum ${ctx.visuals.maxPerLesson} illustration(s) — use a diagram or prose for any further visuals.`);
    }

    const result = await ctx.visuals.generateIllustration({ prompt: args.prompt.trim(), alt: args.alt.trim() });
    if (!result) {
      throw new ToolError("Image generation didn't return an image — try a programmatic diagram (add_diagram) or teach this in prose.");
    }

    const { deckId, lessonId, themeId, createPatch } = resolveDeck(ctx, args.deckBlockId);
    const content: IllustrationContent = {
      imageUrl: result.url,
      alt: args.alt.trim(),
      title: args.title?.trim() ? rt(args.title) : undefined,
      caption: args.caption?.trim() ? rt(args.caption) : undefined,
      source: "ai_generated",
      storagePath: result.storagePath,
    };
    const slide = createStructuredSlide("illustration", themeId);
    slide.template = { layoutId: "illustration", content };
    if (args.slideSpecId && args.slideSpecId.trim()) slide.ai.specId = args.slideSpecId.trim();
    const patches: CoursePatch[] = [];
    if (createPatch) patches.push(createPatch);
    patches.push({ action: "ADD_SLIDE", blockId: deckId, slide });
    return {
      summary: "Generated an illustration",
      patches,
      data: { slideId: slide.id, blockId: deckId, lessonId, blockType: "slide_deck", source: "ai_generated" },
    };
  },
});

export const structuredSlideTools: Tool[] = [
  addStructuredSlide,
  addStructuredSlidesBatch,
  setStructuredSlide,
  setTextStyle,
  addSticker,
  addDiagram,
  setDiagram,
  addImage,
];
