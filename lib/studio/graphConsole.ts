/**
 * Concept graph console loader (TUTOR-1 Wave 5, P5.2).
 *
 * `loadGraphConsole(supabase, courseId)` is the ONE round trip the Concept Graph
 * tab makes: the author-gated definer RPC `tutor_graph_console(p_course_id)`
 * (migration 20260805110000). It mirrors loadTutorConsole / loadAnalyticsDashboard
 * -- call through rpcJson with a hand-authored Zod schema (the jsonb RPC returns
 * Json, so there is nothing to splice into database.types.ts) and return `null`
 * when the RPC returns null (non-author / missing course -> the tab 404s). Any
 * transport/parse error also collapses to null so the tab 404s rather than 500s.
 *
 * PRIVACY: the RPC has ALREADY applied the >=5 cohort floor to the `mastery` and
 * `confusion` overlays (a below-floor node/block -> suppressed:true with the value
 * NULL). This module never recomputes a floor -- the raw learner tables are
 * unreadable to authors by any path; the RPC is the ONLY surface.
 *
 * FROZEN CONTRACT: the exported `GraphConsoleBundle` + sub-types are the interface
 * the UI agent (P5.2 steps 6-7) codes against. Field names match the RPC's jsonb
 * keys EXACTLY (row overlays keep snake_case node_id/block_id/etc; the bundle-level
 * keys are the camelCase the RPC emits: assumedPriors / pendingChangeSetId /
 * evidenceByNode). Do NOT rename them.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";

type DB = SupabaseClient<Database>;

/* -------------------------------- schemas -------------------------------- */

/** A concept_nodes row, verbatim (to_jsonb(n)) -- snake_case columns. Unknown
 *  columns are tolerated (passthrough) so a later column add never breaks the
 *  loader; the known columns the UI reads are typed. */
const ConceptNodeRowSchema = z
  .object({
    id: z.string(),
    course_id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["active", "retired", "merged_into"]),
    merged_into_node_id: z.string().nullable(),
    created_by: z.enum(["extraction", "reconciliation", "creator"]),
    creator_edited: z.boolean(),
    aliases: z.array(z.string()).nullable().default([]),
    anchors: z.array(z.unknown()).nullable().default([]),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();
export type ConceptNodeRow = z.infer<typeof ConceptNodeRowSchema>;

/** A concept_edges row, verbatim (to_jsonb(e)). */
const ConceptEdgeRowSchema = z
  .object({
    id: z.string(),
    course_id: z.string(),
    source_node_id: z.string(),
    target_node_id: z.string(),
    kind: z.enum(["prerequisite", "part_of", "related"]),
    evidence_refs: z.array(z.unknown()).nullable().default([]),
    creator_locked: z.boolean(),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();
export type ConceptEdgeRow = z.infer<typeof ConceptEdgeRowSchema>;

/** An assumed_prior_nodes row, verbatim (to_jsonb(a)). */
const AssumedPriorRowSchema = z
  .object({
    id: z.string(),
    course_id: z.string(),
    title: z.string(),
    description: z.string(),
    evidence: z.array(z.unknown()).nullable().default([]),
    status: z.enum(["active", "dismissed"]),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();
export type AssumedPriorRow = z.infer<typeof AssumedPriorRowSchema>;

/** Cohort-FLOORED mastery overlay per node. suppressed=true (below the >=5 floor)
 *  => avg_decayed_p and learner_count are NULL (no number to show). */
const MasteryOverlaySchema = z.object({
  node_id: z.string(),
  avg_decayed_p: z.number().nullable(),
  learner_count: z.number().int().nullable(),
  suppressed: z.boolean(),
});
export type MasteryOverlay = z.infer<typeof MasteryOverlaySchema>;

/** Cohort-FLOORED confusion overlay per block. suppressed=true => the pct/count
 *  are NULL (no shading number). */
const ConfusionOverlaySchema = z.object({
  block_id: z.string(),
  confusing_pct: z.number().nullable(),
  confusing_count: z.number().int().nullable(),
  suppressed: z.boolean(),
});
export type ConfusionOverlay = z.infer<typeof ConfusionOverlaySchema>;

/** One landed clarification on a node (P6.4): a promoted escalation cluster whose
 *  change-set the creator ACCEPTED. Identity-free — the memberCount is an aggregate
 *  ("clarified after N learners asked"), never a roster. */
const NodeClarificationSchema = z.object({
  clusterId: z.string(),
  memberCount: z.number().int(),
});
export type NodeClarification = z.infer<typeof NodeClarificationSchema>;

/** The whole bundle -- one author-gated round trip. */
const GraphConsoleBundleSchema = z.object({
  nodes: z.array(ConceptNodeRowSchema),
  edges: z.array(ConceptEdgeRowSchema),
  /** cohort-floored mastery overlay (one entry per node with cohort data). */
  mastery: z.array(MasteryOverlaySchema),
  /** cohort-floored confusion overlay (one entry per feedback-bearing block). */
  confusion: z.array(ConfusionOverlaySchema),
  assumedPriors: z.array(AssumedPriorRowSchema),
  /** the pending concept_graph change-set awaiting review, or null. */
  pendingChangeSetId: z.string().nullable(),
  /** node_id -> the evidence jsonb stamped on that node's change-set item. */
  evidenceByNode: z.record(z.string(), z.unknown()),
  /** node_id -> the landed clarifications on that node (P6.4). A node with no
   *  accepted promotion is simply absent. Defaulted so a pre-P6.4 payload (or an
   *  RPC that hasn't shipped the column) parses to an empty map. */
  clarifications: z.record(z.string(), z.array(NodeClarificationSchema)).default({}),
});

/** FROZEN for the UI agent. */
export type GraphConsoleBundle = z.infer<typeof GraphConsoleBundleSchema>;

/* -------------------------------- loader --------------------------------- */

/**
 * One round trip for the Concept Graph tab. Returns null when the course doesn't
 * exist or the caller isn't its author (the RPC authorizes internally -> null) --
 * the tab turns that into a 404. Transport / mis-shaped-payload errors also
 * collapse to null (logged) so the tab 404s rather than surfacing a 500.
 */
export async function loadGraphConsole(
  supabase: DB,
  courseId: string
): Promise<GraphConsoleBundle | null> {
  try {
    const data = await rpcJson(
      supabase,
      "tutor_graph_console",
      { p_course_id: courseId },
      GraphConsoleBundleSchema.nullable()
    );
    return data;
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "tutor_graph_console_load",
        courseId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
    return null;
  }
}
