/**
 * Typed error taxonomy for the concept-graph write paths — the two conditions
 * the DB write path (the tutor_upsert_concept_edge RPC) and the versioned node
 * update raise, translated from the RPC's message strings by the repository so
 * callers detect them without string-matching (mirrors lib/marketing/social/
 * errors.ts).
 */

/** A stale expectedVersion — the caller re-reads and re-applies, never
 *  force-writes (the social versioned-update rule, applied to the graph). */
export class TutorVersionConflictError extends Error {
  readonly entity: "concept_node" | "concept_edge";
  readonly id: string;
  constructor(entity: "concept_node" | "concept_edge", id: string) {
    super(`${entity} ${id}: version conflict — the row changed since you read it; re-read and re-apply`);
    this.name = "TutorVersionConflictError";
    this.entity = entity;
    this.id = id;
  }
}

/** Adding the edge would close a cycle among same-kind edges — the DAG
 *  invariant refuses it at the write path. Raised by the RPC as
 *  'concept_edge_cycle'; the renderer stays cycle-tolerant regardless. */
export class ConceptEdgeCycleError extends Error {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly kind: string;
  constructor(sourceNodeId: string, targetNodeId: string, kind: string) {
    super(
      `concept_edge_cycle: a ${kind} edge ${sourceNodeId} → ${targetNodeId} would create a cycle`
    );
    this.name = "ConceptEdgeCycleError";
    this.sourceNodeId = sourceNodeId;
    this.targetNodeId = targetNodeId;
    this.kind = kind;
  }
}
