/**
 * TUTOR-1 W1.4 — the publish→graph emission seam (Directive §1.3).
 *
 * Called by `publishCourse` AFTER `PublishRpcResultSchema.parse` (the publish
 * is committed; the identical-hash republish path early-returns BEFORE the RPC,
 * so a no-op republish never reaches this hook — AC-T1.6). Decides which graph
 * run the new publication needs and sends the matching Inngest event:
 *
 *   no graph rows for the course        → tutor/graph.extraction.requested
 *   graph rows exist (an ACTIVE graph)  → tutor/graph.reconciliation.requested
 *   a PENDING concept_graph change-set  → nothing (a review is already in
 *                                         flight; stacking a second run would
 *                                         race the creator's Accept/Reject —
 *                                         the next publish re-evaluates)
 *
 * BEST-EFFORT like every Inngest send in this repo: a failure logs and never
 * breaks the publish (the next republish re-enqueues; Wave-2+ adds a sweep).
 * Runs on the USER-scoped client — it only READS (the publisher is the author,
 * RLS admits the reads) and sends an event; no DB writes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

export type GraphPublishDecision =
  | "extraction"
  | "reconciliation"
  | "skipped_pending"
  | "skipped_error";

export async function enqueueGraphRunForPublish(
  client: DB,
  args: { courseId: string; publicationId: string }
): Promise<GraphPublishDecision> {
  try {
    // A pending concept_graph change-set means a staged run awaits review.
    const pending = await client
      .from("change_set_items")
      .select("change_set_id, change_sets!inner(id, status, course_id)")
      .eq("node_type", "concept_graph")
      .eq("change_sets.course_id", args.courseId)
      .eq("change_sets.status", "pending")
      .limit(1);
    if (pending.error) throw new Error(pending.error.message);
    if ((pending.data ?? []).length > 0) return "skipped_pending";

    const nodes = await client
      .from("concept_nodes")
      .select("id", { count: "exact", head: true })
      .eq("course_id", args.courseId);
    if (nodes.error) throw new Error(nodes.error.message);
    const hasGraph = (nodes.count ?? 0) > 0;

    const runId = crypto.randomUUID();
    // Lazy import: keep the Inngest SDK out of every graph that only publishes
    // (the versionedUpdateSocialPost → voiding lazy-import precedent).
    const events = await import("@/lib/inngest/tutorGraphEvents");
    if (hasGraph) {
      await events.sendTutorReconciliationRequested({
        courseId: args.courseId,
        publicationId: args.publicationId,
        runId,
      });
      return "reconciliation";
    }
    await events.sendTutorExtractionRequested({
      courseId: args.courseId,
      publicationId: args.publicationId,
      runId,
    });
    return "extraction";
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "tutor_graph_publish_hook",
        outcome: "error",
        courseId: args.courseId,
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return "skipped_error";
  }
}
