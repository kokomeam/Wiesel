/**
 * Concept graph — Zod single source of truth (TUTOR-1 Wave 1.2).
 *
 * Every shape is defined ONCE here and inferred everywhere: the repository
 * row-mappers, the extraction/reconciliation write paths, and the change-set
 * rail all import these. Types are never hand-written. Wire shape is camelCase
 * (the repo's row-mapper convention); slide ids are TEXT (jsonb short ids, not
 * uuids) so ConceptAnchorSchema.slideId is a plain string.
 */

import { z } from "zod";

/* ─────────────────────────────── consts ─────────────────────────────────── */

export const CONCEPT_EDGE_KINDS = ["prerequisite", "part_of", "related"] as const;
export const CONCEPT_NODE_STATUSES = ["active", "retired", "merged_into"] as const;
export const CONCEPT_NODE_CREATED_BY = ["extraction", "reconciliation", "creator"] as const;
export const ASSUMED_PRIOR_STATUSES = ["active", "dismissed"] as const;

export const ConceptEdgeKindSchema = z.enum(CONCEPT_EDGE_KINDS);
export const ConceptNodeStatusSchema = z.enum(CONCEPT_NODE_STATUSES);
export const ConceptNodeCreatedBySchema = z.enum(CONCEPT_NODE_CREATED_BY);
export const AssumedPriorStatusSchema = z.enum(ASSUMED_PRIOR_STATUSES);

export type ConceptEdgeKind = (typeof CONCEPT_EDGE_KINDS)[number];
export type ConceptNodeStatus = (typeof CONCEPT_NODE_STATUSES)[number];

/* ─────────────────────────────── anchors ────────────────────────────────── */

/** R-13 anchor shape: where a concept is taught. lessonId/blockId are uuids
 *  (row primary keys); slideId is a jsonb SHORT id (text), optional/nullable —
 *  a block-level anchor omits it (or the R-13 downgrade cleared it). */
export const ConceptAnchorSchema = z.object({
  lessonId: z.uuid(),
  blockId: z.uuid(),
  slideId: z.string().min(1).nullable().optional(),
});
export type ConceptAnchor = z.infer<typeof ConceptAnchorSchema>;

/* ──────────────────────────────── nodes ─────────────────────────────────── */

/** Domain shape of a concept_nodes row (camelCase mirror of the DDL). */
export const ConceptNodeSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  status: ConceptNodeStatusSchema,
  mergedIntoNodeId: z.uuid().nullable(),
  createdBy: ConceptNodeCreatedBySchema,
  creatorEdited: z.boolean(),
  aliases: z.array(z.string()),
  anchors: z.array(ConceptAnchorSchema),
  embedding: z.array(z.number()).nullable(),
  externalTaxonomyRef: z.unknown().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConceptNode = z.infer<typeof ConceptNodeSchema>;

/* ──────────────────────────────── edges ─────────────────────────────────── */

/** Domain shape of a concept_edges row (camelCase mirror of the DDL). */
export const ConceptEdgeSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  kind: ConceptEdgeKindSchema,
  evidenceRefs: z.array(z.unknown()),
  creatorLocked: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConceptEdge = z.infer<typeof ConceptEdgeSchema>;

/* ─────────────────────────── assumed priors ─────────────────────────────── */

/** Domain shape of an assumed_prior_nodes row. */
export const AssumedPriorSchema = z.object({
  id: z.uuid(),
  courseId: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string(),
  evidence: z.array(z.unknown()),
  status: AssumedPriorStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssumedPrior = z.infer<typeof AssumedPriorSchema>;

/* ────────────────────────── snapshot map row ────────────────────────────── */

/** Domain shape of a snapshot_concept_map row. */
export const SnapshotConceptMapRowSchema = z.object({
  publicationId: z.uuid(),
  nodeId: z.uuid(),
  courseId: z.uuid(),
  version: z.number().int(),
  anchors: z.array(ConceptAnchorSchema),
  anchorDowngraded: z.boolean(),
  createdAt: z.string(),
});
export type SnapshotConceptMapRow = z.infer<typeof SnapshotConceptMapRowSchema>;

/* ───────────────────── change-set item payload contract ─────────────────── */

/**
 * THE change-set item before/after payload contract. The sibling change-set
 * rail agent codes against exactly this shape — a graph mutation stages an item
 * whose before/after are each a `ConceptGraphItemPayload`:
 *   entity         which graph table the row belongs to
 *   row            the full row (loose record — the rail is entity-agnostic)
 *   classification how the reconciliation pass classified this change (nullable)
 *   lineage        optional provenance blob (merge/split ancestry) the rail
 *                  carries through opaquely
 */
export const ConceptGraphItemPayloadSchema = z.object({
  entity: z.enum(["concept_node", "concept_edge", "assumed_prior", "snapshot_map"]),
  row: z.record(z.string(), z.unknown()),
  classification: z.enum(["matched", "added", "removed", "split", "merged"]).nullable().optional(),
  lineage: z.unknown().optional(),
});
export type ConceptGraphItemPayload = z.infer<typeof ConceptGraphItemPayloadSchema>;
