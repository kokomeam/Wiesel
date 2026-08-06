/**
 * Creator Escalation Queue loader (TUTOR-1 Wave 6 · P6.2).
 *
 * `loadEscalationQueue(supabase, courseId)` is the ONE author-gated round trip the
 * P6.3 console "Escalations" tab makes: the definer RPC `tutor_escalation_queue`
 * (migration 20260806110000). It mirrors loadTutorConsole — call through rpcJson
 * with a hand-authored Zod schema (the RPC returns jsonb, nothing to splice), and
 * return `[]` when the RPC returns null (non-author / missing course) so the tab
 * renders an empty queue rather than 500ing.
 *
 * PRIVACY: the RPC returns COUNTS ONLY — never a user_id or roster. The identity-
 * bearing escalation_dossier is unreadable to every client role; this loader can
 * only ever see the identity-free cluster surface. `EscalationCluster` is the
 * FROZEN type P6.3's queue tab codes against.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";

type DB = SupabaseClient<Database>;

/** One teaching anchor for a cluster's concept node — the R-13 anchor shape (a
 *  slide-level anchor omits slideId when downgraded to block level). Lets the queue
 *  deep-link into the lesson where the concept is taught. */
const AnchorSchema = z.object({
  lessonId: z.string(),
  blockId: z.string(),
  slideId: z.string().optional(),
});
export type EscalationAnchor = z.infer<typeof AnchorSchema>;

/** ONE escalation cluster the creator sees — COUNT ONLY, never a learner identity.
 *  The FROZEN P6.3 contract: the queue tab renders exactly these fields. */
const EscalationClusterSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  /** null when the cluster's node was retired / not resolvable. */
  nodeTitle: z.string().nullable(),
  anchors: z.array(AnchorSchema),
  representativeQuestion: z.string().nullable(),
  representativeAnswer: z.string().nullable(),
  memberCount: z.number().int(),
  status: z.enum(["open", "replied", "dismissed", "resolved_in_content"]),
  changeSetId: z.string().nullable(),
});
export type EscalationCluster = z.infer<typeof EscalationClusterSchema>;

/** Tolerant anchor coercion: the node's stored anchors are permissive jsonb, so an
 *  entry missing lessonId/blockId is dropped rather than failing the whole parse. */
const QueueSchema = z.preprocess((raw) => {
  if (!Array.isArray(raw)) return raw;
  return raw.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    const anchors = Array.isArray(r.anchors)
      ? r.anchors.filter(
          (a): a is Record<string, unknown> =>
            !!a &&
            typeof a === "object" &&
            typeof (a as Record<string, unknown>).lessonId === "string" &&
            typeof (a as Record<string, unknown>).blockId === "string"
        )
      : [];
    return { ...r, anchors };
  });
}, z.array(EscalationClusterSchema));

/**
 * One author-gated round trip for the escalation queue. Returns `[]` when the
 * course doesn't exist or the caller isn't its author (the RPC → null), and on any
 * transport / mis-shaped-payload error (logged, never thrown).
 */
export async function loadEscalationQueue(
  supabase: DB,
  courseId: string
): Promise<EscalationCluster[]> {
  try {
    const data = await rpcJson(
      supabase,
      "tutor_escalation_queue",
      { p_course_id: courseId },
      QueueSchema.nullable()
    );
    return data ?? [];
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "escalation_queue_load",
        courseId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
    return [];
  }
}
