/**
 * Deterministic layered-DAG layout for the concept graph editor (TUTOR-1 Wave 5,
 * P5.2 · AC-W5G.1). PURE — no React, no store, no Math.random, no Date.now. The
 * SAME inputs always produce byte-identical outputs (golden-tested), so the
 * canvas renders stably and thumbnails/SSR match the live view.
 *
 * The layout is a classic Sugiyama-style pipeline restricted to `prerequisite`
 * edges (the DAG the RPC invariant guarantees is acyclic; a stray cycle is
 * broken DEFENSIVELY so the layout never loops):
 *   (1) build the prerequisite adjacency, breaking back-edges by a deterministic
 *       DFS so layering can't loop;
 *   (2) longest-path layering — each node's layer is 1 + the max layer of its
 *       prerequisites (roots at layer 0);
 *   (3) a FIXED-iteration barycenter ordering pass to reduce edge crossings,
 *       with a deterministic tie-break by node id;
 *   (4) coordinate assignment — layer → y (normalized 0..1), order-within-layer
 *       → x (normalized 0..1, evenly spaced).
 *
 * Non-prerequisite edges (part_of / related) do NOT influence the layout — they
 * are rendered as secondary connectors over the prerequisite skeleton. Isolated
 * nodes (no prerequisite edge) land on their own layer 0 lane in id order.
 */

export interface LayoutNodeInput {
  id: string;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
  kind: string;
}

export interface LayoutPosition {
  /** Normalized 0..1 horizontal position (order within the layer). */
  x: number;
  /** Normalized 0..1 vertical position (the layer index). */
  y: number;
}

export interface ConceptGraphLayout {
  positions: Map<string, LayoutPosition>;
  /** node ids grouped by layer, top (layer 0) first; each inner array is the
   *  left-to-right order that produced the x coordinates. */
  layers: string[][];
}

const BARYCENTER_ITERATIONS = 8;

/** Stable string compare (deterministic tie-break everywhere). */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Break back-edges so the prerequisite graph is a DAG for layering. Runs a
 * deterministic DFS (nodes visited in sorted id order); an edge to a node
 * currently on the DFS stack is a back-edge and is dropped from the layering
 * adjacency. This never mutates the caller's edges — it only decides which
 * prerequisite edges participate in the longest-path pass.
 */
function forwardPrereqEdges(
  nodeIds: string[],
  prereq: Array<[string, string]>
): Array<[string, string]> {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const [s, t] of prereq) {
    if (outgoing.has(s) && outgoing.has(t)) outgoing.get(s)!.push(t);
  }
  // Sort each adjacency list for determinism.
  for (const list of outgoing.values()) list.sort(byId);

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);
  const backEdges = new Set<string>();

  const edgeKey = (s: string, t: string) => `${s}${t}`;

  // Iterative DFS with an explicit stack to avoid recursion depth limits.
  for (const root of [...nodeIds].sort(byId)) {
    if (color.get(root) !== WHITE) continue;
    const stack: Array<{ node: string; idx: number }> = [{ node: root, idx: 0 }];
    color.set(root, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const adj = outgoing.get(frame.node)!;
      if (frame.idx < adj.length) {
        const next = adj[frame.idx];
        frame.idx += 1;
        const c = color.get(next);
        if (c === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, idx: 0 });
        } else if (c === GRAY) {
          // back-edge (points to an ancestor on the stack) — drop it.
          backEdges.add(edgeKey(frame.node, next));
        }
        // c === BLACK: cross/forward edge — keep it.
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }

  return prereq.filter(([s, t]) => !backEdges.has(edgeKey(s, t)));
}

/** Longest-path layering: layer(n) = 1 + max(layer of prerequisites), roots at 0.
 *  Iterates to a fixed point over the acyclic forward edges (bounded by node
 *  count, so it always terminates). */
function assignLayers(nodeIds: string[], forward: Array<[string, string]>): Map<string, number> {
  const preds = new Map<string, string[]>();
  for (const id of nodeIds) preds.set(id, []);
  for (const [s, t] of forward) {
    // edge s → t means "s is a prerequisite of t": t must sit BELOW s.
    if (preds.has(t)) preds.get(t)!.push(s);
  }
  const layer = new Map<string, number>();
  for (const id of nodeIds) layer.set(id, 0);

  // Relax up to nodeIds.length times (longest path in a DAG converges by then).
  for (let iter = 0; iter < nodeIds.length; iter++) {
    let changed = false;
    for (const id of [...nodeIds].sort(byId)) {
      const ps = preds.get(id)!;
      let want = 0;
      for (const p of ps) want = Math.max(want, (layer.get(p) ?? 0) + 1);
      if (want !== layer.get(id)) {
        layer.set(id, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

/**
 * Barycenter ordering: reduce edge crossings by repeatedly reordering each layer
 * by the mean position of its neighbours in the adjacent layer. FIXED iteration
 * count (deterministic); ties broken by node id. Alternates down-sweeps
 * (order by predecessors) and up-sweeps (order by successors).
 */
function orderLayers(
  layerGroups: string[][],
  forward: Array<[string, string]>
): string[][] {
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const [s, t] of forward) {
    if (!succ.has(s)) succ.set(s, []);
    if (!pred.has(t)) pred.set(t, []);
    succ.get(s)!.push(t);
    pred.get(t)!.push(s);
  }

  const groups = layerGroups.map((g) => [...g]);
  // Position index within each layer, rebuilt after each sweep.
  const posOf = new Map<string, number>();
  const rebuildPos = () => {
    posOf.clear();
    for (const g of groups) g.forEach((id, i) => posOf.set(id, i));
  };
  rebuildPos();

  const barycenter = (id: string, neighbourMap: Map<string, string[]>): number | null => {
    const ns = neighbourMap.get(id);
    if (!ns || ns.length === 0) return null;
    let sum = 0;
    for (const n of ns) sum += posOf.get(n) ?? 0;
    return sum / ns.length;
  };

  const sweep = (neighbourMap: Map<string, string[]>) => {
    for (let li = 0; li < groups.length; li++) {
      const layer = groups[li];
      // stable decorate-sort: nodes with no neighbour keep their current index.
      const decorated = layer.map((id, i) => {
        const bc = barycenter(id, neighbourMap);
        return { id, bc: bc === null ? i : bc, i };
      });
      decorated.sort((a, b) => a.bc - b.bc || byId(a.id, b.id));
      groups[li] = decorated.map((d) => d.id);
    }
    rebuildPos();
  };

  for (let iter = 0; iter < BARYCENTER_ITERATIONS; iter++) {
    // down-sweep: order each layer by its predecessors' positions
    sweep(pred);
    // up-sweep: order each layer by its successors' positions
    sweep(succ);
  }

  return groups;
}

/**
 * Layout the concept graph. Deterministic + pure. Positions are normalized to
 * [0,1]×[0,1] (the canvas scales them to logical coordinates). A single-layer or
 * single-node graph still gets sensible even spacing (a lone node lands at
 * x=0.5, y=0).
 */
export function layoutConceptGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[]
): ConceptGraphLayout {
  const nodeIds = nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);

  const prereq: Array<[string, string]> = edges
    .filter((e) => e.kind === "prerequisite" && idSet.has(e.source) && idSet.has(e.target) && e.source !== e.target)
    .map((e) => [e.source, e.target] as [string, string]);

  const forward = forwardPrereqEdges(nodeIds, prereq);
  const layer = assignLayers(nodeIds, forward);

  const maxLayer = nodeIds.reduce((m, id) => Math.max(m, layer.get(id) ?? 0), 0);

  // Group nodes by layer, each layer's INITIAL order = node id (deterministic).
  const layerGroups: string[][] = [];
  for (let l = 0; l <= maxLayer; l++) layerGroups.push([]);
  for (const id of [...nodeIds].sort(byId)) {
    layerGroups[layer.get(id) ?? 0].push(id);
  }

  const ordered = orderLayers(layerGroups, forward);

  // Coordinate assignment.
  const positions = new Map<string, LayoutPosition>();
  const layerCount = ordered.length;
  for (let l = 0; l < layerCount; l++) {
    const group = ordered[l];
    const n = group.length;
    const y = layerCount === 1 ? 0 : l / (layerCount - 1);
    for (let i = 0; i < n; i++) {
      // evenly spaced, centered: a single node lands at 0.5; two at 0.25/0.75; etc.
      const x = n === 1 ? 0.5 : i / (n - 1);
      positions.set(group[i], { x, y });
    }
  }

  return { positions, layers: ordered };
}

/**
 * Count edge crossings in a laid-out graph — the AC-W5G.1 regression metric. Two
 * prerequisite edges (a→b) and (c→d) that span the SAME pair of adjacent layers
 * cross iff their endpoints are in opposite horizontal order on the two layers.
 * Pure helper (used by the golden suite; exported so the verify script asserts a
 * ZERO-crossing regression against the recorded goldens).
 */
export function countEdgeCrossings(
  edges: LayoutEdgeInput[],
  positions: Map<string, LayoutPosition>
): number {
  const prereq = edges
    .filter((e) => e.kind === "prerequisite")
    .map((e) => ({ s: positions.get(e.source), t: positions.get(e.target) }))
    .filter((e): e is { s: LayoutPosition; t: LayoutPosition } => !!e.s && !!e.t);

  let crossings = 0;
  for (let i = 0; i < prereq.length; i++) {
    for (let j = i + 1; j < prereq.length; j++) {
      const a = prereq[i];
      const b = prereq[j];
      // Only compare edges spanning the same two y-levels (the standard layered
      // crossing count is defined per adjacent-layer band).
      if (a.s.y !== b.s.y || a.t.y !== b.t.y) continue;
      const topOrder = Math.sign(a.s.x - b.s.x);
      const botOrder = Math.sign(a.t.x - b.t.x);
      if (topOrder !== 0 && botOrder !== 0 && topOrder !== botOrder) crossings++;
    }
  }
  return crossings;
}
