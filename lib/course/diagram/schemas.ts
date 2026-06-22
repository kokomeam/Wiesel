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
  ArrayDiagram,
  BarChartDiagram,
  CoordinatePlotDiagram,
  DiagramContent,
  DiagramSpec,
  FlowchartDiagram,
  GraphDiagram,
  NumberLineDiagram,
  SupplyDemandDiagram,
  TreeDiagram,
  TreeNode,
  VennDiagram,
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

const BarChartSchema = z.object({
  kind: z.literal("bar_chart"),
  xLabel: label(28, "Category-axis label.").optional(),
  yLabel: label(28, "Value-axis label.").optional(),
  bars: z
    .array(z.object({ label: label(24, "Bar label."), value: z.number(), color: hex.optional() }))
    .min(1)
    .max(8)
    .describe("1–8 bars."),
  maxValue: z.number().optional().describe("Optional fixed axis maximum; omit to derive from the data."),
}) satisfies z.ZodType<BarChartDiagram>;

const ArrayDiagramSchema = z.object({
  kind: z.literal("array_diagram"),
  values: z.array(label(8, "Cell value.")).min(1).max(16).describe("1–16 cell contents (numbers as strings are fine)."),
  showIndices: z.boolean().optional().describe("Show 0-based indices under the cells (default true)."),
  sorted: z.boolean().optional().describe("Mark the array as sorted. REQUIRED true for a binary-search diagram (it is then validated to be ascending)."),
  pointers: z
    .array(z.object({ index: z.number().int(), label: label(8, "Pointer label, e.g. 'lo'/'hi'/'mid'."), color: hex.optional() }))
    .max(4)
    .optional()
    .describe("0–4 pointer arrows under cells."),
  window: z
    .object({ from: z.number().int(), to: z.number().int(), label: label(20, "Window label.").optional() })
    .optional()
    .describe("Inclusive cell range to highlight (sliding window / search interval)."),
  marks: z
    .array(z.object({ index: z.number().int(), kind: z.enum(["target", "found", "visited", "eliminated"]) }))
    .max(16)
    .optional(),
}) satisfies z.ZodType<ArrayDiagram>;

// The AI-input tree node is FIXED-DEPTH (root + up to 3 levels), built bottom-up
// so it inlines into a JSON Schema with no recursive $ref (z.lazy can't be
// inlined). Deeper trees are rejected by validation → repaired. Storage keeps the
// truly-recursive z.lazy form below (storage is never JSON-Schema-converted). A
// 4-level tree is up to 15 binary nodes — ample for a teaching diagram.
const treeLeaf = z.object({
  label: label(16, "Node label."),
  highlight: z.boolean().optional().describe("Accent this node (a search path / chosen branch)."),
});
const treeLevel3 = treeLeaf.extend({ children: z.array(treeLeaf).max(6).optional().describe("Child nodes (≤6); omit for a leaf.") });
const treeLevel2 = treeLeaf.extend({ children: z.array(treeLevel3).max(6).optional().describe("Child nodes (≤6); omit for a leaf.") });
const TreeNodeInputSchema = treeLeaf.extend({ children: z.array(treeLevel2).max(6).optional().describe("Child nodes (≤6); omit for a leaf.") });
const TreeDiagramSchema = z.object({
  kind: z.literal("tree_diagram"),
  root: TreeNodeInputSchema,
  variant: z.enum(["binary", "nary"]).optional(),
  highlightOrder: z.array(label(16, "A node label, in visit order.")).max(20).optional().describe("Node labels in traversal order → numbered badges."),
}) satisfies z.ZodType<TreeDiagram>;

const GraphDiagramSchema = z.object({
  kind: z.literal("graph_diagram"),
  directed: z.boolean().optional(),
  weighted: z.boolean().optional().describe("If true, EVERY edge must carry a numeric weight (e.g. for Dijkstra)."),
  nodes: z
    .array(
      z.object({
        id: label(12, "Unique node id."),
        label: label(16, "Node label; defaults to the id.").optional(),
        x: z.number().min(0).max(1).optional().describe("Optional 0…1 position; omit to auto-place on a circle."),
        y: z.number().min(0).max(1).optional(),
      })
    )
    .min(1)
    .max(12)
    .describe("1–12 nodes."),
  edges: z
    .array(
      z.object({
        from: label(12, "Source node id."),
        to: label(12, "Target node id."),
        weight: z.number().optional().describe("Edge weight (required when weighted=true)."),
        label: label(16, "Optional edge label.").optional(),
        highlight: z.boolean().optional(),
      })
    )
    .max(24)
    .describe("Edges between node ids."),
  highlightPath: z.array(label(12, "A node id along the path.")).max(12).optional(),
}) satisfies z.ZodType<GraphDiagram>;

const FlowchartSchema = z.object({
  kind: z.literal("flowchart"),
  nodes: z
    .array(
      z.object({
        id: label(12, "Unique node id."),
        label: label(48, "Node text."),
        kind: z.enum(["start", "process", "decision", "io", "end"]),
      })
    )
    .min(2)
    .max(10)
    .describe("2–10 flow nodes (start → … → end)."),
  edges: z
    .array(z.object({ from: label(12, "Source id."), to: label(12, "Target id."), label: label(16, "Branch label, e.g. 'Yes'/'No'.").optional() }))
    .min(1)
    .max(16)
    .describe("Directed connectors."),
}) satisfies z.ZodType<FlowchartDiagram>;

const NumberLineSchema = z.object({
  kind: z.literal("number_line"),
  min: z.number(),
  max: z.number(),
  step: z.number().positive().optional().describe("Tick spacing; omit for an auto step."),
  points: z.array(z.object({ value: z.number(), label: label(20, "Point label.").optional(), color: hex.optional() })).max(12).optional(),
  intervals: z
    .array(
      z.object({
        from: z.number(),
        to: z.number(),
        label: label(20, "Interval label.").optional(),
        closedLeft: z.boolean().optional(),
        closedRight: z.boolean().optional(),
      })
    )
    .max(6)
    .optional(),
}) satisfies z.ZodType<NumberLineDiagram>;

const VennSchema = z.object({
  kind: z.literal("venn"),
  aLabel: label(28, "Left set label."),
  bLabel: label(28, "Right set label."),
  aOnly: label(60, "What's only in the left set.").optional(),
  bOnly: label(60, "What's only in the right set.").optional(),
  both: label(60, "What's in the overlap.").optional(),
}) satisfies z.ZodType<VennDiagram>;

/** The strict diagram union, with the deterministic correctness gate attached:
 *  the `.superRefine` runs `validateDiagram`, so a wrong shape (demand sloping
 *  up, an unsorted "sorted" array, an unweighted weighted graph) is rejected
 *  with the same message the test suite asserts. */
export const DiagramSpecInputSchema = z
  .discriminatedUnion("kind", [
    SupplyDemandSchema,
    CoordinatePlotSchema,
    BarChartSchema,
    ArrayDiagramSchema,
    TreeDiagramSchema,
    GraphDiagramSchema,
    FlowchartSchema,
    NumberLineSchema,
    VennSchema,
  ])
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
