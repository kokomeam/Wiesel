/**
 * Programmatic-diagram model — the typed, deterministic source of truth a
 * renderer turns into crisp SVG.
 *
 * Design principle (the whole point of the visual pipeline): a teaching visual
 * is a TEACHING OBJECT, not decoration. For anything precision-critical — an
 * economics graph, a search interval, a weighted graph — accuracy must be
 * guaranteed BY CONSTRUCTION, not hoped for from an image model. So we model the
 * visual as data (curves, nodes, edges, cells) and DERIVE the picture. That buys
 * us, for free: correctness (a supply curve literally slopes up), determinism +
 * testability (pure data → pure SVG), editability (labels are fields), a11y (alt
 * text travels with the spec), clean export (SVG re-derives to PPTX/PDF shapes),
 * and persistence with no blob URLs (it rides in `blocks.content` jsonb).
 *
 * A diagram is surfaced to the rest of the app as a renderer-owned STRUCTURED
 * slide layout (`SlideTemplate` with `layoutId: "diagram"`), so it flows through
 * the exact same patch pipeline, validate→repair loop, change-set staging, and
 * picker as every other structured layout — no new patch actions, no new storage.
 *
 * This file is PURE TYPES (no Zod, no React) so both the model and the renderer
 * can depend on it without cycles.
 */

import type { RichText } from "../types";

/* ─────────────────────────── Pedagogy metadata ────────────────────────── */

/** The pedagogical job a visual does. Mirrors the planner's `visualIntent.role`
 *  (lib/ai/outline.ts) so a plan can ask for exactly the visual it needs. The
 *  const tuple is the source of truth so `z.enum(VISUAL_ROLES)` keeps the literal
 *  union (not a widened `string`). */
export const VISUAL_ROLES = [
  "concept_diagram",
  "worked_example",
  "graph",
  "chart",
  "flowchart",
  "timeline",
  "comparison",
  "data_chart",
  "code_trace",
  "tree_or_graph",
  "process",
  "system_map",
  "spatial_example",
  "concept_map",
] as const;
export type VisualRole = (typeof VISUAL_ROLES)[number];

export type VisualPlacement = "left" | "right" | "center" | "full_width" | "background" | "inline";
export type VisualPriority = "required" | "recommended" | "optional";

/** Where a visual asset ultimately comes from (the router's decision). Diagrams
 *  are always `programmatic`; the other sources are the (flag-gated) image path. */
export type VisualSourceType = "programmatic" | "ai_generated" | "web" | "upload";

/**
 * The teaching-critical metadata that travels WITH a visual on the slide (a
 * trimmed `VisualSpec` — the full router-facing spec, with ids + generation
 * fields, lives in lib/ai/visuals/visualSpec.ts). Every generated visual must
 * carry a `pedagogicalPurpose`, `altText`, and the `reason` it earned its place.
 */
export interface VisualSpec {
  role: VisualRole;
  /** Why this visual exists pedagogically — the test it must pass to stay. */
  pedagogicalPurpose: string;
  /** Accessibility + AI both depend on it. Never empty for a real visual. */
  altText: string;
  /** What the visual MUST show to do its job (drives validation). */
  requiredElements?: string[];
  placement?: VisualPlacement;
  /** Where the asset came from. Absent ⇒ `programmatic` (a diagram always is);
   *  the AI authoring schema omits it and the tool/renderer default it. */
  source?: VisualSourceType;
  /** Whether label/number/shape accuracy is correctness-critical (graphs, search
   *  intervals, weighted graphs). Accuracy-critical visuals are validated hard. */
  mustBeAccurate?: boolean;
  /** Human-facing justification shown in the editor ("added because …"). */
  reason?: string;
}

/* ───────────────────────────── Diagram spec ───────────────────────────── */

export type DiagramKind =
  | "supply_demand"
  | "coordinate_plot"
  | "bar_chart"
  | "array_diagram"
  | "tree_diagram"
  | "graph_diagram"
  | "flowchart"
  | "number_line"
  | "venn";

export const DIAGRAM_KINDS: readonly DiagramKind[] = [
  "supply_demand",
  "coordinate_plot",
  "bar_chart",
  "array_diagram",
  "tree_diagram",
  "graph_diagram",
  "flowchart",
  "number_line",
  "venn",
];

/* ── Economics: supply & demand (covers equilibrium, price ceiling, price floor).
   Curves live in a normalized chart box: x∈[0,1] = Quantity (→), y∈[0,1] = Price
   (↑). Each curve is a straight line given by its price at the left (q=0) and
   right (q=1) edges, so "supply slopes up / demand slopes down" is a checkable
   numeric invariant and the equilibrium is the exact line intersection. ── */
export interface SupplyDemandLine {
  /** Price (y, 0..1) at the left edge (quantity = 0). */
  leftY: number;
  /** Price (y, 0..1) at the right edge (quantity = 1). */
  rightY: number;
}
export interface SupplyDemandIntervention {
  kind: "price_ceiling" | "price_floor";
  /** The regulated price as y in 0..1. A binding ceiling sits below, a binding
   *  floor above, the equilibrium price. */
  level: number;
  label?: string;
}
export interface SupplyDemandDiagram {
  kind: "supply_demand";
  xLabel?: string;
  yLabel?: string;
  /** Upward-sloping: rightY MUST exceed leftY. */
  supply: SupplyDemandLine;
  /** Downward-sloping: rightY MUST be below leftY. */
  demand: SupplyDemandLine;
  equilibriumLabel?: string;
  priceLabel?: string;
  quantityLabel?: string;
  /** Adds the regulated-price line + the resulting shortage/surplus shading. */
  intervention?: SupplyDemandIntervention;
}

/* ── General coordinate / function plot (regression line, distributions, a
   tangent, area-under-a-curve, vectors-as-segments). Data in real units;
   the renderer maps to pixels with a linear scale and draws labeled axes. ── */
export interface PlotPoint {
  x: number;
  y: number;
  label?: string;
}
export interface PlotSeries {
  label: string;
  points: PlotPoint[];
  style?: "line" | "scatter" | "dashed";
  color?: string;
}
export interface AxisRange {
  min: number;
  max: number;
}
export interface CoordinatePlotDiagram {
  kind: "coordinate_plot";
  xLabel: string;
  yLabel: string;
  xRange: AxisRange;
  yRange: AxisRange;
  series: PlotSeries[];
  /** Labeled points of interest (an intercept, a maximum, an equilibrium). */
  markers?: { x: number; y: number; label: string }[];
  /** Shade the area under one series between two x-values (integral / region). */
  shaded?: { seriesIndex: number; fromX: number; toX: number; label?: string };
}

/* ── Categorical bar chart. ── */
export interface BarChartDiagram {
  kind: "bar_chart";
  xLabel?: string;
  yLabel?: string;
  bars: { label: string; value: number; color?: string }[];
  /** Optional fixed axis maximum; otherwise derived from the data. */
  maxValue?: number;
}

/* ── Array diagram (two-pointers, sliding window, binary search). A row of
   indexed cells with optional pointer arrows, a highlighted window, and
   per-cell marks. Binary search REQUIRES `sorted: true`. ── */
export interface ArrayPointer {
  index: number;
  label: string;
  color?: string;
}
export type ArrayMarkKind = "target" | "found" | "visited" | "eliminated";
export interface ArrayMark {
  index: number;
  kind: ArrayMarkKind;
}
export interface ArrayDiagram {
  kind: "array_diagram";
  values: string[];
  showIndices?: boolean;
  /** Set true for an ordered array (binary search demands it). */
  sorted?: boolean;
  pointers?: ArrayPointer[];
  /** Inclusive cell range to highlight (the current window / search interval). */
  window?: { from: number; to: number; label?: string };
  marks?: ArrayMark[];
}

/* ── Tree (binary or n-ary): a recursive node structure the renderer
   auto-positions (leaves spread left→right, parents centered over children,
   depth → row). Covers BSTs, expression trees, recursion/probability trees. ── */
export interface TreeNode {
  label: string;
  children?: TreeNode[];
  /** Accent this node (a search path, a chosen branch). */
  highlight?: boolean;
}
export interface TreeDiagram {
  kind: "tree_diagram";
  root: TreeNode;
  variant?: "binary" | "nary";
  /** Node labels in visit order → numbered traversal badges. */
  highlightOrder?: string[];
}

/* ── Node-link graph / network (graph traversal, Dijkstra, union-find). Nodes
   may carry positions in 0..1; if any lack them the renderer lays them out on a
   circle deterministically. `weighted` graphs REQUIRE a weight on every edge. ── */
export interface GraphNode {
  id: string;
  label?: string;
  x?: number;
  y?: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  weight?: number;
  label?: string;
  highlight?: boolean;
}
export interface GraphDiagram {
  kind: "graph_diagram";
  directed?: boolean;
  weighted?: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node ids forming a path to accent (e.g. a shortest path). */
  highlightPath?: string[];
}

/* ── Flowchart / decision diagram (process flow, an algorithm's control flow,
   a decision tree). Layered top-to-bottom auto-layout. ── */
export type FlowNodeKind = "start" | "process" | "decision" | "io" | "end";
export interface FlowNode {
  id: string;
  label: string;
  kind: FlowNodeKind;
}
export interface FlowEdge {
  from: string;
  to: string;
  /** Branch label, e.g. "Yes" / "No". */
  label?: string;
}
export interface FlowchartDiagram {
  kind: "flowchart";
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/* ── Number line / 1-D timeline (intervals, inequalities, a sequence of dates). ── */
export interface NumberLineDiagram {
  kind: "number_line";
  min: number;
  max: number;
  /** Tick spacing; defaults to a sensible step from the range. */
  step?: number;
  points?: { value: number; label?: string; color?: string }[];
  intervals?: {
    from: number;
    to: number;
    label?: string;
    closedLeft?: boolean;
    closedRight?: boolean;
  }[];
}

/* ── Two-set Venn diagram. ── */
export interface VennDiagram {
  kind: "venn";
  aLabel: string;
  bLabel: string;
  aOnly?: string;
  bOnly?: string;
  both?: string;
}

export type DiagramSpec =
  | SupplyDemandDiagram
  | CoordinatePlotDiagram
  | BarChartDiagram
  | ArrayDiagram
  | TreeDiagram
  | GraphDiagram
  | FlowchartDiagram
  | NumberLineDiagram
  | VennDiagram;

/* ─────────────────────────── Slide content ────────────────────────────── */

/**
 * The content of a `diagram` structured slide: a title, the typed diagram, its
 * pedagogical spec (purpose + alt text + the reason it was added), and a teaching
 * caption / takeaways. The renderer draws the title + SVG + caption; when
 * `takeaways` are present it lays the diagram beside them (a "diagram +
 * explanation" slide), otherwise the diagram goes full width.
 */
export interface DiagramContent {
  title: RichText;
  /** The one-line teaching takeaway under the visual ("what to notice"). */
  caption?: RichText;
  /** Optional 0–4 key points beside the diagram. */
  takeaways?: RichText[];
  spec: VisualSpec;
  diagram: DiagramSpec;
}
