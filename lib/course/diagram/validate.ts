/**
 * Deterministic diagram correctness — the programmatic half of "visual
 * validation" (spec §10). A programmatic diagram is data, so its correctness is
 * CHECKABLE without a model: a supply curve must slope up, a binary-search array
 * must be sorted, a weighted graph must weight every edge, an edge must point at
 * a node that exists. These are the exact failure cases the spec calls out.
 *
 * `validateDiagram` is the single source of truth for those checks — the strict
 * Zod schema (schemas.ts) runs it in a `.superRefine` so a malformed diagram is
 * bounced back to the model at the tool boundary (the validate→repair loop), and
 * the test suite + the lesson validator call it directly.
 *
 * Pure: no Zod, no React, no model. Returns human-readable errors ([] = valid).
 */

import type { DiagramSpec } from "./types";

function inRange01(v: number): boolean {
  return typeof v === "number" && isFinite(v) && v >= 0 && v <= 1;
}
function isNumericLike(s: string): boolean {
  const t = s.trim();
  return t !== "" && isFinite(Number(t));
}

export function validateDiagram(d: DiagramSpec): string[] {
  const errs: string[] = [];
  switch (d.kind) {
    case "supply_demand": {
      if (!(d.supply.rightY > d.supply.leftY))
        errs.push("supply: a supply curve must slope UPWARD — its right-edge price must exceed its left-edge price.");
      if (!(d.demand.rightY < d.demand.leftY))
        errs.push("demand: a demand curve must slope DOWNWARD — its right-edge price must be below its left-edge price.");
      for (const k of ["leftY", "rightY"] as const) {
        if (!inRange01(d.supply[k])) errs.push(`supply.${k}: must be between 0 and 1.`);
        if (!inRange01(d.demand[k])) errs.push(`demand.${k}: must be between 0 and 1.`);
      }
      if (d.intervention && !inRange01(d.intervention.level))
        errs.push("intervention.level: must be between 0 and 1.");
      break;
    }
    case "coordinate_plot": {
      if (!(d.xRange.min < d.xRange.max)) errs.push("xRange: min must be less than max.");
      if (!(d.yRange.min < d.yRange.max)) errs.push("yRange: min must be less than max.");
      if (d.series.length === 0) errs.push("series: provide at least one series to plot.");
      d.series.forEach((s, i) => {
        const min = s.style === "scatter" ? 1 : 2;
        if (s.points.length < min)
          errs.push(`series[${i}] (${s.label}): a ${s.style ?? "line"} needs at least ${min} point(s).`);
      });
      if (d.shaded && (d.shaded.seriesIndex < 0 || d.shaded.seriesIndex >= d.series.length))
        errs.push("shaded.seriesIndex: refers to a series that doesn't exist.");
      break;
    }
    case "bar_chart": {
      if (d.bars.length === 0) errs.push("bars: provide at least one bar.");
      d.bars.forEach((b, i) => {
        if (!isFinite(b.value)) errs.push(`bars[${i}] (${b.label}): value must be a finite number.`);
      });
      break;
    }
    case "array_diagram": {
      const n = d.values.length;
      if (n === 0) errs.push("values: the array is empty.");
      if (d.sorted && d.values.every(isNumericLike)) {
        const nums = d.values.map(Number);
        const ascending = nums.every((v, i) => i === 0 || v >= nums[i - 1]);
        if (!ascending)
          errs.push("values: a sorted array (required for binary search) must be in non-decreasing order.");
      }
      const checkIndex = (i: number, where: string) => {
        if (i < 0 || i >= n) errs.push(`${where}: index ${i} is out of range (0…${n - 1}).`);
      };
      d.pointers?.forEach((p, i) => checkIndex(p.index, `pointers[${i}] (${p.label})`));
      d.marks?.forEach((m, i) => checkIndex(m.index, `marks[${i}]`));
      if (d.window) {
        checkIndex(d.window.from, "window.from");
        checkIndex(d.window.to, "window.to");
        if (d.window.from > d.window.to) errs.push("window: from must be ≤ to.");
      }
      break;
    }
    case "tree_diagram": {
      if (!d.root || !d.root.label.trim()) errs.push("root: the tree needs a labeled root node.");
      break;
    }
    case "graph_diagram": {
      const ids = new Set(d.nodes.map((n) => n.id));
      if (d.nodes.length === 0) errs.push("nodes: the graph has no nodes.");
      if (ids.size !== d.nodes.length) errs.push("nodes: node ids must be unique.");
      d.edges.forEach((e, i) => {
        if (!ids.has(e.from)) errs.push(`edges[${i}].from: no node "${e.from}".`);
        if (!ids.has(e.to)) errs.push(`edges[${i}].to: no node "${e.to}".`);
        if (d.weighted && (e.weight === undefined || e.weight === null || !isFinite(e.weight)))
          errs.push(`edges[${i}] (${e.from}→${e.to}): a weighted graph must give every edge a numeric weight.`);
      });
      d.highlightPath?.forEach((id) => {
        if (!ids.has(id)) errs.push(`highlightPath: no node "${id}".`);
      });
      break;
    }
    case "flowchart": {
      const ids = new Set(d.nodes.map((n) => n.id));
      if (d.nodes.length === 0) errs.push("nodes: the flowchart has no nodes.");
      if (ids.size !== d.nodes.length) errs.push("nodes: node ids must be unique.");
      d.edges.forEach((e, i) => {
        if (!ids.has(e.from)) errs.push(`edges[${i}].from: no node "${e.from}".`);
        if (!ids.has(e.to)) errs.push(`edges[${i}].to: no node "${e.to}".`);
      });
      break;
    }
    case "number_line": {
      if (!(d.min < d.max)) errs.push("min/max: min must be less than max.");
      d.points?.forEach((p, i) => {
        if (p.value < d.min || p.value > d.max) errs.push(`points[${i}]: value ${p.value} is outside [${d.min}, ${d.max}].`);
      });
      d.intervals?.forEach((iv, i) => {
        if (iv.from > iv.to) errs.push(`intervals[${i}]: from must be ≤ to.`);
      });
      break;
    }
    case "venn": {
      if (!d.aLabel.trim() || !d.bLabel.trim()) errs.push("venn: both set labels are required.");
      break;
    }
  }
  return errs;
}

/** What this diagram contains, in plain words — drives the visual's
 *  `requiredElements`, an alt-text fallback, and validation messaging. */
export function diagramRequiredElements(d: DiagramSpec): string[] {
  switch (d.kind) {
    case "supply_demand": {
      const base = ["upward-sloping supply curve", "downward-sloping demand curve", "labeled price/quantity axes", "equilibrium point"];
      if (d.intervention) base.push(d.intervention.kind === "price_ceiling" ? "price ceiling line" : "price floor line");
      return base;
    }
    case "coordinate_plot":
      return ["labeled axes", ...d.series.map((s) => `series: ${s.label}`)];
    case "bar_chart":
      return ["labeled bars", "value axis"];
    case "array_diagram": {
      const e = ["indexed array cells"];
      if (d.sorted) e.push("sorted order");
      if (d.pointers?.length) e.push(...d.pointers.map((p) => `pointer: ${p.label}`));
      if (d.window) e.push("highlighted window/interval");
      return e;
    }
    case "tree_diagram":
      return ["root node", "parent→child edges", ...(d.highlightOrder?.length ? ["traversal order"] : [])];
    case "graph_diagram":
      return ["nodes", d.directed ? "directed edges" : "edges", ...(d.weighted ? ["edge weights"] : [])];
    case "flowchart":
      return ["flow nodes", "directed connectors", ...(d.nodes.some((n) => n.kind === "decision") ? ["decision branch"] : [])];
    case "number_line":
      return ["number line with ticks", ...(d.points?.length ? ["marked points"] : []), ...(d.intervals?.length ? ["intervals"] : [])];
    case "venn":
      return [`set: ${d.aLabel}`, `set: ${d.bLabel}`, "overlap region"];
  }
}

/** A one-line human summary of the diagram (logs + alt-text fallback). */
export function diagramSummary(d: DiagramSpec): string {
  switch (d.kind) {
    case "supply_demand":
      return d.intervention
        ? `Supply & demand with a ${d.intervention.kind.replace("_", " ")}`
        : "Supply & demand equilibrium graph";
    case "coordinate_plot":
      return `Plot of ${d.series.map((s) => s.label).join(", ")} (${d.xLabel} vs ${d.yLabel})`;
    case "bar_chart":
      return `Bar chart of ${d.bars.length} categories`;
    case "array_diagram":
      return `Array of ${d.values.length} cells${d.sorted ? " (sorted)" : ""}`;
    case "tree_diagram":
      return "Tree diagram";
    case "graph_diagram":
      return `${d.directed ? "Directed" : "Undirected"}${d.weighted ? " weighted" : ""} graph (${d.nodes.length} nodes)`;
    case "flowchart":
      return `Flowchart (${d.nodes.length} steps)`;
    case "number_line":
      return `Number line [${d.min}, ${d.max}]`;
    case "venn":
      return `Venn diagram: ${d.aLabel} vs ${d.bLabel}`;
  }
}
