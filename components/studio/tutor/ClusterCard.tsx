"use client";

/**
 * One escalation-cluster card (TUTOR-1 Wave 6, P6.3). CLIENT sub-component of the
 * server EscalationQueueTab.
 *
 * Renders ONE identity-free cluster: the implicated concept node (deep-linking into
 * the lesson where it's taught), the representative learner question, a COUNT of how
 * many learners asked (NEVER a name / roster), the tutor's proposed answer (the
 * seed for the reply), and the evidence trail. The creator edits the answer in a
 * textarea, then Approve & send → approveAndDeliverAction delivers one instructor
 * turn to every member (exactly-once, server-side); Dismiss → dismissClusterAction.
 *
 * The card owns its own transient state (edit / pending / result / dismissing) via
 * useTransition — the AutonomySettings / CharterTab pattern. Errors render INLINE
 * (a rose alert) — there is no toast surface here. On success the card collapses to
 * a "Delivered to N learners" confirmation (an optimistic terminal state — the
 * server has already flipped the cluster, and a revalidate refreshes the list).
 *
 * data-ai-tool: escalation-answer (the textarea) · escalation-approve (send) ·
 * escalation-dismiss.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { LifeBuoy, MessageSquareQuote, Users, CheckCircle2, MapPin, Sparkles, FileEdit } from "lucide-react";
import { StatusChip } from "@/components/ui/StatusChip";
import { toolAttrs } from "@/lib/course/aiAttributes";
import {
  approveAndDeliverAction,
  dismissClusterAction,
  promoteClusterAction,
} from "@/app/(app)/studio/[courseId]/tutor/escalationActions";
import type { EscalationCluster } from "@/lib/studio/escalationQueue";
import {
  askedLabel,
  anchorHref,
  isClusterActionable,
  CLUSTER_STATUS_CHIP,
} from "@/lib/studio/escalationCardView";

export function ClusterCard({
  courseId,
  cluster,
}: {
  courseId: string;
  cluster: EscalationCluster;
}) {
  const [answer, setAnswer] = useState<string>(cluster.representativeAnswer ?? "");
  const [error, setError] = useState<string | null>(null);
  const [delivered, setDelivered] = useState<{ count: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [promoted, setPromoted] = useState<{ changeSetId: string; lessonId: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const status = CLUSTER_STATUS_CHIP[cluster.status];
  const canWrite = isClusterActionable(cluster.status);
  const firstAnchor = cluster.anchors[0];

  const onApprove = () => {
    setError(null);
    startTransition(async () => {
      const res = await approveAndDeliverAction(courseId, cluster.id, answer);
      if (res.ok) {
        setDelivered({ count: res.delivered + res.alreadyDelivered });
      } else {
        setError(res.error);
      }
    });
  };

  const onDismiss = () => {
    setError(null);
    startTransition(async () => {
      const res = await dismissClusterAction(courseId, cluster.id, "");
      if (res.ok) {
        setDismissed(true);
      } else {
        setError(res.error);
      }
    });
  };

  const onPromote = () => {
    setError(null);
    startTransition(async () => {
      const res = await promoteClusterAction(courseId, cluster.id, answer);
      if (res.ok) {
        setPromoted({ changeSetId: res.changeSetId, lessonId: res.lessonId });
      } else {
        setError(res.error);
      }
    });
  };

  // Already clarified in content (a promotion whose change-set the creator accepted).
  // DERIVED from the rail — the card shows the landed state rather than the affordances.
  if (cluster.resolved) {
    return (
      <li className="rounded-card border border-emerald-200/80 bg-emerald-50/50 px-card-pad py-4">
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <Sparkles className="size-4" aria-hidden />
          Clarified in content — you added an answer to the lesson for the {askedLabel(cluster.memberCount)}.
        </p>
      </li>
    );
  }

  // Terminal states — the card collapses to a calm confirmation after an action.
  if (dismissed) {
    return (
      <li className="rounded-card border border-stone-200/80 bg-stone-50/60 px-card-pad py-4">
        <p className="text-sm text-stone-500">Dismissed — this cluster no longer appears in the queue.</p>
      </li>
    );
  }
  if (promoted) {
    return (
      <li className="rounded-card border border-brand-200/80 bg-brand-50/50 px-card-pad py-4">
        <p className="flex items-center gap-2 text-sm font-medium text-brand-800">
          <FileEdit className="size-4" aria-hidden />
          Clarification drafted — review it in the course editor.
        </p>
        <Link
          href={`/studio?course=${courseId}&lesson=${promoted.lessonId}`}
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline"
          {...toolAttrs({
            tool: "escalation-promote-link",
            action: "OPEN_PROMOTED_CHANGE_SET",
            targetType: "link",
            label: "Open the drafted clarification in the editor",
          })}
        >
          <MapPin className="size-3" aria-hidden />
          Open the lesson to Accept or Reject the drafted FAQ
        </Link>
      </li>
    );
  }
  if (delivered) {
    return (
      <li className="rounded-card border border-emerald-200/80 bg-emerald-50/50 px-card-pad py-4">
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-800">
          <CheckCircle2 className="size-4" aria-hidden />
          Delivered to {delivered.count} learner{delivered.count === 1 ? "" : "s"} — your reply is in their tutor thread.
        </p>
      </li>
    );
  }

  return (
    <li className="rounded-card border border-stone-200/80 bg-white shadow-card">
      {/* header: node + status + count */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200/70 px-card-pad py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <LifeBuoy className="size-4 shrink-0 text-brand-500" aria-hidden />
            <h3 className="truncate text-sm font-semibold text-stone-900">
              {cluster.nodeTitle ?? "A concept in this course"}
            </h3>
          </div>
          {firstAnchor ? (
            <Link
              href={anchorHref(courseId, firstAnchor)}
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline"
            >
              <MapPin className="size-3" aria-hidden />
              Go to where it&apos;s taught
            </Link>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-meta font-medium text-stone-700">
            <Users className="size-3" aria-hidden />
            {askedLabel(cluster.memberCount)}
          </span>
          <StatusChip status={status.tone}>{status.label}</StatusChip>
        </div>
      </div>

      <div className="space-y-4 px-card-pad py-4">
        {/* the representative question */}
        <div>
          <p className="text-meta font-medium uppercase tracking-eyebrow text-stone-400">What learners asked</p>
          <p className="mt-1 text-sm leading-relaxed text-stone-800">
            {cluster.representativeQuestion ?? "A recurring question on this concept."}
          </p>
        </div>

        {/* evidence trail — the tutor's proposed answer (EvidenceCard-style summary) */}
        {cluster.representativeAnswer ? (
          <div className="rounded-panel border border-amber-200/70 bg-amber-50/50 px-3.5 py-3">
            <p className="flex items-center gap-1.5 text-meta font-medium uppercase tracking-eyebrow text-amber-700">
              <MessageSquareQuote className="size-3" aria-hidden />
              What the tutor suggested
            </p>
            <p className="mt-1 text-sm leading-relaxed text-amber-900/90">{cluster.representativeAnswer}</p>
          </div>
        ) : null}

        {/* the creator's reply — delivered to every member */}
        {canWrite ? (
          <div>
            <label
              htmlFor={`escalation-answer-${cluster.id}`}
              className="text-meta font-medium uppercase tracking-eyebrow text-stone-400"
            >
              Your reply to these learners
            </label>
            <textarea
              id={`escalation-answer-${cluster.id}`}
              rows={4}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Answer the question in your own words — it's delivered to everyone who asked, in their tutor thread."
              className="mt-1 w-full rounded-control border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 shadow-sm placeholder:text-stone-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              {...toolAttrs({
                tool: "escalation-answer",
                action: "SET_ESCALATION_ANSWER",
                targetType: "textarea",
                label: "Write the escalation reply",
              })}
            />
            <p className="mt-1.5 text-xs text-stone-500">
              Delivered privately to each learner&apos;s tutor thread as an instructor message. You never see who asked.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">
            {error}
          </p>
        ) : null}

        {canWrite ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDismiss}
              disabled={pending}
              className="rounded-full border border-stone-200 bg-white px-4 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              {...toolAttrs({
                tool: "escalation-dismiss",
                action: "DISMISS_ESCALATION_CLUSTER",
                targetType: "button",
                label: "Dismiss this escalation cluster",
              })}
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={onPromote}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50/60 px-4 py-1.5 text-sm font-medium text-brand-800 hover:bg-brand-50 disabled:opacity-50"
              title="Draft a clarification into the lesson (you Accept or Reject it in the editor)"
              {...toolAttrs({
                tool: "escalation-promote",
                action: "PROMOTE_ESCALATION_CLUSTER",
                targetType: "button",
                label: "Draft a lesson clarification from this escalation",
              })}
            >
              <Sparkles className="size-3.5" aria-hidden />
              {pending ? "Drafting…" : "Clarify in lesson"}
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={pending || answer.trim().length === 0}
              className="rounded-full brand-gradient px-5 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95 disabled:opacity-50"
              {...toolAttrs({
                tool: "escalation-approve",
                action: "APPROVE_ESCALATION_REPLY",
                targetType: "button",
                label: "Approve and send the reply to learners",
              })}
            >
              {pending ? "Sending…" : "Approve & send"}
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
