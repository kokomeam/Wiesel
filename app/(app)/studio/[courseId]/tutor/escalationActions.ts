"use server";

/**
 * Creator Escalation Queue server actions (TUTOR-1 Wave 6, P6.3).
 *
 *   approveAndDeliverAction — approve a cluster with a final answer. Delivers ONE
 *                             instructor tutor_turn to EVERY learner who asked
 *                             (exactly-once per member) via the service-role
 *                             apply_escalation_reply RPC, and flips the cluster to
 *                             `replied`. The author NEVER sees the roster — the RPC
 *                             writes into each learner's own thread server-side.
 *   dismissClusterAction    — dismiss a cluster (status `dismissed` + a reason). No
 *                             delivery, no learner-facing side effect.
 *
 * Both AUTHOR-GATE first: load the course under the USER-scoped client and confirm
 * author_id === the caller (RLS on escalation_cluster is the backstop; the explicit
 * gate keeps a non-author from ever reaching the admin write path). Only AFTER the
 * gate passes do we touch the ADMIN (service-role) client — apply_escalation_reply
 * is service-role-only (it reads the identity-bearing escalation_dossier + writes
 * instructor turns), so the author reaches it exclusively through this gated action.
 *
 * ⚠ SEAM FOR P6.4 (content-patch promotion): `promoteClusterAction` is NOT defined
 * here — P6.4 owns the promote action + the card's Promote button (it edits THIS
 * file and EscalationQueueTab/ClusterCard). Add it below dismissClusterAction: it
 * will build BlockChange[] from the dossier + the creator's answer, file a
 * change-set via createChangeSet with the dossier summary as evidence, and record
 * escalation_cluster.change_set_id + status `resolved_in_content` on accept. Leave
 * this action set untouched otherwise.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { rpcJson } from "@/lib/supabase/rpcJson";

/** Approve → deliver result: the per-member delivery tally (no roster). */
export type ApproveReplyResult =
  | { ok: true; delivered: number; alreadyDelivered: number; skipped: number }
  | { ok: false; error: string };

/** A simple ok/error result (dismiss). */
export type DismissResult = { ok: true } | { ok: false; error: string };

/** The apply_escalation_reply RPC payload (jsonb → validated; nothing to splice). */
const ReplyResultSchema = z.object({
  delivered: z.number().int(),
  alreadyDelivered: z.number().int(),
  skipped: z.number().int(),
});

/** Author-gate: the caller must be signed in AND the course's author. Returns the
 *  user id, throws a redirect for an anon caller, or { forbidden } for a signed-in
 *  non-author. (RLS is the backstop; this is the explicit belt before any write.) */
async function requireAuthor(
  courseId: string
): Promise<{ userId: string } | { forbidden: true }> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?redirectTo=/studio/${courseId}/tutor?tab=escalations`);
  const supabase = await createClient();
  const { data } = await supabase
    .from("courses")
    .select("author_id")
    .eq("id", courseId)
    .maybeSingle();
  if (!data || data.author_id !== user.id) return { forbidden: true };
  return { userId: user.id };
}

/** Confirm the cluster belongs to the course (author-scoped read on the identity-
 *  free escalation_cluster) BEFORE the admin RPC touches it — a stray clusterId from
 *  another course can never be replied/dismissed through a course's action. */
async function clusterBelongsToCourse(courseId: string, clusterId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("escalation_cluster")
    .select("id")
    .eq("id", clusterId)
    .eq("course_id", courseId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Approve a cluster with a final answer and deliver it to every learner who asked.
 *
 * The final answer lands as an instructor-role tutor_turn in EACH member's own
 * thread, EXACTLY ONCE per (cluster, learner) via the escalation_reply_delivery
 * ledger inside apply_escalation_reply — a retry / double-click delivers no extra
 * turns. The cluster flips to `replied` with the final answer as its representative.
 *
 * PRIVACY: the author supplies a text answer and gets back a COUNT (delivered /
 * already / skipped) — never a learner id. The RPC resolves recipients server-side
 * from the service-role-only escalation_dossier the author can't read.
 */
export async function approveAndDeliverAction(
  courseId: string,
  clusterId: string,
  finalAnswer: string
): Promise<ApproveReplyResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };

  const trimmed = finalAnswer.trim();
  if (trimmed.length < 1) {
    return { ok: false, error: "Write a reply before sending it to learners." };
  }
  if (trimmed.length > 8000) {
    return { ok: false, error: "Keep the reply to 8000 characters or fewer." };
  }

  if (!(await clusterBelongsToCourse(courseId, clusterId))) {
    return { ok: false, error: "That escalation cluster isn't part of this course." };
  }

  if (!isAdminConfigured()) {
    return {
      ok: false,
      error: "Delivery isn't available — the server is missing its privileged key.",
    };
  }

  try {
    const admin = createAdminClient();
    // apply_escalation_reply is service-role-only: it reads escalation_dossier
    // (identity-bearing, zero policies) + writes one instructor turn per member.
    const result = await rpcJson(admin, "apply_escalation_reply", {
      p_cluster_id: clusterId,
      p_final_answer: trimmed,
    }, ReplyResultSchema);
    revalidatePath(`/studio/${courseId}/tutor`);
    return {
      ok: true,
      delivered: result.delivered,
      alreadyDelivered: result.alreadyDelivered,
      skipped: result.skipped,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to deliver the reply.",
    };
  }
}

/**
 * Dismiss a cluster (no delivery). Sets status `dismissed` + a short reason so the
 * queue (which shows only open/replied) drops it. Author-scoped RLS on the
 * identity-free escalation_cluster makes this a plain UPDATE under the user client —
 * no admin client needed (there's no roster to touch).
 */
export async function dismissClusterAction(
  courseId: string,
  clusterId: string,
  reason: string
): Promise<DismissResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };

  const trimmedReason = reason.trim().slice(0, 500);

  const supabase = await createClient();
  const { error } = await supabase
    .from("escalation_cluster")
    .update({ status: "dismissed", dismiss_reason: trimmedReason.length > 0 ? trimmedReason : null })
    .eq("id", clusterId)
    .eq("course_id", courseId)
    .in("status", ["open", "replied"]);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/studio/${courseId}/tutor`);
  return { ok: true };
}

/* ────────────────────────────── P6.4 SEAM ──────────────────────────────────
 * promoteClusterAction(courseId, clusterId, finalAnswer) is added HERE by P6.4.
 * It drafts a lecture/FAQ block (buildLectureBlock → ADD_BLOCK) from the dossier +
 * the creator's answer, files it through createChangeSet with the dossier summary
 * as evidence (the existing Accept/Reject rail), and stamps
 * escalation_cluster.change_set_id + status `resolved_in_content` on accept. The
 * ClusterCard's Promote button (P6.4) calls it. Do NOT stub it here — P6.4 owns it. */
