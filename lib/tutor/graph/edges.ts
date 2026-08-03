/**
 * Concept EDGE inference + pure post-passes (TUTOR-1 Wave 1.3 · Directive §1.2 step 5).
 *
 * The model infers typed edges (prerequisite / part_of / related) over the
 * canonical node list; then a chain of PURE, unit-tested passes hardens the set
 * into a per-kind DAG the write path will accept without a cycle error:
 *   pruneEvidenceless   → drop edges with an empty/whitespace evidenceQuote
 *   dropLowConfidence   → drop edges below the confidence floor
 *   breakCyclesDropWeakest → per kind, remove the lowest-confidence edge on each cycle
 *   transitiveReduction → per kind, drop A→C when a longer A→…→C path exists
 *
 * The edge-inference SCHEMA + responseFormat name are the mock seam. The passes
 * operate on INDEX-addressed edges (sourceIndex/targetIndex into the node list),
 * kept index-addressed until the orchestrator maps them to node ids.
 */

import { z } from "zod";
import { CONCEPT_EDGE_KINDS, type ConceptEdgeKind } from "./schemas";

/* ─────────────────────── edge-inference schema ──────────────────────────── */

export const InferredEdgeSchema = z.object({
  sourceIndex: z.number().int().min(0),
  targetIndex: z.number().int().min(0),
  kind: z.enum(CONCEPT_EDGE_KINDS),
  confidence: z.number().min(0).max(1),
  evidenceQuote: z.string().max(300),
});
export type InferredEdge = z.infer<typeof InferredEdgeSchema>;

export const EdgeInferenceSchema = z.object({
  edges: z.array(InferredEdgeSchema),
});
export type EdgeInference = z.infer<typeof EdgeInferenceSchema>;

/** The responseFormat name — the mock's `opts.structured` map key. */
export const EDGE_RESPONSE_NAME = "graph_edge_inference";

export const EDGE_SYSTEM_PROMPT = [
  "You infer the DEPENDENCY STRUCTURE of a course's concepts.",
  "",
  "You are given a numbered list of concepts (index, title, description, and the",
  "lesson order they're taught in). Return directed edges between them:",
  "  prerequisite  — the source must be understood BEFORE the target",
  "  part_of       — the source is a component/sub-idea OF the target",
  "  related       — the two are associated but neither strictly precedes the other",
  "",
  "For each edge give sourceIndex, targetIndex, kind, a confidence in [0,1], and a",
  "short evidenceQuote (≤300 chars) grounding it. Do NOT create an edge from a",
  "concept to itself. Prefer FEW, high-confidence edges over many weak ones. The",
  "prerequisite and part_of relations must form a DAG (no circular dependencies).",
  "",
  "Return ONLY the JSON object matching the schema.",
].join("\n");

/* ─────────────────────────── pure passes ────────────────────────────────── */

/** Result of a pass: what it kept + what it dropped (for the run's dropped-edge log). */
export interface EdgePassResult {
  kept: InferredEdge[];
  dropped: InferredEdge[];
}

/** Drop edges whose evidenceQuote is empty/whitespace. Pure. */
export function pruneEvidenceless(edges: InferredEdge[]): EdgePassResult {
  const kept: InferredEdge[] = [];
  const dropped: InferredEdge[] = [];
  for (const e of edges) {
    if (e.evidenceQuote.trim().length === 0) dropped.push(e);
    else kept.push(e);
  }
  return { kept, dropped };
}

/** Drop edges below the confidence floor (strictly less than `min`). Pure. */
export function dropLowConfidence(edges: InferredEdge[], min: number): EdgePassResult {
  const kept: InferredEdge[] = [];
  const dropped: InferredEdge[] = [];
  for (const e of edges) {
    if (e.confidence < min) dropped.push(e);
    else kept.push(e);
  }
  return { kept, dropped };
}

/** Also drop self-loops (source===target) — the DB CHECK refuses them anyway, so
 *  removing them here keeps the write path from erroring. Pure. */
export function dropSelfLoops(edges: InferredEdge[]): EdgePassResult {
  const kept: InferredEdge[] = [];
  const dropped: InferredEdge[] = [];
  for (const e of edges) {
    if (e.sourceIndex === e.targetIndex) dropped.push(e);
    else kept.push(e);
  }
  return { kept, dropped };
}

/* ── cycle detection / breaking (per kind) ── */

/** Is there a directed cycle among `edges` (all one kind)? DFS with a recursion
 *  stack. Nodes are the union of every endpoint. Pure. */
function hasCycle(edges: InferredEdge[]): boolean {
  const adj = new Map<number, number[]>();
  const nodes = new Set<number>();
  for (const e of edges) {
    nodes.add(e.sourceIndex);
    nodes.add(e.targetIndex);
    const list = adj.get(e.sourceIndex) ?? [];
    list.push(e.targetIndex);
    adj.set(e.sourceIndex, list);
  }
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<number, number>();
  for (const n of nodes) color.set(n, WHITE);

  const stack: { node: number; iter: number }[] = [];
  for (const start of nodes) {
    if (color.get(start) !== WHITE) continue;
    stack.push({ node: start, iter: 0 });
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.iter < neighbors.length) {
        const next = neighbors[frame.iter];
        frame.iter += 1;
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) return true; // back-edge → cycle
        if (c === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, iter: 0 });
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }
  return false;
}

/** Find the edges ON a cycle (the strongly-connected participants). Returns the
 *  edges whose removal could break a cycle: every edge that lies within a
 *  non-trivial SCC. We approximate by returning edges between two GRAY-reachable
 *  cycle members — simplest correct approach: an edge is "on a cycle" iff its
 *  target can reach its source. Pure. */
function edgesOnCycle(edges: InferredEdge[]): InferredEdge[] {
  const adj = new Map<number, Set<number>>();
  for (const e of edges) {
    const set = adj.get(e.sourceIndex) ?? new Set<number>();
    set.add(e.targetIndex);
    adj.set(e.sourceIndex, set);
  }
  const canReach = (from: number, to: number): boolean => {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of adj.get(cur) ?? []) stack.push(n);
    }
    return false;
  };
  // An edge s→t is on a cycle iff t can reach s.
  return edges.filter((e) => canReach(e.targetIndex, e.sourceIndex));
}

/**
 * PER KIND, while a cycle exists remove the LOWEST-confidence edge lying on a
 * cycle; deterministic tie-break by original index (earliest index removed first
 * on a tie so the result is stable). Returns kept + dropped across all kinds.
 * Pure. An already-acyclic input is returned untouched (nothing dropped).
 */
export function breakCyclesDropWeakest(edges: InferredEdge[]): EdgePassResult {
  const dropped: InferredEdge[] = [];
  // Partition by kind — each kind is its own DAG (a 'related' loop is fine to the
  // DB's per-kind gate, but we harden all three uniformly).
  const byKind = new Map<ConceptEdgeKind, InferredEdge[]>();
  for (const e of edges) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  const keptAll: InferredEdge[] = [];
  for (const [, kindEdges] of byKind) {
    // Index each edge by its ORIGINAL position for the deterministic tie-break.
    let working = kindEdges.map((edge, i) => ({ edge, i }));
    while (hasCycle(working.map((w) => w.edge))) {
      const onCycle = edgesOnCycle(working.map((w) => w.edge));
      const onCycleKeys = new Set(onCycle.map((e) => `${e.sourceIndex}->${e.targetIndex}:${e.kind}`));
      // Candidates: working edges that are on a cycle.
      const candidates = working.filter((w) =>
        onCycleKeys.has(`${w.edge.sourceIndex}->${w.edge.targetIndex}:${w.edge.kind}`)
      );
      if (candidates.length === 0) break; // safety — shouldn't happen if hasCycle is true
      // Lowest confidence, tie-break by earliest original index.
      candidates.sort((a, b) => a.edge.confidence - b.edge.confidence || a.i - b.i);
      const victim = candidates[0];
      dropped.push(victim.edge);
      working = working.filter((w) => w !== victim);
    }
    keptAll.push(...working.map((w) => w.edge));
  }
  return { kept: keptAll, dropped };
}

/* ── transitive reduction (per kind) ── */

/**
 * PER KIND transitive reduction on an ACYCLIC edge set: remove a direct edge A→C
 * when a LONGER path A→…→C exists (via ≥1 intermediate). Pure DFS reachability
 * that EXCLUDES the direct edge under test. Assumes the input is already acyclic
 * (run `breakCyclesDropWeakest` first) — on a cyclic input it still terminates
 * (the seen-set bounds the DFS) but the result is only meaningful for a DAG.
 */
export function transitiveReduction(edges: InferredEdge[]): EdgePassResult {
  const dropped: InferredEdge[] = [];
  const byKind = new Map<ConceptEdgeKind, InferredEdge[]>();
  for (const e of edges) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  const keptAll: InferredEdge[] = [];
  for (const [, kindEdges] of byKind) {
    const kept: InferredEdge[] = [];
    // Adjacency over the FULL kind set (reduction tests against all edges).
    const adj = new Map<number, { to: number; edge: InferredEdge }[]>();
    for (const e of kindEdges) {
      const list = adj.get(e.sourceIndex) ?? [];
      list.push({ to: e.targetIndex, edge: e });
      adj.set(e.sourceIndex, list);
    }
    // Reachable(from, to) via a path that does NOT use the single direct edge `skip`.
    const reachableExcluding = (from: number, to: number, skip: InferredEdge): boolean => {
      const seen = new Set<number>();
      const stack = [from];
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const { to: nxt, edge } of adj.get(cur) ?? []) {
          if (edge === skip) continue; // never use the edge under test
          if (nxt === to) return true;
          stack.push(nxt);
        }
      }
      return false;
    };
    for (const e of kindEdges) {
      // Drop e = A→C if C is reachable from A WITHOUT using e (an indirect path).
      if (reachableExcluding(e.sourceIndex, e.targetIndex, e)) dropped.push(e);
      else kept.push(e);
    }
    keptAll.push(...kept);
  }
  return { kept: keptAll, dropped };
}
