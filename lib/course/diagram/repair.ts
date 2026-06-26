/**
 * Deterministic diagram REPAIR — fix the correctness INVARIANTS on the model's OWN
 * data, with NO fabrication and NO demo-data fallback.
 *
 * `validateDiagram` (validate.ts) names the invariants a diagram must satisfy (a
 * supply curve slopes up, a binary-search array is sorted, a weighted graph weights
 * every edge, an edge points at a real node). Previously a violation was REJECTED at
 * the tool boundary and bounced back to the model. We now ACCEPT the diagram and fix
 * it in code — but ONLY by correcting the model's real data (re-slope a curve,
 * re-sort the values, drop a dangling edge, swap a backwards interval). We NEVER
 * invent missing data or substitute a generic template/minimal seed: a "diagram"
 * full of placeholder demo data (A/B/C bars, a Python-vs-JS chart on a economics
 * lesson) is worse than no diagram. So a structurally-empty / unrepairable diagram
 * yields `null`, and the caller degrades to a real-text PROSE slide instead.
 *
 * Pure: no Zod, no model, no React.
 */

import type { DiagramKind, DiagramSpec } from "./types";
import { validateDiagram } from "./validate";

/** The ONLY diagram kinds the AI may author (2026-06-25). The other 7 kinds were
 *  retired to generated images; their renderers/storage stay for back-compat, but
 *  this guard degrades any attempt to author one on the lenient add_diagram path
 *  (so it becomes a prose/image slide, never a rigid removed-kind diagram). */
export const AUTHORABLE_DIAGRAM_KINDS: ReadonlySet<DiagramKind> = new Set<DiagramKind>([
  "supply_demand",
  "coordinate_plot",
]);

const clamp01 = (v: number): number => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
const isNumericLike = (s: string): boolean => s.trim() !== "" && isFinite(Number(s.trim()));

/**
 * Fix the deterministic invariants on the model's OWN data, returning a repaired
 * CLONE. It corrects what it safely can (slope direction, sort order, dangling
 * references, a backwards interval, an out-of-range axis derived from the data) and
 * DROPS sub-items it can't — but it NEVER fabricates missing content. A diagram
 * with no real content (empty bars/series/values/nodes) stays invalid here and is
 * turned into `null` by `coerceDiagramBestEffort`.
 */
export function repairDiagram(input: DiagramSpec): DiagramSpec {
  const d = structuredClone(input);
  switch (d.kind) {
    case "supply_demand": {
      // Curve positions are conceptual (0..1), not lesson data — re-slope to the
      // canonical direction if the model got them backwards/flat (an invariant fix).
      d.supply.leftY = clamp01(d.supply.leftY);
      d.supply.rightY = clamp01(d.supply.rightY);
      d.demand.leftY = clamp01(d.demand.leftY);
      d.demand.rightY = clamp01(d.demand.rightY);
      if (!(d.supply.rightY > d.supply.leftY)) { d.supply.leftY = 0.18; d.supply.rightY = 0.85; }
      if (!(d.demand.rightY < d.demand.leftY)) { d.demand.leftY = 0.85; d.demand.rightY = 0.18; }
      if (d.intervention) d.intervention.level = clamp01(d.intervention.level);
      break;
    }
    case "coordinate_plot": {
      // Drop series too short to plot; DERIVE a bad axis range from the real points
      // (never invent a series — no points left ⇒ stays invalid ⇒ null).
      d.series = d.series.filter((s) => s.points.length >= (s.style === "scatter" ? 1 : 2));
      const pts = d.series.flatMap((s) => s.points);
      if (pts.length) {
        if (!(d.xRange.min < d.xRange.max)) {
          const xs = pts.map((p) => p.x); const lo = Math.min(...xs), hi = Math.max(...xs);
          d.xRange = { min: lo, max: lo === hi ? hi + 1 : hi };
        }
        if (!(d.yRange.min < d.yRange.max)) {
          const ys = pts.map((p) => p.y); const lo = Math.min(...ys), hi = Math.max(...ys);
          d.yRange = { min: lo, max: lo === hi ? hi + 1 : hi };
        }
      }
      if (d.shaded && (d.shaded.seriesIndex < 0 || d.shaded.seriesIndex >= d.series.length)) d.shaded = undefined;
      break;
    }
    case "bar_chart": {
      d.bars = d.bars.filter((b) => isFinite(b.value)); // drop junk; never invent a bar
      break;
    }
    case "array_diagram": {
      const n = d.values.length;
      if (d.sorted && d.values.every(isNumericLike)) {
        d.values = [...d.values].sort((a, b) => Number(a) - Number(b)); // reorder REAL values
      }
      const ok = (i: number) => i >= 0 && i < n;
      if (d.pointers) d.pointers = d.pointers.filter((p) => ok(p.index));
      if (d.marks) d.marks = d.marks.filter((m) => ok(m.index));
      if (d.window) {
        if (!ok(d.window.from) || !ok(d.window.to)) d.window = undefined;
        else if (d.window.from > d.window.to) d.window = { ...d.window, from: d.window.to, to: d.window.from };
      }
      break;
    }
    case "tree_diagram":
      break; // a tree needs a labeled root — if it lacks one it stays invalid (no invent)
    case "graph_diagram": {
      // Dedup node ids; drop edges / path entries that reference a missing node.
      const seen = new Set<string>();
      d.nodes = d.nodes.filter((node) => (seen.has(node.id) ? false : (seen.add(node.id), true)));
      const ids = new Set(d.nodes.map((node) => node.id));
      d.edges = d.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
      // If marked weighted but a weight is missing, render UNWEIGHTED (drop the
      // claim) rather than INVENT a weight — fake weights would mislead.
      if (d.weighted && d.edges.some((e) => typeof e.weight !== "number" || !isFinite(e.weight))) d.weighted = false;
      if (d.highlightPath) d.highlightPath = d.highlightPath.filter((id) => ids.has(id));
      break;
    }
    case "flowchart": {
      const seen = new Set<string>();
      d.nodes = d.nodes.filter((node) => (seen.has(node.id) ? false : (seen.add(node.id), true)));
      const ids = new Set(d.nodes.map((node) => node.id));
      d.edges = d.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
      break;
    }
    case "number_line": {
      if (d.min > d.max) { const lo = d.max, hi = d.min; d.min = lo; d.max = hi; } // swap REAL values
      if (d.points) d.points = d.points.filter((p) => p.value >= d.min && p.value <= d.max);
      if (d.intervals) d.intervals = d.intervals.map((iv) => (iv.from > iv.to ? { ...iv, from: iv.to, to: iv.from } : iv));
      break;
    }
    case "venn":
      break; // both set labels are required — no invent; degrade if missing
  }
  return d;
}

/**
 * Best-effort coerce of the MODEL'S diagram: repair the invariants on its real data
 * and return it iff it now validates, else `null`. There is NO seed/template/minimal
 * fallback — a diagram only ever renders with the model's real, subject-specific
 * data (or not at all; the caller degrades to a prose slide). Never throws.
 */
export function coerceDiagramBestEffort(diagram: DiagramSpec | null): DiagramSpec | null {
  if (!diagram) return null;
  // Retired kinds are no longer authorable — degrade (caller falls back to a
  // generated image / prose) rather than render a rigid removed-kind diagram.
  if (!AUTHORABLE_DIAGRAM_KINDS.has(diagram.kind)) return null;
  const repaired = repairDiagram(diagram);
  return validateDiagram(repaired).length === 0 ? repaired : null;
}
