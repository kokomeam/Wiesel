/**
 * Concept graph repository — EVERY read/write of concept_nodes / concept_edges /
 * assumed_prior_nodes / snapshot_concept_map / tutor_course_settings lives here
 * (plus the gate's generic entity restore in lib/tutor/graph/entities.ts).
 *
 * TWO write-path rules mirror the social pipeline:
 *   1) `versionedUpdateConceptNode` is the only legal content update to a node —
 *      `update … set …, version = expected+1 where id=$1 and version=$2`;
 *      zero rows ⇒ TutorVersionConflictError (the social versioned-update rule).
 *   2) Edge writes go EXCLUSIVELY through `upsertConceptEdge`, which calls the
 *      `tutor_upsert_concept_edge` definer RPC — the DAG cycle gate. There is no
 *      client insert/update policy on concept_edges, so a direct write is
 *      refused by RLS. The RPC's typed errors ('concept_edge_cycle' /
 *      'concept_edge_version_conflict') are translated to error classes here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { ConceptEdgeCycleError, TutorVersionConflictError } from "./errors";
import type {
  AssumedPrior,
  ConceptAnchor,
  ConceptEdge,
  ConceptEdgeKind,
  ConceptNode,
  SnapshotConceptMapRow,
} from "./schemas";
export type { ConceptEdgeKind } from "./schemas";

type DB = SupabaseClient<Database>;
type NodeRow = Database["public"]["Tables"]["concept_nodes"]["Row"];
type NodeInsert = Database["public"]["Tables"]["concept_nodes"]["Insert"];
type EdgeRow = Database["public"]["Tables"]["concept_edges"]["Row"];
type AssumedRow = Database["public"]["Tables"]["assumed_prior_nodes"]["Row"];
type AssumedInsert = Database["public"]["Tables"]["assumed_prior_nodes"]["Insert"];
type SnapshotRow = Database["public"]["Tables"]["snapshot_concept_map"]["Row"];
type SettingsRow = Database["public"]["Tables"]["tutor_course_settings"]["Row"];

/* ────────────────────────────── mapping ─────────────────────────────────── */

export function rowToConceptNode(row: NodeRow): ConceptNode {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    description: row.description,
    status: row.status as ConceptNode["status"],
    mergedIntoNodeId: row.merged_into_node_id,
    createdBy: row.created_by as ConceptNode["createdBy"],
    creatorEdited: row.creator_edited,
    aliases: (row.aliases as string[] | null) ?? [],
    anchors: (row.anchors as unknown as ConceptAnchor[] | null) ?? [],
    embedding: (row.embedding as number[] | null) ?? null,
    externalTaxonomyRef: (row.external_taxonomy_ref as unknown) ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToConceptEdge(row: EdgeRow): ConceptEdge {
  return {
    id: row.id,
    courseId: row.course_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    kind: row.kind as ConceptEdge["kind"],
    evidenceRefs: (row.evidence_refs as unknown[] | null) ?? [],
    creatorLocked: row.creator_locked,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToAssumedPrior(row: AssumedRow): AssumedPrior {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    description: row.description,
    evidence: (row.evidence as unknown[] | null) ?? [],
    status: row.status as AssumedPrior["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToSnapshotConceptMap(row: SnapshotRow): SnapshotConceptMapRow {
  return {
    publicationId: row.publication_id,
    nodeId: row.node_id,
    courseId: row.course_id,
    version: row.version,
    anchors: (row.anchors as unknown as ConceptAnchor[] | null) ?? [],
    anchorDowngraded: row.anchor_downgraded,
    createdAt: row.created_at,
  };
}

export interface TutorCourseSettings {
  courseId: string;
  enabled: boolean;
  budgetLimitUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export function rowToTutorCourseSettings(row: SettingsRow): TutorCourseSettings {
  return {
    courseId: row.course_id,
    enabled: row.enabled,
    budgetLimitUsd: row.budget_limit_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ─────────────────────────────── reads ──────────────────────────────────── */

export async function getConceptNode(supabase: DB, id: string): Promise<ConceptNode | null> {
  const { data, error } = await supabase.from("concept_nodes").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getConceptNode: ${error.message}`);
  return data ? rowToConceptNode(data) : null;
}

export async function listConceptNodes(
  supabase: DB,
  courseId: string,
  opts: { status?: ConceptNode["status"] } = {}
): Promise<ConceptNode[]> {
  let q = supabase.from("concept_nodes").select("*").eq("course_id", courseId);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) throw new Error(`listConceptNodes: ${error.message}`);
  return (data ?? []).map(rowToConceptNode);
}

export async function getConceptEdge(supabase: DB, id: string): Promise<ConceptEdge | null> {
  const { data, error } = await supabase.from("concept_edges").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getConceptEdge: ${error.message}`);
  return data ? rowToConceptEdge(data) : null;
}

export async function listConceptEdges(supabase: DB, courseId: string): Promise<ConceptEdge[]> {
  const { data, error } = await supabase
    .from("concept_edges")
    .select("*")
    .eq("course_id", courseId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listConceptEdges: ${error.message}`);
  return (data ?? []).map(rowToConceptEdge);
}

export async function listAssumedPriors(supabase: DB, courseId: string): Promise<AssumedPrior[]> {
  const { data, error } = await supabase
    .from("assumed_prior_nodes")
    .select("*")
    .eq("course_id", courseId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listAssumedPriors: ${error.message}`);
  return (data ?? []).map(rowToAssumedPrior);
}

export async function getTutorCourseSettings(
  supabase: DB,
  courseId: string
): Promise<TutorCourseSettings | null> {
  const { data, error } = await supabase
    .from("tutor_course_settings")
    .select("*")
    .eq("course_id", courseId)
    .maybeSingle();
  if (error) throw new Error(`getTutorCourseSettings: ${error.message}`);
  return data ? rowToTutorCourseSettings(data) : null;
}

/* ────────────────────────────── node writes ─────────────────────────────── */

export interface ConceptNodeCreateInput {
  courseId: string;
  title: string;
  description?: string;
  status?: ConceptNode["status"];
  mergedIntoNodeId?: string | null;
  createdBy?: ConceptNode["createdBy"];
  creatorEdited?: boolean;
  aliases?: string[];
  anchors?: ConceptAnchor[];
  embedding?: number[] | null;
}

export async function createConceptNode(
  supabase: DB,
  input: ConceptNodeCreateInput
): Promise<ConceptNode> {
  const insert: NodeInsert = {
    course_id: input.courseId,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "active",
    merged_into_node_id: input.mergedIntoNodeId ?? null,
    created_by: input.createdBy ?? "extraction",
    creator_edited: input.creatorEdited ?? false,
    aliases: (input.aliases ?? []) as unknown as Json,
    anchors: (input.anchors ?? []) as unknown as Json,
    embedding: (input.embedding ?? null) as unknown as Json,
  };
  const { data, error } = await supabase.from("concept_nodes").insert(insert).select("*").single();
  if (error || !data) throw new Error(`createConceptNode: ${error?.message}`);
  return rowToConceptNode(data);
}

/** THE versioned content update for a node (the social versioned-update rule).
 *  Zero rows ⇒ TutorVersionConflictError. `set` is the snake-cased column
 *  patch; `version` is always bumped to `expectedVersion + 1`. */
export async function versionedUpdateConceptNode(
  supabase: DB,
  id: string,
  expectedVersion: number,
  set: Partial<
    Pick<
      NodeRow,
      | "title"
      | "description"
      | "status"
      | "merged_into_node_id"
      | "created_by"
      | "creator_edited"
      | "aliases"
      | "anchors"
      | "embedding"
      | "external_taxonomy_ref"
    >
  >
): Promise<ConceptNode> {
  const { data, error } = await supabase
    .from("concept_nodes")
    .update({ ...set, version: expectedVersion + 1 })
    .eq("id", id)
    .eq("version", expectedVersion)
    .select("*");
  if (error) throw new Error(`versionedUpdateConceptNode: ${error.message}`);
  if (!data || data.length === 0) throw new TutorVersionConflictError("concept_node", id);
  return rowToConceptNode(data[0]);
}

export async function deleteConceptNode(supabase: DB, id: string): Promise<void> {
  const { error } = await supabase.from("concept_nodes").delete().eq("id", id);
  if (error) throw new Error(`deleteConceptNode: ${error.message}`);
}

/* ────────────────────────────── edge writes ─────────────────────────────── */

export interface ConceptEdgeUpsertInput {
  id: string;
  courseId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: ConceptEdgeKind;
  evidenceRefs?: unknown[];
  creatorLocked?: boolean;
}

/**
 * THE edge write path — calls the `tutor_upsert_concept_edge` definer RPC (the
 * cycle gate). Translates the RPC's typed errors:
 *   'concept_edge_cycle'            → ConceptEdgeCycleError
 *   'concept_edge_version_conflict' → TutorVersionConflictError
 * Every other RPC error (forbidden / bad node / self-loop / invalid kind) is
 * re-thrown as a plain Error carrying the RPC's message.
 */
export async function upsertConceptEdge(
  supabase: DB,
  edge: ConceptEdgeUpsertInput,
  expectedVersion?: number
): Promise<ConceptEdge> {
  const { data, error } = await supabase.rpc("tutor_upsert_concept_edge", {
    p_id: edge.id,
    p_course_id: edge.courseId,
    p_source_node_id: edge.sourceNodeId,
    p_target_node_id: edge.targetNodeId,
    p_kind: edge.kind,
    p_evidence_refs: (edge.evidenceRefs ?? []) as unknown as Json,
    p_creator_locked: edge.creatorLocked ?? false,
    // Optional DB arg — omit (don't pass null) when the caller doesn't pin a
    // version, so the RPC's `default null` applies.
    ...(expectedVersion !== undefined ? { p_expected_version: expectedVersion } : {}),
  });
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("concept_edge_cycle")) {
      throw new ConceptEdgeCycleError(edge.sourceNodeId, edge.targetNodeId, edge.kind);
    }
    if (msg.includes("concept_edge_version_conflict")) {
      throw new TutorVersionConflictError("concept_edge", edge.id);
    }
    throw new Error(`upsertConceptEdge: ${msg}`);
  }
  return rowToConceptEdge(data as unknown as EdgeRow);
}

export async function deleteConceptEdge(supabase: DB, id: string): Promise<void> {
  const { error } = await supabase.from("concept_edges").delete().eq("id", id);
  if (error) throw new Error(`deleteConceptEdge: ${error.message}`);
}

/* ────────────────────────── assumed-prior writes ────────────────────────── */

export interface AssumedPriorCreateInput {
  courseId: string;
  title: string;
  description?: string;
  evidence?: unknown[];
  status?: AssumedPrior["status"];
}

export async function upsertAssumedPrior(
  supabase: DB,
  input: AssumedPriorCreateInput
): Promise<AssumedPrior> {
  const row: AssumedInsert = {
    course_id: input.courseId,
    title: input.title,
    description: input.description ?? "",
    evidence: (input.evidence ?? []) as unknown as Json,
    status: input.status ?? "active",
  };
  const { data, error } = await supabase
    .from("assumed_prior_nodes")
    .upsert(row, { onConflict: "course_id,title" })
    .select("*")
    .single();
  if (error || !data) throw new Error(`upsertAssumedPrior: ${error?.message}`);
  return rowToAssumedPrior(data);
}

export async function deleteAssumedPrior(supabase: DB, id: string): Promise<void> {
  const { error } = await supabase.from("assumed_prior_nodes").delete().eq("id", id);
  if (error) throw new Error(`deleteAssumedPrior: ${error.message}`);
}

/* ─────────────────────────── settings writes ────────────────────────────── */

export async function upsertTutorCourseSettings(
  supabase: DB,
  courseId: string,
  patch: { enabled?: boolean; budgetLimitUsd?: number | null }
): Promise<TutorCourseSettings> {
  const row: Database["public"]["Tables"]["tutor_course_settings"]["Insert"] = {
    course_id: courseId,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.budgetLimitUsd !== undefined ? { budget_limit_usd: patch.budgetLimitUsd } : {}),
  };
  const { data, error } = await supabase
    .from("tutor_course_settings")
    .upsert(row, { onConflict: "course_id" })
    .select("*")
    .single();
  if (error || !data) throw new Error(`upsertTutorCourseSettings: ${error?.message}`);
  return rowToTutorCourseSettings(data);
}
