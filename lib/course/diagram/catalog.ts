/**
 * The programmatic-diagram TEMPLATE catalog (spec §5) — a small, extensible set
 * of high-value educational diagrams, each a CORRECT, ready-to-render seed. The
 * catalog has three jobs:
 *   1. Seed canonical diagrams accurately (a supply curve that really slopes up,
 *      a Dijkstra graph that really weights every edge) — the AI picks a
 *      templateId and the geometry is right by construction.
 *   2. Power the visual router's "is there a programmatic template for this?"
 *      decision (lib/ai/visuals/router.ts) via topic keyword matching.
 *   3. Advertise the available diagrams to the planner + the picker.
 *
 * Every seed is validated by the test suite (`validateDiagram(seed()) === []`),
 * so the catalog can never ship a wrong canonical diagram.
 */

import { diagramRequiredElements } from "./validate";
import type { DiagramKind, DiagramSpec } from "./types";

export type DiagramDomain = "economics" | "cs" | "math" | "business" | "general";

export interface DiagramTemplateDef {
  id: string;
  name: string;
  domain: DiagramDomain;
  description: string;
  kind: DiagramKind;
  /** Lower-cased keywords used to match a topic/visual-intent to this template. */
  applicableTopics: string[];
  /** When true, this template's accuracy is correctness-critical (graphs/search). */
  accuracyCritical: boolean;
  seed: () => DiagramSpec;
}

export const DIAGRAM_TEMPLATES: DiagramTemplateDef[] = [
  /* ───────────────────────────── Economics ───────────────────────────── */
  {
    id: "supply_demand_equilibrium",
    name: "Supply & demand equilibrium",
    domain: "economics",
    description: "Intersecting supply (up) and demand (down) curves with a labeled equilibrium point E and dashed guides to P* and Q*.",
    kind: "supply_demand",
    applicableTopics: ["supply", "demand", "equilibrium", "market price", "market", "price", "elasticity"],
    accuracyCritical: true,
    seed: () => ({
      kind: "supply_demand",
      xLabel: "Quantity",
      yLabel: "Price",
      supply: { leftY: 0.18, rightY: 0.85 },
      demand: { leftY: 0.85, rightY: 0.18 },
      equilibriumLabel: "E",
      priceLabel: "P*",
      quantityLabel: "Q*",
    }),
  },
  {
    id: "price_ceiling",
    name: "Price ceiling",
    domain: "economics",
    description: "Supply & demand with a binding price-ceiling line below equilibrium and the resulting shortage.",
    kind: "supply_demand",
    applicableTopics: ["price ceiling", "ceiling", "rent control", "shortage", "price control"],
    accuracyCritical: true,
    seed: () => ({
      kind: "supply_demand",
      xLabel: "Quantity",
      yLabel: "Price",
      supply: { leftY: 0.18, rightY: 0.85 },
      demand: { leftY: 0.85, rightY: 0.18 },
      equilibriumLabel: "E",
      priceLabel: "P*",
      quantityLabel: "Q*",
      intervention: { kind: "price_ceiling", level: 0.32, label: "Ceiling" },
    }),
  },
  {
    id: "price_floor",
    name: "Price floor",
    domain: "economics",
    description: "Supply & demand with a binding price-floor line above equilibrium and the resulting surplus.",
    kind: "supply_demand",
    applicableTopics: ["price floor", "floor", "minimum wage", "surplus", "price support"],
    accuracyCritical: true,
    seed: () => ({
      kind: "supply_demand",
      xLabel: "Quantity",
      yLabel: "Price",
      supply: { leftY: 0.18, rightY: 0.85 },
      demand: { leftY: 0.85, rightY: 0.18 },
      equilibriumLabel: "E",
      priceLabel: "P*",
      quantityLabel: "Q*",
      intervention: { kind: "price_floor", level: 0.7, label: "Floor" },
    }),
  },
  /* ─────────────────────────── CS / algorithms ───────────────────────── */
  {
    id: "array_two_pointers",
    name: "Array — two pointers",
    domain: "cs",
    description: "A sorted array with two pointers (L and R) converging from the ends.",
    kind: "array_diagram",
    applicableTopics: ["two pointer", "two pointers", "pair sum", "converging pointers", "array"],
    accuracyCritical: false,
    seed: () => ({
      kind: "array_diagram",
      values: ["2", "7", "11", "15", "19", "23"],
      showIndices: true,
      sorted: true,
      pointers: [
        { index: 0, label: "L" },
        { index: 5, label: "R" },
      ],
    }),
  },
  {
    id: "sliding_window",
    name: "Array — sliding window",
    domain: "cs",
    description: "An array with a highlighted window of fixed width and L/R bounds.",
    kind: "array_diagram",
    applicableTopics: ["sliding window", "window", "subarray", "substring", "contiguous"],
    accuracyCritical: false,
    seed: () => ({
      kind: "array_diagram",
      values: ["4", "2", "1", "7", "8", "1", "2", "8"],
      showIndices: true,
      window: { from: 2, to: 5, label: "window (k = 4)" },
      pointers: [
        { index: 2, label: "L" },
        { index: 5, label: "R" },
      ],
    }),
  },
  {
    id: "binary_search",
    name: "Binary search",
    domain: "cs",
    description: "A SORTED array with lo / mid / hi pointers and the eliminated half greyed out.",
    kind: "array_diagram",
    applicableTopics: ["binary search", "bisect", "search sorted", "logarithmic search", "lower bound"],
    accuracyCritical: true,
    seed: () => ({
      kind: "array_diagram",
      values: ["1", "3", "5", "7", "9", "11", "13"],
      showIndices: true,
      sorted: true,
      pointers: [
        { index: 0, label: "lo" },
        { index: 3, label: "mid" },
        { index: 6, label: "hi" },
      ],
      marks: [
        { index: 0, kind: "eliminated" },
        { index: 1, kind: "eliminated" },
        { index: 2, kind: "eliminated" },
        { index: 3, kind: "visited" },
      ],
    }),
  },
  {
    id: "binary_tree",
    name: "Binary search tree",
    domain: "cs",
    description: "A binary tree of nodes and parent→child edges.",
    kind: "tree_diagram",
    applicableTopics: ["binary tree", "bst", "binary search tree", "tree", "heap"],
    accuracyCritical: false,
    seed: () => ({
      kind: "tree_diagram",
      variant: "binary",
      root: {
        label: "8",
        children: [
          { label: "3", children: [{ label: "1" }, { label: "6" }] },
          { label: "10", children: [{ label: "14" }] },
        ],
      },
    }),
  },
  {
    id: "tree_traversal",
    name: "Tree traversal order",
    domain: "cs",
    description: "A binary tree with numbered badges showing a traversal order (e.g. pre-order).",
    kind: "tree_diagram",
    applicableTopics: ["traversal", "preorder", "inorder", "postorder", "dfs tree", "visit order"],
    accuracyCritical: false,
    seed: () => ({
      kind: "tree_diagram",
      variant: "binary",
      root: {
        label: "F",
        children: [
          { label: "B", children: [{ label: "A" }, { label: "D", children: [{ label: "C" }, { label: "E" }] }] },
          { label: "G", children: [{ label: "I", children: [{ label: "H" }] }] },
        ],
      },
      highlightOrder: ["F", "B", "A", "D", "C", "E", "G", "I", "H"],
    }),
  },
  {
    id: "recursion_stack",
    name: "Recursion / call tree",
    domain: "cs",
    description: "A call tree (e.g. Fibonacci) showing recursive expansion.",
    kind: "tree_diagram",
    applicableTopics: ["recursion", "recursive", "call tree", "fibonacci", "divide and conquer"],
    accuracyCritical: false,
    seed: () => ({
      kind: "tree_diagram",
      root: {
        label: "fib(4)",
        children: [
          { label: "fib(3)", children: [{ label: "fib(2)" }, { label: "fib(1)" }] },
          { label: "fib(2)", children: [{ label: "fib(1)" }, { label: "fib(0)" }] },
        ],
      },
    }),
  },
  {
    id: "inheritance_hierarchy",
    name: "Inheritance hierarchy",
    domain: "cs",
    description: "A class/type hierarchy as a tree (superclass → subclasses).",
    kind: "tree_diagram",
    applicableTopics: ["inheritance", "subclass", "superclass", "hierarchy", "class diagram", "interface", "polymorphism"],
    accuracyCritical: false,
    seed: () => ({
      kind: "tree_diagram",
      root: {
        label: "Animal",
        children: [
          { label: "Mammal", children: [{ label: "Dog" }, { label: "Cat" }] },
          { label: "Bird", children: [{ label: "Eagle" }] },
        ],
      },
    }),
  },
  {
    id: "graph_traversal",
    name: "Graph traversal (BFS/DFS)",
    domain: "cs",
    description: "An undirected graph with a highlighted traversal path.",
    kind: "graph_diagram",
    applicableTopics: ["graph", "bfs", "dfs", "traversal", "network", "adjacency", "connected"],
    accuracyCritical: true,
    seed: () => ({
      kind: "graph_diagram",
      directed: false,
      nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }, { id: "E" }],
      edges: [
        { from: "A", to: "B" },
        { from: "A", to: "C" },
        { from: "B", to: "D" },
        { from: "C", to: "D" },
        { from: "D", to: "E" },
      ],
      highlightPath: ["A", "B", "D", "E"],
    }),
  },
  {
    id: "dijkstra_graph",
    name: "Weighted graph (Dijkstra)",
    domain: "cs",
    description: "A directed, edge-weighted graph with the shortest path highlighted.",
    kind: "graph_diagram",
    applicableTopics: ["dijkstra", "shortest path", "weighted graph", "weights", "bellman", "spanning tree", "minimum cost"],
    accuracyCritical: true,
    seed: () => ({
      kind: "graph_diagram",
      directed: true,
      weighted: true,
      nodes: [{ id: "S" }, { id: "A" }, { id: "B" }, { id: "C" }, { id: "T" }],
      edges: [
        { from: "S", to: "A", weight: 2 },
        { from: "S", to: "B", weight: 5 },
        { from: "A", to: "B", weight: 1 },
        { from: "A", to: "C", weight: 4 },
        { from: "B", to: "T", weight: 3 },
        { from: "C", to: "T", weight: 1 },
      ],
      highlightPath: ["S", "A", "B", "T"],
    }),
  },
  {
    id: "process_flow",
    name: "Process flowchart",
    domain: "cs",
    description: "A flowchart with a start, a decision branch (Yes/No), and an end.",
    kind: "flowchart",
    applicableTopics: ["flowchart", "process", "algorithm flow", "control flow", "steps", "workflow", "if else"],
    accuracyCritical: false,
    seed: () => ({
      kind: "flowchart",
      nodes: [
        { id: "start", label: "Start", kind: "start" },
        { id: "read", label: "Read input n", kind: "io" },
        { id: "check", label: "n > 0 ?", kind: "decision" },
        { id: "pos", label: "Print “positive”", kind: "process" },
        { id: "nonpos", label: "Print “non-positive”", kind: "process" },
        { id: "end", label: "End", kind: "end" },
      ],
      edges: [
        { from: "start", to: "read" },
        { from: "read", to: "check" },
        { from: "check", to: "pos", label: "Yes" },
        { from: "check", to: "nonpos", label: "No" },
        { from: "pos", to: "end" },
        { from: "nonpos", to: "end" },
      ],
    }),
  },
  {
    id: "decision_tree",
    name: "Decision tree",
    domain: "business",
    description: "A branching decision diagram for a qualify/route-style process.",
    kind: "flowchart",
    applicableTopics: ["decision tree", "decision", "qualify", "routing", "triage", "sales funnel stage"],
    accuracyCritical: false,
    seed: () => ({
      kind: "flowchart",
      nodes: [
        { id: "lead", label: "New lead", kind: "start" },
        { id: "q", label: "Budget fit?", kind: "decision" },
        { id: "demo", label: "Book a demo", kind: "process" },
        { id: "nurture", label: "Add to nurture", kind: "process" },
        { id: "won", label: "Closed-won", kind: "end" },
      ],
      edges: [
        { from: "lead", to: "q" },
        { from: "q", to: "demo", label: "Yes" },
        { from: "q", to: "nurture", label: "No" },
        { from: "demo", to: "won" },
      ],
    }),
  },
  /* ───────────────────────────── Math / stats ────────────────────────── */
  {
    id: "normal_distribution",
    name: "Normal distribution",
    domain: "math",
    description: "A bell curve with the central region shaded (e.g. the 68% band).",
    kind: "coordinate_plot",
    applicableTopics: ["normal distribution", "bell curve", "gaussian", "standard deviation", "z-score", "probability density"],
    accuracyCritical: false,
    seed: () => ({
      kind: "coordinate_plot",
      xLabel: "Standard deviations (σ)",
      yLabel: "Density",
      xRange: { min: -3, max: 3 },
      yRange: { min: 0, max: 1.05 },
      series: [
        {
          label: "f(x)",
          style: "line",
          points: [
            { x: -3, y: 0.011 }, { x: -2.5, y: 0.044 }, { x: -2, y: 0.135 }, { x: -1.5, y: 0.325 },
            { x: -1, y: 0.607 }, { x: -0.5, y: 0.882 }, { x: 0, y: 1 }, { x: 0.5, y: 0.882 },
            { x: 1, y: 0.607 }, { x: 1.5, y: 0.325 }, { x: 2, y: 0.135 }, { x: 2.5, y: 0.044 }, { x: 3, y: 0.011 },
          ],
        },
      ],
      shaded: { seriesIndex: 0, fromX: -1, toX: 1, label: "68%" },
    }),
  },
  {
    id: "regression_line",
    name: "Regression / line of best fit",
    domain: "math",
    description: "A scatter of points with a fitted line.",
    kind: "coordinate_plot",
    applicableTopics: ["regression", "line of best fit", "correlation", "scatter", "trend line", "linear model"],
    accuracyCritical: false,
    seed: () => ({
      kind: "coordinate_plot",
      xLabel: "x",
      yLabel: "y",
      xRange: { min: 0, max: 9 },
      yRange: { min: 0, max: 9 },
      series: [
        {
          label: "Data",
          style: "scatter",
          points: [
            { x: 1, y: 2 }, { x: 2, y: 2.8 }, { x: 3, y: 3.1 }, { x: 4, y: 4.2 },
            { x: 5, y: 4.8 }, { x: 6, y: 6.1 }, { x: 7, y: 6.6 }, { x: 8, y: 7.9 },
          ],
        },
        { label: "Best fit", style: "line", points: [{ x: 1, y: 2.0 }, { x: 8, y: 7.6 }] },
      ],
    }),
  },
  {
    id: "number_line",
    name: "Number line / interval",
    domain: "math",
    description: "A number line with marked points and a highlighted interval.",
    kind: "number_line",
    applicableTopics: ["number line", "interval", "inequality", "range", "timeline", "real line"],
    accuracyCritical: false,
    seed: () => ({
      kind: "number_line",
      min: -5,
      max: 5,
      step: 1,
      points: [{ value: -2, label: "a" }, { value: 3, label: "b" }],
      intervals: [{ from: -2, to: 3, label: "[-2, 3]", closedLeft: true, closedRight: true }],
    }),
  },
  {
    id: "venn_diagram",
    name: "Venn diagram (2 sets)",
    domain: "math",
    description: "Two overlapping sets with region labels.",
    kind: "venn",
    applicableTopics: ["venn", "set", "intersection", "union", "overlap", "categorize", "classification"],
    accuracyCritical: false,
    seed: () => ({
      kind: "venn",
      aLabel: "Mammals",
      bLabel: "Aquatic",
      aOnly: "Dogs, bats",
      bOnly: "Fish, jellyfish",
      both: "Whales, dolphins",
    }),
  },
  {
    id: "bar_chart",
    name: "Bar chart",
    domain: "general",
    description: "A categorical bar chart with labeled axes.",
    kind: "bar_chart",
    applicableTopics: ["bar chart", "comparison of values", "data chart", "distribution", "share", "counts", "histogram"],
    accuracyCritical: false,
    seed: () => ({
      kind: "bar_chart",
      xLabel: "Language",
      yLabel: "Share (%)",
      bars: [
        { label: "Python", value: 31 },
        { label: "JS", value: 25 },
        { label: "Java", value: 17 },
        { label: "C++", value: 12 },
        { label: "Go", value: 8 },
      ],
    }),
  },
];

export const DIAGRAM_TEMPLATE_IDS = DIAGRAM_TEMPLATES.map((t) => t.id);

export function findDiagramTemplate(id: string): DiagramTemplateDef | undefined {
  return DIAGRAM_TEMPLATES.find((t) => t.id === id);
}

/** Required elements for a template (derived from its seed — single source). */
export function templateRequiredElements(t: DiagramTemplateDef): string[] {
  return diagramRequiredElements(t.seed());
}

/**
 * Best programmatic template for a topic, by keyword overlap. Returns the match +
 * a score (0 = no match). The router uses this to decide whether a precise
 * programmatic diagram exists before considering an AI-generated one.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchDiagramTemplate(text: string): { template: DiagramTemplateDef; score: number } | null {
  const hay = text.toLowerCase();
  let best: { template: DiagramTemplateDef; score: number } | null = null;
  for (const template of DIAGRAM_TEMPLATES) {
    let score = 0;
    for (const kw of template.applicableTopics) {
      // Whole-word/phrase match so "bst" can't match inside "abstract".
      if (new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(hay)) score += kw.includes(" ") ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { template, score };
  }
  return best;
}

/** Compact catalog text for the AI (id — domain — when to use). */
export function diagramCatalogText(): string {
  const lines = DIAGRAM_TEMPLATES.map((t) => `- ${t.id} (${t.domain}): ${t.description}`);
  return `PROGRAMMATIC DIAGRAM TEMPLATES (templateId — when to use). Each renders an ACCURATE diagram; prefer a template over freehand for canonical visuals:\n${lines.join("\n")}`;
}
