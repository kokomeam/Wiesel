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
import { DiagramSpecInputSchema, DiagramSpecStorageSchema } from "@/lib/course/diagram/schemas";
import { coerceDiagramBestEffort } from "@/lib/course/diagram/repair";
import { DIAGRAM_KINDS, VISUAL_ROLES, type DiagramContent, type DiagramSpec, type VisualSpec } from "@/lib/course/diagram/types";
import { diagramRequiredElements, diagramSummary } from "@/lib/course/diagram/validate";
import { createStructuredSlide } from "@/lib/course/factories";
import type { CoursePatch } from "@/lib/course/patches";
import { findBlock, findLesson, findSlide } from "@/lib/course/queries";
import { FontFamilyIdSchema, FontScaleSchema } from "@/lib/course/schemas";
import { clampStructuredTemplate, normalizeAgentNulls, type StructuredClampResult } from "@/lib/course/slide/clampStructured";
import { STICKER_IDS } from "@/lib/course/slide/stickers";
import { StructuredTemplateInputSchema } from "@/lib/course/slide/structuredLayouts";
import type { ElementStyle, IllustrationContent, ProseContent, RichText, SlideDeckBlock, SlideTemplate, SlideThemeId } from "@/lib/course/types";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";
import { debugAgent, previewJson } from "../debugLog";

const StickerIdEnum = z.enum(STICKER_IDS as [string, ...string[]]);

/**
 * DIAGNOSTIC: log the ACTUAL reason a structured slide was rejected as "missing
 * content" — the raw Zod failure (field + message, NOT the summarized string), the
 * payload the author produced (to see if fields are empty / malformed / cut off),
 * the spec it was fulfilling + whether that spec exists with real points. This is
 * the visibility the telemetry lacked. (Logging only — no behavior change.)
 */
function logSlideReject(
  ctx: ToolContext,
  info: { tool: string; index: number | null; slideSpecId: string | null; template: unknown; error: string | undefined }
): void {
  const specId = (info.slideSpecId ?? "").trim();
  const { preview, length } = previewJson(info.template);
  debugAgent("slide_reject", {
    tool: info.tool,
    index: info.index,
    slideSpecId: specId || null,
    planSpecExists: !!specId && (ctx.planSpecIds ?? []).includes(specId),
    planSpecPointCount: specId ? (ctx.planSpecPoints?.[specId] ?? null) : null,
    layoutId: ((info.template ?? {}) as { layoutId?: unknown }).layoutId ?? null,
    zodError: info.error ?? "(no detail)", // the REAL field+message, not "missing content"
    payloadLength: length,
    payloadPreview: preview,
  });
}

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
    "Add ONE DESIGNED (structured) slide. Pick the layoutId whose shape matches the content (see the layout catalog): e.g. a process → process_steps, a definition → key_concept, key numbers → metrics_overview, code → code_walkthrough_steps, 2–3 options compared with a few traits each → comparison_columns, options compared across several shared dimensions → comparison_matrix. Fill every slot, keep copy tight and scannable (cards auto-fit — over-long text is shortened, never bounced). The renderer owns all arrangement, colors, badges, arrows, numbering, and reflow; you only fill slots.",
  lenientArgs: true,
  params: z.object({
    blockId: z.string(),
    position: z.number().int().nullable(),
    template: StructuredTemplateInputSchema,
    notes: z.string().nullable(),
  }),
  execute(rawArgs, ctx) {
    const o = (rawArgs ?? {}) as { blockId?: unknown; position?: unknown; template?: unknown; notes?: unknown };
    const blockId = typeof o.blockId === "string" ? o.blockId : "";
    const { block, lessonId } = deck(ctx, blockId);
    const res = bestEffortTemplate(o.template);
    if (!res.template) {
      logSlideReject(ctx, { tool: "add_structured_slide", index: null, slideSpecId: null, template: o.template, error: res.error });
      throw new ToolError(`Couldn't build that slide: ${res.error ?? "missing required content"}.`);
    }
    const slide = createStructuredSlide(res.template.layoutId, deckThemeId(block, ctx));
    slide.template = res.template;
    if (typeof o.notes === "string" && o.notes.trim()) slide.speakerNotes = o.notes.trim();
    const position = typeof o.position === "number" ? o.position : null;
    const patch: CoursePatch = {
      action: "ADD_SLIDE",
      blockId,
      slide,
      ...(position != null ? { atIndex: position } : {}),
    };
    return {
      summary: `Added a ${res.template.layoutId} slide${res.clamped ? " (auto-shortened to fit)" : ""}`,
      patches: [patch],
      data: { slideId: slide.id, blockId, lessonId, blockType: "slide_deck" },
    };
  },
});

const addStructuredSlidesBatch = defineTool({
  name: "add_structured_slides_batch",
  description:
    "Author the lesson's slides in ONE call — pass ALL of the planned slides for the deck here at once (not one per call, and not a segment at a time). Pass the lesson's slide-deck blockId as deckBlockId (or null to target this lesson's deck). Each entry is a full structured slide (pick the layoutId whose shape fits the content), plus optional speaker notes and the plan slideSpecId it satisfies. Keep each card tight and scannable — short headings, 1–2-sentence bodies — but DON'T worry about exact lengths: a slot that runs long is AUTO-SHORTENED server-side and the slide is still saved (cards also grow to fit), so formatting is never bounced back. Every valid slide is SAVED independently; only a slide missing required content comes back. For a programmatic graph/diagram, prefer the dedicated add_diagram tool.",
  // Validate + CLAMP per-slide inside execute so one over-long slot can't drop the
  // whole batch (the model schema is still the strict per-slide template).
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
      .max(24, "Author the whole deck in one batch — up to ~24 slides."),
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

    // DETERMINISTIC spec-id stamping (FIX 1.3): if the deck is the plan's deck, every
    // authored slide is stamped with a plan spec id — the model's, when it's a valid
    // unclaimed plan spec; otherwise the NEXT unclaimed plan spec in plan order. This
    // makes "generated N / covered 0 / extra N" impossible when slides correspond to
    // specs. No plan context (edit path) ⇒ the model's id is honored unchanged.
    const planSpecIds = ctx.planSpecIds ?? [];
    const planSet = new Set(planSpecIds);
    const claimed = new Set<string>();
    const existingDeck = findBlock(ctx.doc, deckId)?.block;
    if (existingDeck && existingDeck.type === "slide_deck") {
      for (const s of existingDeck.slides) if (s.ai?.specId) claimed.add(s.ai.specId);
    }
    const nextUnclaimed = (): string | undefined => planSpecIds.find((id) => !claimed.has(id));

    rawSlides.forEach((entry, i) => {
      const e = (entry ?? {}) as { slideSpecId?: string | null; template?: unknown; notes?: string | null };
      // CLAMP-not-reject: over-length slots are auto-shortened + the slide saved; a
      // `diagram` entry is routed through the best-effort diagram builder so a
      // slightly-off shape is fixed in code, not bounced. Only a template invalid
      // for a non-length reason (missing required content) is unsaveable.
      const res = bestEffortTemplate(e.template);
      if (!res.template) {
        logSlideReject(ctx, { tool: "add_structured_slides_batch", index: i, slideSpecId: e.slideSpecId ?? null, template: e.template, error: res.error });
        failed.push({ index: i, slideSpecId: e.slideSpecId ?? undefined, errors: res.error ?? "invalid template" });
        return;
      }
      const slide = createStructuredSlide(res.template.layoutId, themeId);
      slide.template = res.template;
      if (typeof e.notes === "string" && e.notes.trim()) slide.speakerNotes = e.notes.trim();
      const provided = typeof e.slideSpecId === "string" ? e.slideSpecId.trim() : "";
      let specId: string;
      if (planSpecIds.length === 0) specId = provided; // edit path — honor as-is
      else if (provided && planSet.has(provided) && !claimed.has(provided)) specId = provided;
      else specId = nextUnclaimed() ?? ""; // missing / not-a-spec / duplicate → next unclaimed
      if (specId) {
        slide.ai.specId = specId;
        claimed.add(specId);
      }
      patches.push({ action: "ADD_SLIDE", blockId: deckId, slide });
      slidesAdded.push({ slideId: slide.id, specId: specId || undefined, index: i });
      if (res.clamped) clampedSlides.push({ index: i, slideSpecId: specId || undefined, shortened: res.clampedPaths });
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
    "Convert ONE existing slide into a designed (structured) layout, or replace its structured content. Other slides untouched. Over-long copy auto-fits, never bounces.",
  lenientArgs: true,
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    template: StructuredTemplateInputSchema,
  }),
  execute(rawArgs, ctx) {
    const o = (rawArgs ?? {}) as { blockId?: unknown; slideId?: unknown; template?: unknown };
    const blockId = typeof o.blockId === "string" ? o.blockId : "";
    const slideId = typeof o.slideId === "string" ? o.slideId : "";
    const hit = findSlide(ctx.doc, blockId, slideId);
    if (!hit) throw new ToolError(`Slide ${slideId} not found in deck ${blockId}.`);
    const res = bestEffortTemplate(o.template);
    if (!res.template) {
      logSlideReject(ctx, { tool: "set_structured_slide", index: null, slideSpecId: null, template: o.template, error: res.error });
      throw new ToolError(`Couldn't build that slide: ${res.error ?? "missing required content"}.`);
    }
    return {
      summary: `Set the ${res.template.layoutId} layout${res.clamped ? " (auto-shortened to fit)" : ""}`,
      patches: [setSlideTemplatePatch(blockId, slideId, res.template)],
      data: { slideId, blockId, lessonId: hit.lesson.id, blockType: "slide_deck" },
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

interface DiagramFields {
  title: string;
  caption: string | null;
  takeaways: string[] | null;
  role: (typeof VISUAL_ROLES)[number];
  pedagogicalPurpose: string;
  altText: string;
  reason: string | null;
  templateId: string | null;
  diagram: DiagramSpec | null;
}

/** Read diagram fields DEFENSIVELY from raw (lenient) args — never rejects for
 *  shape. Handles BOTH shapes: the add_diagram tool args (role/purpose/alt at the
 *  top level) and a batch's diagram-slide CONTENT (those fields under `spec`). The
 *  diagram itself is parsed with the PERMISSIVE storage schema (no superRefine), so
 *  a semantically-off diagram is captured here and fixed downstream, not bounced. */
function readDiagramFields(raw: unknown): DiagramFields {
  const o = (raw ?? {}) as Record<string, unknown>;
  const spec = (o.spec && typeof o.spec === "object" ? (o.spec as Record<string, unknown>) : o);
  // CAUSE 2: the agent often sends a diagram's title/caption/takeaways as rich-text
  // ENVELOPES ({ text, runs }) — like every other slot — not plain strings. Read the
  // inner `.text` so the content isn't lost (which left `body` empty → a false
  // "content.body.text: Too small" rejection / a blank prose degrade).
  const asText = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
    return "";
  };
  const s = (v: unknown) => asText(v);
  const sOrNull = (v: unknown) => { const t = asText(v).trim(); return t ? t : null; };
  const role = (typeof spec.role === "string" && (VISUAL_ROLES as readonly string[]).includes(spec.role) ? spec.role : "concept_diagram") as (typeof VISUAL_ROLES)[number];
  let diagram: DiagramSpec | null = null;
  if (o.diagram && typeof o.diagram === "object") {
    const parsed = DiagramSpecStorageSchema.safeParse(o.diagram);
    if (parsed.success) diagram = parsed.data;
  }
  return {
    title: s(o.title),
    caption: sOrNull(o.caption),
    takeaways: Array.isArray(o.takeaways) ? o.takeaways.map(asText).filter((t) => t.trim().length > 0) : null,
    role,
    pedagogicalPurpose: s(spec.pedagogicalPurpose),
    altText: s(spec.altText),
    reason: sOrNull(spec.reason),
    templateId: sOrNull(o.templateId),
    diagram,
  };
}

/** Build a DiagramContent from the model's REAL data — or `null` when there's no
 *  usable diagram (so the caller degrades to a prose slide). NEVER throws, NEVER a
 *  retry, and NEVER a placeholder/demo diagram: an explicit templateId seeds an
 *  accurate canonical diagram (the model's deliberate choice); a custom diagram is
 *  repaired (`coerceDiagramBestEffort`) and used only if it validates from real data,
 *  else `null`. Alt text + title are synthesized from the diagram if omitted. */
function buildBestEffortDiagramContent(f: DiagramFields): DiagramContent | null {
  let diagram: DiagramSpec;
  let templateCritical: boolean | undefined;
  const tpl = f.templateId ? findDiagramTemplate(f.templateId) : undefined;
  if (tpl) {
    diagram = tpl.seed();
    templateCritical = tpl.accuracyCritical;
  } else {
    const coerced = coerceDiagramBestEffort(f.diagram);
    if (!coerced) return null; // no real-data diagram → degrade to prose, not demo data
    diagram = coerced;
  }
  const altText = f.altText.trim() || diagramSummary(diagram);
  const takeaways = (f.takeaways ?? []).map((t) => t.trim()).filter(Boolean).map(rt);
  const spec: VisualSpec = {
    role: f.role,
    pedagogicalPurpose: f.pedagogicalPurpose.trim() || "A teaching visual for this concept.",
    altText,
    requiredElements: diagramRequiredElements(diagram),
    placement: takeaways.length ? "left" : "center",
    source: "programmatic",
    mustBeAccurate: templateCritical ?? accuracyCriticalKind(diagram),
    reason: f.reason ?? undefined,
  };
  return {
    title: rt(f.title || diagramSummary(diagram)),
    caption: f.caption ? rt(f.caption) : undefined,
    takeaways: takeaways.length ? takeaways : undefined,
    spec,
    diagram,
  };
}

/** A GRACEFUL degrade from a visual request to a real-text PROSE slide — used when
 *  the model supplied no usable diagram data (and no explicit templateId). The body
 *  is REAL teaching content the model wrote (the caption = "what to notice", or a
 *  takeaway) — NEVER the `pedagogicalPurpose` / `altText`, which are author-facing
 *  directives describing the visual, not the lesson (rendering those was the "Key
 *  idea: Show a concrete …" leak). When there's no real content, the body is left
 *  EMPTY so the slide fails to build (it's reported back) rather than rendering a
 *  directive as if it were teaching. NEVER invents a placeholder diagram. */
function proseDegradeTemplate(f: DiagramFields): SlideTemplate {
  const takeaways = (f.takeaways ?? []).map((x) => x.trim()).filter(Boolean);
  const body = (f.caption ?? "").trim() || takeaways[0] || "";
  const points = takeaways.filter((t) => t !== body).slice(0, 5).map(rt);
  const content: ProseContent = {
    title: rt(f.title.trim() || "Key idea"),
    body: rt(body),
    ...(points.length ? { points } : {}),
  };
  return { layoutId: "prose", content };
}

/** Build the slide template for a visual request: a real-data diagram, else a prose
 *  degrade — then clamp to schema. NO placeholder diagram, NO reject, NO retry. */
function bestEffortVisualTemplate(f: DiagramFields): StructuredClampResult {
  const content = buildBestEffortDiagramContent(f);
  const res = clampStructuredTemplate(content ? { layoutId: "diagram", content } : proseDegradeTemplate(f));
  // The AI-input spec schema OMITS `source`, so clamping strips it — re-stamp it
  // (a programmatic diagram is always `source: "programmatic"`).
  if (res.template && res.template.layoutId === "diagram") res.template.content.spec.source = "programmatic";
  return res;
}

/** Clamp a structured template to its schema, BUT route a `diagram` layout through
 *  the best-effort visual builder first (so a semantically-off diagram is repaired in
 *  code — or degraded to prose when its data is unusable — never bounced by the strict
 *  superRefine and never rendered as placeholder demo data).
 *
 *  FIRST normalizes the rich-text envelope nulls the agent emits for "no formatting"
 *  (`runs: null → []`, `marks: null → {}`, nested deep) so a fully-authored slide is
 *  never rejected on that technicality. This is the decisive "missing content" fix;
 *  it runs for the batch / set / add structured-slide tools (all route through here). */
function bestEffortTemplate(raw: unknown): StructuredClampResult {
  const normalized = normalizeAgentNulls(raw);
  const o = (normalized ?? {}) as { layoutId?: unknown; content?: unknown };
  if (o.layoutId === "diagram") {
    const content = (o.content ?? {}) as Record<string, unknown>;
    return bestEffortVisualTemplate(readDiagramFields(content));
  }
  return clampStructuredTemplate(normalized);
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
  "Add a programmatic teaching VISUAL — a diagram/graph the renderer draws as crisp, ACCURATE SVG (supply & demand, a plot, a bar chart, an array with pointers, a tree, a node-link graph, a flowchart, a number line, a Venn). Use it ONLY when a diagram materially improves teaching (a topic conventionally taught with a graph; a structure/process/relationship; a worked example that benefits from visual tracing) — never as decoration. Supply REAL, subject-specific data in a custom `diagram` (your actual numbers/nodes/edges); a templateId is only for the canonical STRUCTURAL diagrams (supply & demand, binary search, a tree/graph shape). The diagram is accepted BEST-EFFORT — a slightly-off shape is repaired automatically, never bounced — but it is NEVER rendered with placeholder/demo data: if its data is unusable it degrades to a prose slide. So give it real data, or teach the point in prose. Give alt text + a pedagogical purpose.";

const addDiagram = defineTool({
  name: "add_diagram",
  description: DIAGRAM_TOOL_HINT + " Pass the lesson's slide-deck blockId (or null to target this lesson's deck) and, if it satisfies a plan spec, its slideSpecId.",
  // Lenient: the diagram is built best-effort in execute (repaired / clamped /
  // template-fallback), so a malformed shape NEVER reshape-and-retries.
  lenientArgs: true,
  params: z.object({
    deckBlockId: z.string().nullable(),
    slideSpecId: z.string().nullable(),
    position: z.number().int().nullable(),
    ...diagramParams,
  }),
  execute(rawArgs, ctx) {
    const o = (rawArgs ?? {}) as Record<string, unknown>;
    const { deckId, lessonId, themeId, createPatch } = resolveDeck(ctx, typeof o.deckBlockId === "string" ? o.deckBlockId : null);
    const res = bestEffortVisualTemplate(readDiagramFields(o));
    if (!res.template) throw new ToolError("Couldn't build a slide for that visual — teach it in prose instead.");
    const slide = createStructuredSlide(res.template.layoutId, themeId);
    slide.template = res.template;
    const specId = typeof o.slideSpecId === "string" && o.slideSpecId.trim() ? o.slideSpecId.trim() : null;
    if (specId) slide.ai.specId = specId;
    const position = typeof o.position === "number" ? o.position : null;
    const patches: CoursePatch[] = [];
    if (createPatch) patches.push(createPatch);
    patches.push({ action: "ADD_SLIDE", blockId: deckId, slide, ...(position != null ? { atIndex: position } : {}) });
    const layoutId = res.template.layoutId;
    return {
      summary: res.template.layoutId === "diagram" ? `Added a ${res.template.content.diagram.kind} diagram` : "No usable diagram data — taught this point in prose instead",
      patches,
      data: { slideId: slide.id, blockId: deckId, lessonId, blockType: "slide_deck", layoutId },
    };
  },
});

const setDiagram = defineTool({
  name: "set_diagram",
  description: "Convert ONE existing slide into a programmatic diagram, or replace its diagram content. " + DIAGRAM_TOOL_HINT,
  lenientArgs: true,
  params: z.object({
    blockId: z.string(),
    slideId: z.string(),
    ...diagramParams,
  }),
  execute(rawArgs, ctx) {
    const o = (rawArgs ?? {}) as Record<string, unknown>;
    const blockId = typeof o.blockId === "string" ? o.blockId : "";
    const slideId = typeof o.slideId === "string" ? o.slideId : "";
    const hit = findSlide(ctx.doc, blockId, slideId);
    if (!hit) throw new ToolError(`Slide ${slideId} not found in deck ${blockId}.`);
    const res = bestEffortVisualTemplate(readDiagramFields(o));
    if (!res.template) throw new ToolError("Couldn't build a visual for that — teach it in prose instead.");
    const layoutId = res.template.layoutId;
    return {
      summary: res.template.layoutId === "diagram" ? `Set a ${res.template.content.diagram.kind} diagram` : "No usable diagram data — set this slide to prose instead",
      patches: [setSlideTemplatePatch(blockId, slideId, res.template)],
      data: { slideId, blockId, lessonId: hit.lesson.id, blockType: "slide_deck", layoutId },
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
