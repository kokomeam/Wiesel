import { CheckCircle2, Mail } from "lucide-react";
import Link from "next/link";
import { DraftFollowUpButton } from "@/components/comms/DraftFollowUpButton";
import { Card, CardHeader } from "@/components/ui/Card";
import type { CourseAnalytics, RosterRow, SnapshotMaps } from "@/lib/analytics/dashboard";
import { describeLearnerFlag, INACTIVE_DAYS, type LearnerFlagType } from "@/lib/analytics/flags";
import { buildTemplate, type CommsTemplateId } from "@/lib/comms/templates";
import { EmptyState } from "./EmptyState";
import { timeAgo } from "./format";
import { parseFlags, RiskBadge } from "./LearnersTab";

/** A learner's most recent check-in + its M7 delivery outcome (M8 measurement
 *  hook — makes nudge results visible so threshold tuning is data-driven). */
export interface LastNudge {
  status: string;
  delivery_status: string | null;
  sent_at: string | null;
  created_at: string;
}

function nudgeOutcome(nudge: LastNudge): string {
  if (nudge.status !== "sent") return nudge.status; // draft | approved | failed
  const d = nudge.delivery_status;
  return d && d !== "none" ? d : "sent";
}

/** Stuck queue: learners the nightly flag pass marked as needing attention,
 *  each with WHY, and (Milestone 6) a WIRED "Draft follow-up" — a deterministic
 *  template prefill into the composer; edit → approve → send, opt-out AND
 *  suppression (M7) enforced at the send seam. M8: each row shows the last
 *  check-in's delivery outcome; the automatic nightly filing additionally
 *  respects opt-out/suppression/cooldown — this queue deliberately still shows
 *  every stuck learner (visibility + manual outreach stay unrestricted). */
export function StuckQueueTab({
  analytics,
  maps,
  courseId,
  slug,
  courseTitle,
  creatorName,
  optOutByUser,
  lastNudgeByUser = {},
  suppressedByUser = {},
}: {
  analytics: CourseAnalytics;
  maps: SnapshotMaps;
  courseId: string;
  slug: string;
  courseTitle: string;
  creatorName: string;
  /** userId → enrollments.comms_opt_out (server-loaded; the seam re-checks). */
  optOutByUser: Record<string, boolean>;
  /** userId → the latest learner_messages row (M8 measurement hook). */
  lastNudgeByUser?: Record<string, LastNudge>;
  /** userId → suppression reason (M7; advisory — the seam re-checks). */
  suppressedByUser?: Record<string, string>;
}) {
  const byUser = new Map<string, RosterRow>(analytics.roster.map((r) => [r.user_id, r]));
  // Group the course's flags per learner (a learner can carry both types).
  const grouped = new Map<string, typeof analytics.flags>();
  for (const flag of analytics.flags) {
    const list = grouped.get(flag.user_id) ?? [];
    list.push(flag);
    grouped.set(flag.user_id, list);
  }

  if (grouped.size === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Nobody's stuck"
        hint={`Learners land here when they go quiet for ${INACTIVE_DAYS}+ days with an unfinished course, or fail the same quiz twice. Flags recompute nightly.`}
      />
    );
  }

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  return (
    <Card>
      <CardHeader
        title="Stuck queue"
        subtitle={`${grouped.size} learner${grouped.size === 1 ? "" : "s"} flagged — recomputed nightly`}
      />
      <ul className="divide-y divide-stone-100">
        {[...grouped.entries()].map(([userId, flags]) => {
          const roster = byUser.get(userId);
          const learnerName = roster?.display_name ?? "Learner";

          // Deterministic template prefill (no model call): failing a quiz →
          // struggling_topic (deep link to the exact lesson via the flag's
          // block); otherwise almost_done (≥70%) or stalled_nudge.
          const failureFlag = flags.find((f) => f.flag_type === "repeated_quiz_failure");
          const failureDetail = (failureFlag?.detail ?? {}) as {
            quizzes?: { blockId?: string }[];
          };
          const failedBlockId = failureDetail.quizzes?.[0]?.blockId;
          const failedLesson = failedBlockId ? maps.blocks.get(failedBlockId) : undefined;
          const templateId: CommsTemplateId = failureFlag
            ? "struggling_topic"
            : Number(roster?.progress_pct ?? 0) >= 70
              ? "almost_done"
              : "stalled_nudge";
          const draft = buildTemplate(templateId, {
            learnerName,
            creatorName,
            courseTitle,
            courseUrl: `${base}/learn/${slug}`,
            lessonTitle: failedLesson?.lessonTitle,
            lessonUrl: failedLesson
              ? `${base}/learn/${slug}/${failedLesson.lessonId}`
              : undefined,
          });

          return (
            /* PERF-1 D2 (A5 §6, A6 #23): server-rendered unbounded list —
               .cv-row bounds render work to the viewport (off-screen rows
               skip layout/paint); ~96px ≈ one two-flag row. */
            <li
              key={userId}
              style={{ "--cv-size": "96px" } as React.CSSProperties}
              className="cv-row flex flex-wrap items-center gap-4 px-5 py-4"
            >
              <div className="min-w-48 flex-1">
                <Link
                  href={`/studio/${courseId}/analytics/learners/${userId}`}
                  className="font-medium text-stone-800 hover:text-brand-700"
                >
                  {learnerName}
                </Link>
                <p className="text-xs text-stone-400">{roster?.email ?? ""}</p>
              </div>
              <div className="min-w-64 flex-[2] space-y-1">
                {flags.map((flag) => (
                  <p key={flag.flag_type} className="flex items-center gap-2 text-sm text-stone-600">
                    <RiskBadge
                      flags={parseFlags([{ type: flag.flag_type, detail: flag.detail }])}
                    />
                    {describeLearnerFlag(
                      flag.flag_type as LearnerFlagType,
                      (flag.detail ?? {}) as Record<string, unknown>
                    )}
                  </p>
                ))}
                <p className="text-[11px] text-stone-400">
                  Flagged {timeAgo(flags[0]?.computed_at)}
                  {lastNudgeByUser[userId] ? (
                    <span className="ml-2 inline-flex items-center gap-1">
                      <Mail className="size-3 text-stone-300" aria-hidden />
                      Last check-in{" "}
                      {timeAgo(
                        lastNudgeByUser[userId].sent_at ?? lastNudgeByUser[userId].created_at
                      )}{" "}
                      · {nudgeOutcome(lastNudgeByUser[userId])}
                    </span>
                  ) : null}
                </p>
              </div>
              <DraftFollowUpButton
                optedOut={optOutByUser[userId] === true}
                suppressed={suppressedByUser[userId] != null}
                seed={{
                  courseId,
                  userId,
                  learnerName,
                  subject: draft.subject,
                  body: draft.body,
                  suppressedReason:
                    suppressedByUser[userId] === "hard_bounce" ||
                    suppressedByUser[userId] === "complaint"
                      ? (suppressedByUser[userId] as "hard_bounce" | "complaint")
                      : null,
                }}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
