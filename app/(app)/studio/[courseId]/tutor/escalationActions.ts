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
 *   promoteClusterAction    — P6.4: draft a lecture/FAQ clarification into the
 *                             implicated lesson via the EXISTING change-set rail
 *                             (createChangeSet with the dossier summary as evidence).
 *                             Records escalation_cluster.change_set_id; RESOLUTION is
 *                             DERIVED (the queue/graph RPCs read change_sets.status) —
 *                             there is NO hook into acceptChangeSet.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { rpcJson } from "@/lib/supabase/rpcJson";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { promoteClusterToPatch } from "@/lib/tutor/escalation/promotion";
import { PROMOTION_RESPONSE_NAME } from "@/lib/tutor/escalation/promotionDraft";

/** Approve → deliver result: the per-member delivery tally (no roster). */
export type ApproveReplyResult =
  | { ok: true; delivered: number; alreadyDelivered: number; skipped: number }
  | { ok: false; error: string };

/** A simple ok/error result (dismiss). */
export type DismissResult = { ok: true } | { ok: false; error: string };

/** Promote → the staged change-set (the studio's Accept/Reject rail picks it up). */
export type PromoteResult =
  | { ok: true; changeSetId: string; lessonId: string; reused: boolean }
  | { ok: false; error: string };

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

/**
 * Promote a cluster to a content clarification (TUTOR-1 Wave 6, P6.4 — the loop
 * closes here). Drafts a FAQ/clarification lecture block (Terra, from the dossier +
 * the creator's approved answer) and files it through the EXISTING change-set rail —
 * the SAME pending BlockFrame chrome + EvidenceCard + Accept/Reject the maintenance
 * agent uses. There is NO new approval system.
 *
 * AUTHOR-GATE first (belt before the admin write path — the studio rail already RLS-
 * gates Accept/Reject, but the promotion reads the identity-bearing escalation_dossier
 * service-role, so the author must reach it only through this gated action). The
 * cluster must belong to the course. Only AFTER the gate do we touch the admin client
 * + a pooled Terra model (cost-emitted under 'escalation_dossier', no learner identity
 * in the prompt).
 *
 * RESOLUTION IS DERIVED, not stamped here: this action records
 * escalation_cluster.change_set_id and stops. A cluster becomes `resolved_in_content`
 * only when the creator ACCEPTS the staged change-set through the ordinary rail — the
 * queue / graph-console RPCs compute `resolved` from change_sets.status. There is NO
 * acceptChangeSet hook.
 *
 * The optional `finalAnswer` lets the creator promote WITH the answer they just typed
 * (the ClusterCard passes the textarea contents); omitted → the cluster's
 * representative answer grounds the draft.
 */
export async function promoteClusterAction(
  courseId: string,
  clusterId: string,
  finalAnswer?: string
): Promise<PromoteResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };

  if (!(await clusterBelongsToCourse(courseId, clusterId))) {
    return { ok: false, error: "That escalation cluster isn't part of this course." };
  }

  if (!isAdminConfigured()) {
    return {
      ok: false,
      error: "Promotion isn't available — the server is missing its privileged key.",
    };
  }

  try {
    const admin = createAdminClient();
    // A pooled Terra client (cost-emitted). With no OPENAI_API_KEY the promotion
    // degrades to a deterministic FAQ block built from the creator's answer, so a
    // key-less deployment still promotes (the draft is just not model-polished) —
    // we hand it a mock client in that case so the structured call resolves.
    const base = process.env.OPENAI_API_KEY
      ? createOpenAIModelClient()
      : createMockModelClient([], {
          structured: {
            [PROMOTION_RESPONSE_NAME]: {
              title: "FAQ",
              paragraphs: [{ kind: "paragraph", text: finalAnswer?.trim() || "A clarification your learners asked for." }],
            },
          },
        });
    const model = withPooledModel(base, {
      pool: poolFor("creator"),
      cost: { supabase: admin, courseId, emittedBy: gate.userId, jobType: "escalation_dossier" },
    });

    const res = await promoteClusterToPatch(admin, model, { courseId, clusterId, finalAnswer });
    if (!res.ok) return { ok: false, error: promoteReasonMessage(res.reason) };

    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, changeSetId: res.changeSetId, lessonId: res.lessonId, reused: res.reused };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to promote the escalation.",
    };
  }
}

/** Map a promotion's typed reason to creator-facing copy. */
function promoteReasonMessage(reason: string): string {
  switch (reason) {
    case "no_implicated_lesson":
    case "lesson_not_in_draft":
      return "We couldn't find the lesson this concept is taught in — reply to the learners instead, or add the concept to a lesson first.";
    case "cluster_not_found":
      return "That escalation cluster isn't part of this course.";
    case "course_not_found":
    case "course_author_unresolved":
      return "We couldn't load this course to add the clarification.";
    case "empty_change_set":
      return "Nothing changed — the clarification couldn't be drafted.";
    default:
      return reason.startsWith("reconcile_failed")
        ? "We couldn't save the clarification to the lesson. Try again."
        : "We couldn't promote this escalation to a content change.";
  }
}
