/**
 * Pure layout maths for the diagram renderers — deterministic, no React, no
 * Math.random / Date.now (these run during SSR + thumbnail static render, where
 * any nondeterminism would trip a hydration mismatch). Everything returns
 * positions in a normalized unit box (0..1 in both axes); the renderer maps that
 * onto its pixel viewBox, so the same maths drives the live canvas, thumbnails,
 * and export.
 */

import type { FlowEdge, FlowNode, GraphNode, TreeNode } from "./types";

/** A linear map from a data domain onto a pixel range (with optional clamp). */
export function linearScale(
  domain: [number, number],
  range: [number, number]
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** A "nice" tick step for a range, so axes get round numbers. */
export function niceStep(range: number, target = 5): number {
  if (range <= 0) return 1;
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
  return step * mag;
}

/** Ticks across [min,max] inclusive-ish at `step`. */
export function ticks(min: number, max: number, step: number): number[] {
  if (step <= 0 || !isFinite(step)) return [min, max];
  const out: number[] = [];
  // Start at the first multiple of step ≥ min.
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step * 1e-9 && out.length < 200; v += step) {
    // Kill floating-point fuzz (…0000001).
    out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toFixed(6)));
  }
  return out;
}

/* ─────────────────────────────── Trees ────────────────────────────────── */

export interface LaidOutTreeNode {
  id: string;
  label: string;
  /** 0..1 within the layout box. */
  x: number;
  y: number;
  depth: number;
  highlight?: boolean;
}
export interface LaidOutTree {
  nodes: LaidOutTreeNode[];
  edges: { from: string; to: string }[];
  maxDepth: number;
}

/**
 * Tidy-ish tree layout: leaves are spread evenly left→right in DFS order, each
 * internal node is centered over its children, and depth maps to rows. Synthetic
 * ids (`n0`, `n1`, …) are assigned in DFS order so edges are stable.
 */
export function layoutTree(root: TreeNode): LaidOutTree {
  const nodes: LaidOutTreeNode[] = [];
  const edges: { from: string; to: string }[] = [];
  let leafCounter = 0;
  let maxDepth = 0;
  let idCounter = 0;

  // First pass: count leaves so we can normalize x.
  const countLeaves = (n: TreeNode): number =>
    !n.children || n.children.length === 0
      ? 1
      : n.children.reduce((s, c) => s + countLeaves(c), 0);
  const totalLeaves = Math.max(1, countLeaves(root));

  const visit = (n: TreeNode, depth: number): LaidOutTreeNode => {
    const id = `n${idCounter++}`;
    maxDepth = Math.max(maxDepth, depth);
    let x: number;
    if (!n.children || n.children.length === 0) {
      x = (leafCounter + 0.5) / totalLeaves;
      leafCounter += 1;
    } else {
      const kids = n.children.map((c) => visit(c, depth + 1));
      x = kids.reduce((s, k) => s + k.x, 0) / kids.length;
      for (const k of kids) edges.push({ from: id, to: k.id });
    }
    const laid: LaidOutTreeNode = { id, label: n.label, x, y: 0, depth, highlight: n.highlight };
    nodes.push(laid);
    return laid;
  };
  visit(root, 0);

  // Map depth → y now that maxDepth is known.
  const rows = maxDepth + 1;
  for (const n of nodes) n.y = rows === 1 ? 0.5 : (n.depth + 0.5) / rows;
  return { nodes, edges, maxDepth };
}

/* ─────────────────────────────── Graphs ───────────────────────────────── */

/** Resolve every node to a 0..1 position: honor explicit coords, otherwise place
 *  the un-positioned nodes evenly on a circle (deterministic, by index). */
export function layoutGraph(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const need: GraphNode[] = [];
  for (const n of nodes) {
    if (typeof n.x === "number" && typeof n.y === "number") pos.set(n.id, { x: n.x, y: n.y });
    else need.push(n);
  }
  const n = need.length;
  const r = n <= 1 ? 0 : 0.4;
  need.forEach((node, i) => {
    // Start at the top (−90°) and go clockwise.
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, n);
    pos.set(node.id, { x: 0.5 + r * Math.cos(angle), y: 0.5 + r * Math.sin(angle) });
  });
  return pos;
}

/* ───────────────────────────── Flowcharts ─────────────────────────────── */

export interface LaidOutFlowNode extends FlowNode {
  x: number;
  y: number;
  depth: number;
}
export interface LaidOutFlow {
  nodes: LaidOutFlowNode[];
  rows: number;
}

/**
 * Layered top-to-bottom flowchart layout. Depth = longest path from a source
 * (a node with no incoming edge); within a depth, nodes keep their declared
 * order and spread across the width. Robust to cycles (a relaxation cap stops
 * runaway), and to a graph with no clear source (falls back to declaration
 * order).
 */
export function layoutFlow(nodes: FlowNode[], edges: FlowEdge[]): LaidOutFlow {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.to) || !adj.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }

  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, 0);
  // Relax longest-path depths; cap iterations at node count to survive cycles.
  for (let iter = 0; iter < nodes.length + 1; iter++) {
    let changed = false;
    for (const e of edges) {
      const du = depth.get(e.from);
      const dv = depth.get(e.to);
      if (du === undefined || dv === undefined) continue;
      if (dv < du + 1) {
        depth.set(e.to, du + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group by depth, preserving declaration order within a depth.
  const byDepth = new Map<number, FlowNode[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n);
  }
  const rows = Math.max(1, byDepth.size);
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const out: LaidOutFlowNode[] = [];
  depths.forEach((d, rowIdx) => {
    const group = byDepth.get(d)!;
    group.forEach((node, col) => {
      out.push({
        ...node,
        depth: rowIdx,
        x: (col + 0.5) / group.length,
        y: rows === 1 ? 0.5 : (rowIdx + 0.5) / rows,
      });
    });
  });
  return { nodes: out, rows };
}

/* ──────────────────────────── Supply / demand ─────────────────────────── */

/** Exact intersection of supply & demand lines in the 0..1 chart box. Each line
 *  is y(x) = leftY + x·(rightY − leftY). Returns the equilibrium {x,y}, clamped
 *  to the box; parallel lines fall back to the center. */
export function supplyDemandEquilibrium(
  supply: { leftY: number; rightY: number },
  demand: { leftY: number; rightY: number }
): { x: number; y: number } {
  // supply.leftY + x·(sR−sL) = demand.leftY + x·(dR−dL)
  const denom = supply.rightY - supply.leftY - (demand.rightY - demand.leftY);
  if (Math.abs(denom) < 1e-9) return { x: 0.5, y: (supply.leftY + supply.rightY) / 2 };
  const x = (demand.leftY - supply.leftY) / denom;
  const cx = Math.max(0, Math.min(1, x));
  const y = supply.leftY + cx * (supply.rightY - supply.leftY);
  return { x: cx, y: Math.max(0, Math.min(1, y)) };
}
