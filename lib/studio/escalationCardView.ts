/**
 * PURE render-decision helpers for the escalation queue (TUTOR-1 Wave 6 · P6.3).
 *
 * The tiny, DB-free, React-free decisions the ClusterCard + EscalationQueueTab make:
 * the "N learners asked" COUNT copy (never a roster), the cluster-status → chip
 * mapping, the studio deep-link for a cluster anchor, and whether a cluster is still
 * actionable. Kept out of the client component so `verify-tutor-escalation-queue.ts`
 * can pin them with no key / DB / browser — and so the "count only, never a name"
 * invariant is verifiable in one place.
 */

import type { UiStatus } from "@/components/ui/StatusChip";
import type { EscalationCluster, EscalationAnchor } from "@/lib/studio/escalationQueue";

/** The plain-English "N learners asked" count — a COUNT, never a roster/name. */
export function askedLabel(memberCount: number): string {
  const n = Math.max(0, Math.trunc(memberCount));
  return `${n} learner${n === 1 ? "" : "s"} asked`;
}

/** cluster status → the StatusChip tone + label the creator sees. Exhaustive over
 *  the four EscalationCluster statuses (a compile error here if a status is added). */
export const CLUSTER_STATUS_CHIP: Record<
  EscalationCluster["status"],
  { tone: UiStatus; label: string }
> = {
  open: { tone: "attention", label: "Open" },
  replied: { tone: "success", label: "Replied" },
  dismissed: { tone: "neutral", label: "Dismissed" },
  resolved_in_content: { tone: "success", label: "Clarified in content" },
};

/** Is a cluster still actionable (the creator can reply / dismiss)? Only open +
 *  replied clusters carry the reply affordances (the queue RPC returns only those,
 *  but the card guards defensively). */
export function isClusterActionable(status: EscalationCluster["status"]): boolean {
  return status === "open" || status === "replied";
}

/** The studio deep-link for a cluster anchor — block-level when a blockId is
 *  present, lesson-level otherwise. Mirrors the graph/analytics deep-link format. */
export function anchorHref(courseId: string, anchor: EscalationAnchor): string {
  const base = `/studio?course=${courseId}&lesson=${anchor.lessonId}`;
  return anchor.blockId ? `${base}&block=${anchor.blockId}` : base;
}

/** The keys the creator-visible cluster surface is ALLOWED to carry — the frozen
 *  EscalationCluster contract. Any identity-bearing field name (user_id, email, …)
 *  MUST NOT appear on a queue row; the pure test asserts the shape is a subset of
 *  this and never leaks one. */
export const ALLOWED_CLUSTER_KEYS = [
  "id",
  "nodeId",
  "nodeTitle",
  "anchors",
  "representativeQuestion",
  "representativeAnswer",
  "memberCount",
  "status",
  "changeSetId",
] as const;

/** Identity field names that must NEVER appear on a queue row (the roster-privacy
 *  guarantee — the creator sees a count, never who asked). */
export const FORBIDDEN_IDENTITY_KEYS = [
  "user_id",
  "userId",
  "email",
  "learnerName",
  "display_name",
  "displayName",
  "name",
] as const;
