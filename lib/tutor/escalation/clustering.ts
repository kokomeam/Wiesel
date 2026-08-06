/**
 * Escalation CLUSTERING (TUTOR-1 Wave 6 · P6.2) — PURE.
 *
 * When a consented escalation is synthesized we assign its question to a cluster:
 * the near-duplicate questions on ONE concept node collapse into ONE creator-
 * visible cluster (a count, never a roster). Assignment is nearest-cluster on the
 * SAME node by cosine similarity ≥ TUTOR_ESCALATION_CLUSTER_THRESHOLD.
 *
 * STABLE IDENTITY is the load-bearing invariant: a new member JOINS an existing
 * cluster (returning its id), and a cluster's id NEVER changes — the creator's
 * queue row must be durable as more learners ask. We therefore assign to the
 * nearest existing OPEN cluster (highest cosine that clears the bar); a question
 * that clears no cluster forms a new one (the caller mints the id). We never
 * re-shuffle or re-centroid an existing cluster here.
 *
 * The cosine helper is REUSED from lib/tutor/graph/canonicalize.ts (the same
 * in-process vector math the graph pipeline uses) — NO new dependency, one cosine
 * implementation across the tutor stack.
 */

import { cosineSimilarity } from "@/lib/tutor/graph/canonicalize";

/** One OPEN cluster the new question may join: its id, the node it lives on, and
 *  its representative-question embedding (the cluster's centroid stand-in — the
 *  vector of its earliest/most-central member). */
export interface OpenCluster {
  id: string;
  nodeId: string;
  centroidVector: number[];
}

/**
 * Assign a question's embedding to the nearest OPEN cluster on the SAME node, or
 * return null (→ the caller creates a new cluster). PURE.
 *
 * Only clusters whose `nodeId === sameNodeId` are eligible (a wrong-node cluster
 * NEVER joins — escalations cluster within a concept, not across the course). Among
 * the eligible clusters, the one with the HIGHEST cosine similarity ≥ `threshold`
 * wins; ties resolve to the FIRST such cluster in input order (stable, deterministic).
 * An empty/zero question vector clears nothing (cosine 0) → null → a new cluster.
 */
export function assignCluster(
  questionVector: number[],
  openClusters: OpenCluster[],
  sameNodeId: string,
  threshold: number
): string | null {
  let bestId: string | null = null;
  let bestSim = -Infinity;
  for (const cluster of openClusters) {
    if (cluster.nodeId !== sameNodeId) continue;
    const sim = cosineSimilarity(questionVector, cluster.centroidVector);
    if (sim >= threshold && sim > bestSim) {
      bestSim = sim;
      bestId = cluster.id;
    }
  }
  return bestId;
}
