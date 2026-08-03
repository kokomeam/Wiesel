/**
 * PERF-1 C1 — /studio (editor variant) bundle loader.
 *
 * ONE SECURITY DEFINER round trip (`public.studio_course_bundle`, migration
 * 20260717100500) replaces the page's former 7-query load: the courses row
 * awaited alone, then Promise.all(modules/lessons/blocks, getPendingBlocks
 * [2-hop], getPendingNodes [duplicate change_sets query], findings count).
 *
 * Zod-first: the payload contract lives in the schema below and the exported
 * types are INFERRED from it. The tree rows stay loosely-typed passthrough
 * records — the RPC emits `to_jsonb(table row)`, i.e. exactly the
 * `select("*")` shapes, and `courseDocFromRows` revalidates/normalizes the
 * structure it needs (jsonb `content` payloads included).
 *
 * Authorization lives INSIDE the RPC (author-only; auth.uid() pinned there).
 * A missing/forbidden course returns null → the page redirects to the
 * gallery, exactly like the old `.maybeSingle()` miss. Testable per
 * AC-PERF-07: the supabase client is a parameter, so a counting client can
 * assert the single round trip.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";

type DB = SupabaseClient<Database>;
type CourseRow = Database["public"]["Tables"]["courses"]["Row"];
type ModuleRow = Database["public"]["Tables"]["modules"]["Row"];
type LessonRow = Database["public"]["Tables"]["lessons"]["Row"];
type BlockRow = Database["public"]["Tables"]["blocks"]["Row"];

/** A full table row as jsonb — courseDocFromRows revalidates the fields it uses. */
const RowSchema = z.record(z.string(), z.unknown());

const PendingBlockRowSchema = z.object({
  block_id: z.string(),
  change_set_id: z.string(),
  op: z.string(),
  node_type: z.string(),
  evidence: z.unknown(),
});

// The studio bundle RPC now also emits concept_graph pending items (W1.2B). Accept
// them at the schema boundary; they're filtered out of `pendingNodes` below — a
// concept_graph item is NOT a course-document outline node, so the outline-sidebar
// surface (the only consumer of `pendingNodes`) never receives one. The graph
// review UI reads its pending set separately.
const PendingNodeRowSchema = z.object({
  node_id: z.string(),
  node_type: z.enum(["module", "lesson", "concept_graph"]),
  change_set_id: z.string(),
  op: z.string(),
});

const StudioBundleSchema = z
  .object({
    course: RowSchema,
    modules: z.array(RowSchema),
    lessons: z.array(RowSchema),
    blocks: z.array(RowSchema),
    pending_blocks: z.array(PendingBlockRowSchema),
    pending_nodes: z.array(PendingNodeRowSchema),
    open_findings: z.number().int(),
  })
  .nullable();

/** Same shape StudioLoader's `pendingBlocks` prop consumed before (getPendingBlocks). */
export interface StudioPendingBlock {
  blockId: string;
  changeSetId: string;
  op: string;
  evidence: Json | null;
}

/** Same shape StudioLoader's `pendingNodes` prop consumed before (getPendingNodes). */
export interface StudioPendingNode {
  nodeId: string;
  nodeType: "module" | "lesson";
  changeSetId: string;
  op: string;
}

export interface StudioCourseBundle {
  course: CourseRow;
  modules: ModuleRow[];
  lessons: LessonRow[];
  blocks: BlockRow[];
  pendingBlocks: StudioPendingBlock[];
  pendingNodes: StudioPendingNode[];
  openFindings: number;
}

/**
 * Load everything the studio editor view needs in one round trip. Returns
 * null when the course is missing or the caller isn't its author (the page
 * redirects to the gallery, as before).
 */
export async function loadStudioCourse(
  supabase: DB,
  courseId: string
): Promise<StudioCourseBundle | null> {
  const raw = await rpcJson(
    supabase,
    "studio_course_bundle",
    { p_course_id: courseId },
    StudioBundleSchema
  );
  if (raw === null) return null;

  return {
    // to_jsonb(row) is the exact select("*") shape; zod kept it a loose
    // record (content jsonb varies per block type) — cast to the Row types
    // courseDocFromRows takes. It normalizes/defaults every field it reads.
    course: raw.course as unknown as CourseRow,
    modules: raw.modules as unknown as ModuleRow[],
    lessons: raw.lessons as unknown as LessonRow[],
    blocks: raw.blocks as unknown as BlockRow[],
    pendingBlocks: raw.pending_blocks.map((i) => ({
      blockId: i.block_id,
      changeSetId: i.change_set_id,
      op: i.op,
      evidence: (i.evidence ?? null) as Json | null,
    })),
    // Outline nodes only: concept_graph pending items ride the same RPC field but
    // are not course-document nodes, so they don't drive the outline highlight.
    pendingNodes: raw.pending_nodes
      .filter((i): i is typeof i & { node_type: "module" | "lesson" } => i.node_type === "module" || i.node_type === "lesson")
      .map((i) => ({
        nodeId: i.node_id,
        nodeType: i.node_type,
        changeSetId: i.change_set_id,
        op: i.op,
      })),
    openFindings: raw.open_findings,
  };
}
