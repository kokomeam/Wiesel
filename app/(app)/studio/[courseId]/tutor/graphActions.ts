"use server";

/**
 * Concept Graph console server actions (TUTOR-1 Wave 5, P5.2).
 *
 * Every action AUTHOR-GATES (loads the course under the USER-scoped client and
 * checks author_id === the caller; RLS is the backstop, the explicit gate keeps a
 * non-author from ever reaching a write path). Results are DISCRIMINATED so the
 * client can branch (conflict / cycle / error) without throwing:
 *   - a stale expectedVersion  -> { conflict:true, message }   (re-read + re-apply)
 *   - a cycle-creating edge     -> { cycle:true, message }       (naming the path)
 *   - any other failure         -> { ok:false, error }
 *
 * Write paths are the FROZEN repository primitives -- versionedUpdateConceptNode
 * (the social versioned-update rule) and upsertConceptEdge (the tutor_upsert_
 * concept_edge DAG-gate RPC, the ONLY legal edge writer). The DAG constraint is
 * the RPC's job; these actions never enforce it themselves. Merge routes through
 * the tutor_merge_concept_nodes definer RPC (the ONLY legal writer of the
 * service-role-only learner_mastery). Accept/Reject reuse lib/ai/changeSet.ts.
 *
 * These signatures are FROZEN for the UI agent (P5.2 steps 6-7).
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import {
  getConceptNode,
  versionedUpdateConceptNode,
  upsertConceptEdge,
  createConceptNode,
  type ConceptEdgeKind,
} from "@/lib/tutor/graph/repository";
import { ConceptEdgeCycleError, TutorVersionConflictError } from "@/lib/tutor/graph/errors";
import { acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import { getOrCreateConversation, saveUserMessage } from "@/lib/ai/conversations";

/* -------------------------------- results -------------------------------- */

/** A versioned node edit result: ok, a version conflict, or a hard error. */
export type NodeEditResult =
  | { ok: true; version: number }
  | { ok: false; conflict: true; message: string }
  | { ok: false; error: string };

/** An edge write result: ok, a cycle refusal (naming the path), a version
 *  conflict, or a hard error. */
export type EdgeEditResult =
  | { ok: true; edgeId: string; version: number }
  | { ok: false; cycle: true; message: string }
  | { ok: false; conflict: true; message: string }
  | { ok: false; error: string };

/** A simple ok/error result (remove edge, merge, split, retire, accept/reject,
 *  primer request). */
export type SimpleResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** merge result carries the RPC's fold report. */
export type MergeResult =
  | { ok: true; survivorNodeId: string; absorbedCount: number; masteryRowsFolded: number }
  | { ok: false; error: string };

/** split result carries the created children ids. */
export type SplitResult =
  | { ok: true; childNodeIds: string[] }
  | { ok: false; error: string };

/* ------------------------------- author gate ------------------------------ */

/** Author-gate: the caller must be signed in AND the course's author. Returns
 *  the user id, throws a redirect for an anon caller, or { forbidden } for a
 *  signed-in non-author. */
async function requireAuthor(
  courseId: string
): Promise<{ userId: string } | { forbidden: true }> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?redirectTo=/studio/${courseId}/tutor`);
  const supabase = await createClient();
  const { data } = await supabase
    .from("courses")
    .select("author_id")
    .eq("id", courseId)
    .maybeSingle();
  if (!data || data.author_id !== user.id) return { forbidden: true };
  return { userId: user.id };
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/* ------------------------------- node edits ------------------------------ */

/**
 * Rename a node (the versioned content-update path). A stale expectedVersion is
 * reported as a conflict so the UI re-reads and re-applies (never a force-write).
 */
export async function renameNodeAction(
  courseId: string,
  nodeId: string,
  title: string,
  expectedVersion: number
): Promise<NodeEditResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    return { ok: false, error: "A concept title must be 1-200 characters." };
  }
  const supabase = await createClient();
  try {
    const node = await versionedUpdateConceptNode(supabase, nodeId, expectedVersion, {
      title: trimmed,
      creator_edited: true,
    });
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, version: node.version };
  } catch (err) {
    if (err instanceof TutorVersionConflictError) {
      return { ok: false, conflict: true, message: "This concept changed since you loaded it -- reload and re-apply." };
    }
    return { ok: false, error: errMsg(err, "Failed to rename the concept.") };
  }
}

/**
 * Edit a node's description (versioned).
 */
export async function editNodeDescriptionAction(
  courseId: string,
  nodeId: string,
  description: string,
  expectedVersion: number
): Promise<NodeEditResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  if (description.length > 2000) {
    return { ok: false, error: "A concept description must be at most 2000 characters." };
  }
  const supabase = await createClient();
  try {
    const node = await versionedUpdateConceptNode(supabase, nodeId, expectedVersion, {
      description,
      creator_edited: true,
    });
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, version: node.version };
  } catch (err) {
    if (err instanceof TutorVersionConflictError) {
      return { ok: false, conflict: true, message: "This concept changed since you loaded it -- reload and re-apply." };
    }
    return { ok: false, error: errMsg(err, "Failed to edit the description.") };
  }
}

/**
 * Set a node's lifecycle status (active | retired | merged_into) -- versioned.
 * (retireNodeAction is the friendly 'retired' shortcut; this is the general path
 * the UI uses for status toggles.)
 */
export async function setNodeStatusAction(
  courseId: string,
  nodeId: string,
  status: "active" | "retired" | "merged_into",
  expectedVersion: number
): Promise<NodeEditResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();
  try {
    const node = await versionedUpdateConceptNode(supabase, nodeId, expectedVersion, {
      status,
      creator_edited: true,
    });
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, version: node.version };
  } catch (err) {
    if (err instanceof TutorVersionConflictError) {
      return { ok: false, conflict: true, message: "This concept changed since you loaded it -- reload and re-apply." };
    }
    return { ok: false, error: errMsg(err, "Failed to update the status.") };
  }
}

/**
 * Retire a node (status -> 'retired', versioned). Sugar over setNodeStatusAction.
 */
export async function retireNodeAction(
  courseId: string,
  nodeId: string,
  expectedVersion: number
): Promise<NodeEditResult> {
  return setNodeStatusAction(courseId, nodeId, "retired", expectedVersion);
}

/* ------------------------------- edge edits ------------------------------ */

/**
 * Add (or upsert) an edge through the DAG-gate RPC. A cycle-creating edge is
 * refused with a SPECIFIC message naming the path (AC-T5.3). A fresh edge mints
 * a new id.
 */
export async function addEdgeAction(
  courseId: string,
  sourceNodeId: string,
  targetNodeId: string,
  kind: ConceptEdgeKind
): Promise<EdgeEditResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  if (sourceNodeId === targetNodeId) {
    return { ok: false, error: "An edge can't connect a concept to itself." };
  }
  const supabase = await createClient();
  try {
    const edge = await upsertConceptEdge(supabase, {
      id: crypto.randomUUID(),
      courseId,
      sourceNodeId,
      targetNodeId,
      kind,
    });
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, edgeId: edge.id, version: edge.version };
  } catch (err) {
    if (err instanceof ConceptEdgeCycleError) {
      // The message pattern the UI shows verbatim.
      return { ok: false, cycle: true, message: err.message };
    }
    if (err instanceof TutorVersionConflictError) {
      return { ok: false, conflict: true, message: "This edge changed since you loaded it -- reload and re-apply." };
    }
    return { ok: false, error: errMsg(err, "Failed to add the edge.") };
  }
}

/**
 * Remove an edge. Deletes by id (author-only DELETE policy on concept_edges).
 */
export async function removeEdgeAction(
  courseId: string,
  edgeId: string
): Promise<SimpleResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("concept_edges")
    .delete()
    .eq("id", edgeId)
    .eq("course_id", courseId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/studio/${courseId}/tutor`);
  return { ok: true };
}

/**
 * Lock / unlock an edge (creator_locked). A locked edge is never auto-touched by
 * reconciliation. Routes through the upsert RPC (the sole edge write path); the
 * kind is preserved. expectedVersion pins the versioned write.
 */
export async function lockEdgeAction(
  courseId: string,
  edgeId: string,
  sourceNodeId: string,
  targetNodeId: string,
  kind: ConceptEdgeKind,
  locked: boolean,
  expectedVersion: number
): Promise<EdgeEditResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();
  try {
    const edge = await upsertConceptEdge(
      supabase,
      { id: edgeId, courseId, sourceNodeId, targetNodeId, kind, creatorLocked: locked },
      expectedVersion
    );
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, edgeId: edge.id, version: edge.version };
  } catch (err) {
    if (err instanceof ConceptEdgeCycleError) return { ok: false, cycle: true, message: err.message };
    if (err instanceof TutorVersionConflictError) {
      return { ok: false, conflict: true, message: "This edge changed since you loaded it -- reload and re-apply." };
    }
    return { ok: false, error: errMsg(err, "Failed to update the edge lock.") };
  }
}

/**
 * Change an edge's kind (prerequisite | part_of | related) through the DAG-gate
 * RPC. Changing to 'prerequisite' can create a cycle -> refused with the specific
 * message. expectedVersion pins the versioned write.
 */
export async function setEdgeKindAction(
  courseId: string,
  edgeId: string,
  sourceNodeId: string,
  targetNodeId: string,
  kind: ConceptEdgeKind,
  expectedVersion: number
): Promise<EdgeEditResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();
  try {
    const edge = await upsertConceptEdge(
      supabase,
      { id: edgeId, courseId, sourceNodeId, targetNodeId, kind },
      expectedVersion
    );
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, edgeId: edge.id, version: edge.version };
  } catch (err) {
    if (err instanceof ConceptEdgeCycleError) return { ok: false, cycle: true, message: err.message };
    if (err instanceof TutorVersionConflictError) {
      return { ok: false, conflict: true, message: "This edge changed since you loaded it -- reload and re-apply." };
    }
    return { ok: false, error: errMsg(err, "Failed to change the edge kind.") };
  }
}

/* --------------------------- merge / split ------------------------------- */

/**
 * Merge nodes into a survivor (AC-T5.4). The tutor_merge_concept_nodes definer
 * RPC is the ONLY legal path -- it folds learner_mastery (evidence-weighted mean),
 * re-points edges (dropping self-loops/dupes), and retires the absorbed nodes.
 * The caller passes the survivor id (chosen by the UI via the reconcile survivor
 * rule) + the absorbed ids.
 */
export async function mergeNodesAction(
  courseId: string,
  survivorNodeId: string,
  absorbedNodeIds: string[]
): Promise<MergeResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  if (absorbedNodeIds.some((id) => id === survivorNodeId)) {
    return { ok: false, error: "The survivor can't also be an absorbed node." };
  }
  const supabase = await createClient();
  // tutor_merge_concept_nodes is a new definer RPC not yet in the generated
  // types — go through the rpcJson escape-hatch cast (the house pre-splice idiom).
  const { data, error } = await (
    supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc("tutor_merge_concept_nodes", {
    p_course_id: courseId,
    p_survivor_node_id: survivorNodeId,
    p_absorbed_node_ids: absorbedNodeIds,
  });
  if (error) return { ok: false, error: error.message };
  const payload = (data ?? {}) as { survivorNodeId?: string; absorbedCount?: number; masteryRowsFolded?: number };
  revalidatePath(`/studio/${courseId}/tutor`);
  return {
    ok: true,
    survivorNodeId: payload.survivorNodeId ?? survivorNodeId,
    absorbedCount: payload.absorbedCount ?? 0,
    masteryRowsFolded: payload.masteryRowsFolded ?? 0,
  };
}

/**
 * Split a node into children + retire the parent. Inserts N child concept nodes
 * (created_by 'creator', anchored to the parent's anchors so they stay joinable),
 * then retires the parent (versioned) with merged_into_node_id left null (a split
 * is a fan-out, not a merge). Authors NO course content -- concept nodes only.
 */
export async function splitNodeAction(
  courseId: string,
  parentNodeId: string,
  childTitles: string[],
  expectedParentVersion: number
): Promise<SplitResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const titles = childTitles.map((t) => t.trim()).filter((t) => t.length >= 1 && t.length <= 200);
  if (titles.length < 2) {
    return { ok: false, error: "A split needs at least two distinct child titles." };
  }
  const supabase = await createClient();
  try {
    const parent = await getConceptNode(supabase, parentNodeId);
    if (!parent || parent.courseId !== courseId) {
      return { ok: false, error: "Concept not found." };
    }
    const childIds: string[] = [];
    for (const title of titles) {
      const child = await createConceptNode(supabase, {
        courseId,
        title,
        createdBy: "creator",
        creatorEdited: true,
        anchors: parent.anchors,
      });
      childIds.push(child.id);
    }
    // Retire the parent (versioned; the pinned version guards a concurrent edit).
    await versionedUpdateConceptNode(supabase, parentNodeId, expectedParentVersion, {
      status: "retired",
      creator_edited: true,
    });
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, childNodeIds: childIds };
  } catch (err) {
    if (err instanceof TutorVersionConflictError) {
      return { ok: false, error: "This concept changed since you loaded it -- reload and re-apply." };
    }
    return { ok: false, error: errMsg(err, "Failed to split the concept.") };
  }
}

/* -------------------------- change-set review ---------------------------- */

/**
 * Accept the pending concept_graph change-set (AC-W5G.2) -- the staged rows are
 * already live; this resolves the set so the review highlight clears.
 */
export async function acceptGraphChangeSetAction(
  courseId: string,
  changeSetId: string
): Promise<SimpleResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();
  try {
    await acceptChangeSet(supabase, changeSetId);
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err, "Failed to accept the changes.") };
  }
}

/**
 * Reject the pending concept_graph change-set (AC-W5G.2) -- atomically restores
 * every staged concept_graph item byte-for-byte through lib/tutor/railRestore
 * (rejectChangeSet routes graph items there), all-or-nothing.
 */
export async function rejectGraphChangeSetAction(
  courseId: string,
  changeSetId: string
): Promise<SimpleResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();
  try {
    await rejectChangeSet(supabase, changeSetId, gate.userId);
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err, "Failed to reject the changes.") };
  }
}

/* -------------------------- primer lesson request ------------------------- */

/**
 * File a "draft a primer lesson" request to the Course orchestrator via its
 * NORMAL flow (this wave authors NO course content). The orchestrator's entry
 * point is a conversation user-message: we seed one on the course's agent thread
 * describing the assumed-prior gap, exactly as a creator typing the request would.
 * The docked agent picks it up on its next run. Returns the conversation id so
 * the UI can deep-link the creator into the agent panel.
 */
export async function requestPrimerLessonAction(
  courseId: string,
  assumedPriorTitle: string,
  assumedPriorId: string
): Promise<SimpleResult<{ conversationId: string }>> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();
  try {
    // A course-level thread (lessonId unknown -> pass the course id; the FK check
    // inside getOrCreateConversation stores lesson_id NULL when it isn't a lesson).
    const conversationId = await getOrCreateConversation(supabase, courseId, courseId);
    const request =
      `Draft a short primer lesson covering the assumed-prior concept "${assumedPriorTitle}". ` +
      `The course leans on this concept but never teaches it (assumed_prior id ${assumedPriorId}). ` +
      `Keep it a brief foundational lesson so learners who lack this background can catch up.`;
    await saveUserMessage(supabase, conversationId, courseId, request);
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, conversationId };
  } catch (err) {
    return { ok: false, error: errMsg(err, "Failed to file the primer request.") };
  }
}
