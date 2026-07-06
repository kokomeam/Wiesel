/**
 * Zod for the diagram model. TWO schemas, same split as the rest of the
 * structured-layout system:
 *
 *  - STRICT (AI input + the validate→repair boundary): every label is length-
 *    capped, every array count-bounded, and a `.superRefine` runs the
 *    deterministic `validateDiagram` correctness check (supply slopes up, a
 *    binary-search array is sorted, a weighted graph weights every edge, …). The
 *    strict schema IS the tool's parameter schema, so a malformed diagram comes
 *    back to the model as a readable error before it can ever render wrong.
 *  - STORAGE (permissive): no caps, so loading a persisted diagram never breaks.
 *
 * Pinned with `satisfies z.ZodType<…>` so the schemas can't silently drift from
 * the hand-written types.
 */

import { z } from "zod";
import type {
  CoordinatePlotDiagram,
  DiagramContent,
  DiagramSpec,
  SupplyDemandDiagram,
  TreeNode,
  VisualSpec,
} from "./types";
import { VISUAL_ROLES } from "./types";
import { validateDiagram } from "./validate";

/* ── Strict AI-input helpers (mirrors structuredLayouts.ts: optional marks come
   in as nullable from the strict tool schema, normalized to "absent" here). ── */
const aiMarkBool = z.boolean().nullish().transform((v) => v ?? undefined);
const aiMarkColor = z.string().nullish().transform((v) => v ?? undefined);
const AiTextRunSchema = z.object({
  text: z.string(),
  marks: z.object({ bold: aiMarkBool, italic: aiMarkBool, underline: aiMarkBool, color: aiMarkColor }).optional(),
});
function rich(max: number, hint: string) {
  return z
    .object({
      text: z.string().min(1).max(max, `Keep this ≤ ${max} characters. Shorten it.`),
      runs: z.array(AiTextRunSchema).optional(),
    })
    .describe(hint);
}
const label = (max: number, hint: string) => z.string().min(1).max(max).describe(hint);
const hex = z.string().describe("Optional hex color like '#ea580c'; omit to use the theme accent.");

/* ─────────────────────── Strict per-kind diagram schemas ───────────────── */

const SupplyDemandLineSchema = z.object({
  leftY: z.number().min(0).max(1).describe("Price (0=bottom … 1=top) at the LEFT edge (quantity 0)."),
  rightY: z.number().min(0).max(1).describe("Price (0 … 1) at the RIGHT edge (max quantity)."),
});

const SupplyDemandSchema = z.object({
  kind: z.literal("supply_demand"),
  xLabel: label(20, "X-axis label; defaults to 'Quantity'.").optional(),
  yLabel: label(20, "Y-axis label; defaults to 'Price'.").optional(),
  supply: SupplyDemandLineSchema.describe("UPWARD-sloping supply curve: rightY MUST be greater than leftY."),
  demand: SupplyDemandLineSchema.describe("DOWNWARD-sloping demand curve: rightY MUST be less than leftY."),
  equilibriumLabel: label(6, "Label for the equilibrium point, e.g. 'E'.").optional(),
  priceLabel: label(8, "Label for the equilibrium price, e.g. 'P*'.").optional(),
  quantityLabel: label(8, "Label for the equilibrium quantity, e.g. 'Q*'.").optional(),
  intervention: z
    .object({
      kind: z.enum(["price_ceiling", "price_floor"]),
      level: z.number().min(0).max(1).describe("Regulated price as 0…1. A binding ceiling sits BELOW, a binding floor ABOVE, equilibrium."),
      label: label(16, "Label for the regulated-price line.").optional(),
    })
    .optional()
    .describe("Add a price ceiling or floor line + the shortage/surplus it creates."),
}) satisfies z.ZodType<SupplyDemandDiagram>;

const PlotPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  label: label(24, "Optional point label.").optional(),
});
const AxisRangeSchema = z.object({ min: z.number(), max: z.number() });
const CoordinatePlotSchema = z.object({
  kind: z.literal("coordinate_plot"),
  xLabel: label(28, "X-axis label."),
  yLabel: label(28, "Y-axis label."),
  xRange: AxisRangeSchema.describe("X-axis range; min < max."),
  yRange: AxisRangeSchema.describe("Y-axis range; min < max."),
  series: z
    .array(
      z.object({
        label: label(28, "Series label (shown in the legend)."),
        points: z.array(PlotPointSchema).min(1).max(60).describe("Data points in x-order. A line needs ≥2."),
        style: z.enum(["line", "scatter", "dashed"]).optional(),
        color: hex.optional(),
      })
    )
    .min(1)
    .max(4)
    .describe("1–4 plotted series."),
  markers: z.array(z.object({ x: z.number(), y: z.number(), label: label(24, "Marker label.") })).max(6).optional(),
  shaded: z
    .object({ seriesIndex: z.number().int(), fromX: z.number(), toX: z.number(), label: label(24, "Region label.").optional() })
    .optional()
    .describe("Shade the area under one series between two x-values (a region / integral)."),
}) satisfies z.ZodType<CoordinatePlotDiagram>;

/* NOTE: the 7 other diagram kinds (bar_chart, array_diagram, tree_diagram,
 * graph_diagram, flowchart, number_line, venn) were RETIRED from the AI-authoring
 * surface (2026-06-25). They are no longer in the strict input union below, so the
 * model can't author them — those visuals are now generated images (image_reference
 * / image_supporting). The permissive STORAGE schema below KEEPS all 9 kinds so any
 * already-saved diagram still loads/renders/reverts. The runtime allowlist guard in
 * lib/course/diagram/repair.ts blocks a removed kind on the lenient add_diagram path. */

/** The strict diagram union (the two ACCURATE-by-construction kinds only), with the
 *  deterministic correctness gate attached: the `.superRefine` runs `validateDiagram`,
 *  so a wrong shape (demand sloping up, an out-of-range plot) is rejected with the
 *  same message the test suite asserts. */
export const DiagramSpecInputSchema = z
  .discriminatedUnion("kind", [SupplyDemandSchema, CoordinatePlotSchema])
  .superRefine((spec, ctx) => {
    for (const message of validateDiagram(spec as DiagramSpec)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

/* ───────────────────────────── Visual spec ────────────────────────────── */

const VISUAL_PLACEMENTS = ["left", "right", "center", "full_width", "background", "inline"] as const;

/** AI-input visual spec — OMITS `source` (the tool/renderer default it to
 *  "programmatic"; the model never picks a source). */
export const VisualSpecInputSchema = z.object({
  role: z.enum(VISUAL_ROLES).describe("The pedagogical job this visual does."),
  pedagogicalPurpose: z.string().min(1).max(220).describe("WHY this visual earns its place — the teaching it enables."),
  altText: z.string().min(1).max(320).describe("Accessible description of the visual (required)."),
  requiredElements: z.array(z.string().max(60)).max(8).optional().describe("What the visual MUST show to do its job."),
  placement: z.enum(VISUAL_PLACEMENTS).optional(),
  mustBeAccurate: z.boolean().optional().describe("True when label/number/shape accuracy is correctness-critical."),
  reason: z.string().max(220).optional().describe("Human-facing justification: 'added because …'."),
});

/** STRICT diagram-slide content (AI tool param + structured-layout registry
 *  schema). `spec.source` is injected by the tool/renderer, not the model. */
export const DiagramContentInputSchema = z.object({
  title: rich(60, "Slide title: ≤ ~9 words."),
  caption: rich(160, "The teaching takeaway under the visual — what the learner should NOTICE. 1–2 sentences.").optional(),
  takeaways: z.array(rich(120, "A key point beside the diagram — a full clause.")).max(4).optional().describe("Optional 0–4 points shown beside the diagram."),
  spec: VisualSpecInputSchema,
  diagram: DiagramSpecInputSchema,
});

export type DiagramContentInput = z.infer<typeof DiagramContentInputSchema>;

/** Add the implicit `source: "programmatic"` to a model-authored spec → the full
 *  DiagramContent the document stores. */
export function toDiagramContent(input: DiagramContentInput): DiagramContent {
  return {
    title: input.title,
    caption: input.caption,
    takeaways: input.takeaways,
    spec: { ...input.spec, source: "programmatic" } as VisualSpec,
    diagram: input.diagram as DiagramSpec,
  };
}

/* ───────────────────────── Permissive STORAGE schema ──────────────────── */

const RichStore = z.object({ text: z.string(), runs: z.array(z.object({ text: z.string(), marks: z.any().optional() })).optional() });
const lblStore = z.string();
const TreeNodeStore: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({ label: z.string(), children: z.array(TreeNodeStore).optional(), highlight: z.boolean().optional() })
);

/** Permissive diagram-spec storage (no caps) — pinned to the type so it stays in
 *  sync but never rejects a persisted diagram. */
export const DiagramSpecStorageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("supply_demand"),
    xLabel: lblStore.optional(),
    yLabel: lblStore.optional(),
    supply: z.object({ leftY: z.number(), rightY: z.number() }),
    demand: z.object({ leftY: z.number(), rightY: z.number() }),
    equilibriumLabel: lblStore.optional(),
    priceLabel: lblStore.optional(),
    quantityLabel: lblStore.optional(),
    intervention: z.object({ kind: z.enum(["price_ceiling", "price_floor"]), level: z.number(), label: lblStore.optional() }).optional(),
  }),
  z.object({
    kind: z.literal("coordinate_plot"),
    xLabel: lblStore,
    yLabel: lblStore,
    xRange: z.object({ min: z.number(), max: z.number() }),
    yRange: z.object({ min: z.number(), max: z.number() }),
    series: z.array(z.object({ label: lblStore, points: z.array(z.object({ x: z.number(), y: z.number(), label: lblStore.optional() })), style: z.enum(["line", "scatter", "dashed"]).optional(), color: lblStore.optional() })),
    markers: z.array(z.object({ x: z.number(), y: z.number(), label: lblStore })).optional(),
    shaded: z.object({ seriesIndex: z.number(), fromX: z.number(), toX: z.number(), label: lblStore.optional() }).optional(),
  }),
  z.object({
    kind: z.literal("bar_chart"),
    xLabel: lblStore.optional(),
    yLabel: lblStore.optional(),
    bars: z.array(z.object({ label: lblStore, value: z.number(), color: lblStore.optional() })),
    maxValue: z.number().optional(),
  }),
  z.object({
    kind: z.literal("array_diagram"),
    values: z.array(lblStore),
    showIndices: z.boolean().optional(),
    sorted: z.boolean().optional(),
    pointers: z.array(z.object({ index: z.number(), label: lblStore, color: lblStore.optional() })).optional(),
    window: z.object({ from: z.number(), to: z.number(), label: lblStore.optional() }).optional(),
    marks: z.array(z.object({ index: z.number(), kind: z.enum(["target", "found", "visited", "eliminated"]) })).optional(),
  }),
  z.object({ kind: z.literal("tree_diagram"), root: TreeNodeStore, variant: z.enum(["binary", "nary"]).optional(), highlightOrder: z.array(lblStore).optional() }),
  z.object({
    kind: z.literal("graph_diagram"),
    directed: z.boolean().optional(),
    weighted: z.boolean().optional(),
    nodes: z.array(z.object({ id: lblStore, label: lblStore.optional(), x: z.number().optional(), y: z.number().optional() })),
    edges: z.array(z.object({ from: lblStore, to: lblStore, weight: z.number().optional(), label: lblStore.optional(), highlight: z.boolean().optional() })),
    highlightPath: z.array(lblStore).optional(),
  }),
  z.object({
    kind: z.literal("flowchart"),
    nodes: z.array(z.object({ id: lblStore, label: lblStore, kind: z.enum(["start", "process", "decision", "io", "end"]) })),
    edges: z.array(z.object({ from: lblStore, to: lblStore, label: lblStore.optional() })),
  }),
  z.object({
    kind: z.literal("number_line"),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    points: z.array(z.object({ value: z.number(), label: lblStore.optional(), color: lblStore.optional() })).optional(),
    intervals: z.array(z.object({ from: z.number(), to: z.number(), label: lblStore.optional(), closedLeft: z.boolean().optional(), closedRight: z.boolean().optional() })).optional(),
  }),
  z.object({ kind: z.literal("venn"), aLabel: lblStore, bLabel: lblStore, aOnly: lblStore.optional(), bOnly: lblStore.optional(), both: lblStore.optional() }),
]) satisfies z.ZodType<DiagramSpec>;

const VisualSpecStorageSchema = z.object({
  role: z.enum(VISUAL_ROLES),
  pedagogicalPurpose: z.string(),
  altText: z.string(),
  requiredElements: z.array(z.string()).optional(),
  placement: z.enum(VISUAL_PLACEMENTS).optional(),
  source: z.enum(["programmatic", "ai_generated", "web", "upload"]).optional(),
  mustBeAccurate: z.boolean().optional(),
  reason: z.string().optional(),
}) satisfies z.ZodType<VisualSpec>;

export const DiagramContentStorageSchema = z.object({
  title: RichStore,
  caption: RichStore.optional(),
  takeaways: z.array(RichStore).optional(),
  spec: VisualSpecStorageSchema,
  diagram: DiagramSpecStorageSchema,
}) satisfies z.ZodType<DiagramContent>;
