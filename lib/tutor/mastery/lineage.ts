/**
 * Concept-graph LINEAGE resolution for the mastery refold (TUTOR-1 Wave 2 · AC-T1.7).
 *
 * When the concept graph is reconciled, node ids change:
 *   MERGE — two active nodes collapse into a survivor. The absorbed rows land on
 *           concept_nodes with status='merged_into' + merged_into_node_id → the
 *           survivor. Evidence on an absorbed id must re-target the survivor.
 *   SPLIT — one active node becomes ≥2 children. The parent is retired; the split
 *           lives in an ACCEPTED change_set_items payload (node_type
 *           'concept_graph', payload.classification='split',
 *           payload.lineage {parentNodeId, childNodeIds, confidenceFactor}).
 *           Evidence on the parent redistributes to EACH child, discounted by the
 *           recorded confidenceFactor (we can't know which child the parent
 *           evidence was really about, so every child inherits it, weakened).
 *
 * `resolveNodeId` walks these maps TRANSITIVELY (a merged→then→split chain
 * resolves through both) with a depth guard, and is a pure lookup. An unknown /
 * still-active id resolves to itself at factor 1. A retired id with NO lineage
 * resolves to itself (the refold then silently drops it when it isn't in the
 * active node set — never an error).
 *
 * ZERO MODEL CALLS. The pure resolver has no I/O; `loadLineageIndex` reads the DB
 * with the admin client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/** The resolved lineage maps. `mergedInto`: absorbed nodeId → survivor nodeId.
 *  `splitInto`: parent nodeId → its children + the redistribution confidence. */
export interface LineageIndex {
  mergedInto: Map<string, string>;
  splitInto: Map<string, { children: string[]; confidenceFactor: number }>;
}

/** One resolved target: a live node id + the cumulative factor to weight evidence
 *  routed to it (1 for a straight merge/active; a split's confidenceFactor,
 *  multiplied along a chain). */
export interface ResolvedTarget {
  nodeId: string;
  factor: number;
}

/** Depth guard: lineage chains are shallow in practice; this caps a pathological
 *  cycle (a corrupt index) so resolution always terminates. */
const MAX_LINEAGE_DEPTH = 32;

/**
 * PURE. Resolve `nodeId` through the lineage index to the set of live target node
 * ids + the factor evidence routed there should carry.
 *
 *   - a merged id → its survivor at the inherited factor (merge is 1:1, factor 1);
 *   - a split parent → EACH child, factor × confidenceFactor;
 *   - an unknown / active / retired-without-lineage id → itself at the inherited
 *     factor (the refold drops it later if it isn't active).
 *
 * Chains resolve transitively (merge→split→…) and multiply factors. The depth
 * guard stops a cycle: on overflow the id resolves to itself at the current factor.
 */
export function resolveNodeId(index: LineageIndex, nodeId: string): { targets: ResolvedTarget[] } {
  const out: ResolvedTarget[] = [];
  const seen = new Set<string>();

  const walk = (id: string, factor: number, depth: number): void => {
    if (depth > MAX_LINEAGE_DEPTH || seen.has(id)) {
      out.push({ nodeId: id, factor });
      return;
    }
    seen.add(id);

    const survivor = index.mergedInto.get(id);
    if (survivor !== undefined) {
      walk(survivor, factor, depth + 1);
      return;
    }
    const split = index.splitInto.get(id);
    if (split !== undefined && split.children.length > 0) {
      for (const child of split.children) walk(child, factor * split.confidenceFactor, depth + 1);
      return;
    }
    // Terminal: an active / unknown / retired-without-lineage id resolves to itself.
    out.push({ nodeId: id, factor });
  };

  walk(nodeId, 1, 0);
  return { targets: out };
}

/* ─────────────────────────────── impure loader ──────────────────────────── */

type DB = SupabaseClient<Database>;

/**
 * Load the lineage index for a course from the DB (admin client):
 *   - MERGES from concept_nodes where status='merged_into' (id → merged_into_node_id);
 *   - SPLITS from ACCEPTED change_sets' change_set_items whose node_type is
 *     'concept_graph' and whose `after` payload has classification='split' —
 *     parse payload.lineage {parentNodeId, childNodeIds, confidenceFactor}.
 *
 * Best-effort per source: a malformed split payload is skipped (never throws the
 * refold). The caller passes the resulting index to `resolveNodeId`.
 */
export async function loadLineageIndex(supabase: DB, courseId: string): Promise<LineageIndex> {
  const mergedInto = new Map<string, string>();
  const splitInto = new Map<string, { children: string[]; confidenceFactor: number }>();

  // (1) MERGES — concept_nodes rows flipped to 'merged_into'.
  const { data: mergedRows, error: mergedErr } = await supabase
    .from("concept_nodes")
    .select("id, merged_into_node_id")
    .eq("course_id", courseId)
    .eq("status", "merged_into");
  if (mergedErr) throw new Error(`loadLineageIndex merges: ${mergedErr.message}`);
  for (const row of mergedRows ?? []) {
    const survivor = (row as { merged_into_node_id: string | null }).merged_into_node_id;
    const id = (row as { id: string }).id;
    if (survivor) mergedInto.set(id, survivor);
  }

  // (2) SPLITS — accepted change_set_items concept_graph payloads.
  const { data: splitRows, error: splitErr } = await supabase
    .from("change_set_items")
    .select("after, change_sets!inner(status, course_id)")
    .eq("node_type", "concept_graph")
    .eq("change_sets.course_id", courseId)
    .eq("change_sets.status", "accepted");
  if (splitErr) throw new Error(`loadLineageIndex splits: ${splitErr.message}`);
  for (const row of splitRows ?? []) {
    const after = (row as { after: unknown }).after;
    const parsed = parseSplitLineage(after);
    if (parsed) {
      // Last-writer-wins on a re-split of the same parent (a later reconciliation
      // supersedes an earlier one — accepted rows are ordered by acceptance).
      splitInto.set(parsed.parentNodeId, {
        children: parsed.childNodeIds,
        confidenceFactor: parsed.confidenceFactor,
      });
    }
  }

  return { mergedInto, splitInto };
}

/** PURE. Extract a split lineage from a change_set_items `after` payload, or null
 *  when it isn't a split (classification !== 'split') or is malformed. */
export function parseSplitLineage(
  after: unknown
): { parentNodeId: string; childNodeIds: string[]; confidenceFactor: number } | null {
  if (!after || typeof after !== "object") return null;
  const payload = after as Record<string, unknown>;
  if (payload.classification !== "split") return null;
  const lineage = payload.lineage;
  if (!lineage || typeof lineage !== "object") return null;
  const l = lineage as Record<string, unknown>;
  const parentNodeId = l.parentNodeId;
  const childNodeIds = l.childNodeIds;
  const confidenceFactor = l.confidenceFactor;
  if (typeof parentNodeId !== "string" || parentNodeId.length === 0) return null;
  if (!Array.isArray(childNodeIds) || childNodeIds.length === 0) return null;
  const children = childNodeIds.filter((c): c is string => typeof c === "string" && c.length > 0);
  if (children.length === 0) return null;
  const factor = typeof confidenceFactor === "number" && Number.isFinite(confidenceFactor) ? confidenceFactor : 1;
  return { parentNodeId, childNodeIds: children, confidenceFactor: factor };
}
