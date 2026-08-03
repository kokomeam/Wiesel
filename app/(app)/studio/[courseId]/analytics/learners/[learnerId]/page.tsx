/**
 * /studio/[courseId]/analytics/learners/[learnerId] — one learner's detail
 * (Milestone 4): per-lesson progress map, quiz attempt history expandable to
 * per-question responses (native <details> — no client JS), a paginated
 * activity timeline over raw learning_events (the indexed
 * (user_id, course_id, server_ts) path — the ONE sanctioned raw-event read),
 * approximate time spent, and current flags. This view is also the substrate
 * for future agent tooling ("draft follow-up" reads exactly this).
 *
 * PERF-1 C1: one learner_detail_bundle RPC round trip (author-gated inside;
 * the learner's roster row is computed for THIS learner only) + the cached
 * immutable snapshot for title maps. The timeline pages by KEYSET cursor
 * (?before= an event's server_ts) instead of OFFSET.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
} from "lucide-react";
import { buildSnapshotMaps, type SnapshotMaps } from "@/lib/analytics/dashboard";
import { loadLearnerDetail, type TimelineEvent } from "@/lib/analytics/dashboardLoader";
import { describeLearnerFlag, type LearnerFlagType } from "@/lib/analytics/flags";
import { getCachedSnapshot } from "@/lib/learn/publicationCache";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { Card, CardHeader } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { formatDate, formatDwell, timeAgo } from "@/components/studio/analytics/format";
import { RiskBadge, rosterFlags } from "@/components/studio/analytics/LearnersTab";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";

function eventLabel(event: TimelineEvent, maps: SnapshotMaps): string {
  // Comms delivery events (M7) carry no lesson — course-scoped envelope.
  const lesson =
    (event.lesson_id ? maps.lessonTitles.get(event.lesson_id) : undefined) ?? "a lesson";
  const block = event.block_id ? maps.blocks.get(event.block_id) : undefined;
  const blockName = block?.title || block?.lessonTitle || "";
  switch (event.event_type) {
    case "lesson_started":
      return `Opened “${lesson}”`;
    case "slide_viewed":
      return `Viewed a slide in “${lesson}” (${formatDwell(event.dwell_ms)})`;
    case "video_progress":
      return `Watched ${(event.quartile ?? 0) * 25}% of the video${blockName ? ` “${blockName}”` : ""}`;
    case "video_completed":
      return `Finished the video${blockName ? ` “${blockName}”` : ""}`;
    case "quiz_started":
      return `Started the quiz${blockName ? ` “${blockName}”` : ""}`;
    case "quiz_submitted":
      return `Submitted a quiz attempt${blockName ? ` on “${blockName}”` : ""}`;
    case "homework_submitted":
      return `Submitted homework${blockName ? ` for “${blockName}”` : ""}`;
    case "lesson_completed":
      return `Completed “${lesson}”`;
    case "session_heartbeat":
      return `Studying “${lesson}”`;
    case "comms_email_delivered":
      return "A check-in email was delivered";
    case "comms_email_open":
      return "Opened a check-in email";
    case "comms_email_click":
      return "Clicked a link in a check-in email";
    case "comms_email_bounce":
      return "A check-in email bounced";
    case "comms_email_complaint":
      return "Marked a check-in email as spam";
    default:
      return event.event_type;
  }
}

export default async function LearnerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; learnerId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { courseId, learnerId } = await params;
  const { before: rawBefore } = await searchParams;
  // Keyset cursor: an event server_ts. Anything unparseable = first page.
  const before =
    rawBefore && !Number.isNaN(Date.parse(rawBefore)) ? rawBefore : undefined;

  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) redirect(`/login?redirectTo=/studio/${courseId}/analytics`);

  // ONE round trip (the RPC authorizes internally — null → 404).
  const detail = await loadLearnerDetail(supabase, courseId, learnerId, before);
  if (!detail) notFound();
  const { publication, learner } = detail;
  if (!publication || !learner) notFound();

  // Immutable snapshot (cached forever keyed by publication id) → title maps.
  const { snapshot } = await getCachedSnapshot(publication.id);
  const maps = buildSnapshotMaps(snapshot);

  const progressByLesson = new Map(detail.progress.map((r) => [r.lesson_id, r]));
  const attempts = detail.attempts;
  const visibleEvents = detail.events;
  const hasMore = detail.hasMoreEvents;
  const heartbeats = detail.heartbeatCount;
  const flags = detail.flags;
  const learnerMessages = detail.messages;
  const orderedLessons = snapshot.modules.flatMap((m) => m.lessons);
  const oldestVisibleTs = visibleEvents.at(-1)?.server_ts;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      <Link
        href={`/studio/${courseId}/analytics?tab=learners`}
        className="inline-flex items-center gap-1 text-sm text-stone-500 transition-colors hover:text-stone-800"
      >
        <ChevronLeft className="size-4" aria-hidden />
        {detail.course.title} — Learners
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[1.7rem] font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
            {learner.display_name}
          </h1>
          <p className="mt-1 text-sm text-stone-500">
            {learner.email} · enrolled {formatDate(learner.enrolled_at)} ·{" "}
            {learner.enrollment_status}
          </p>
        </div>
        <RiskBadge flags={rosterFlags(learner)} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Progress"
          value={`${Number(learner.progress_pct ?? 0).toFixed(0)}%`}
          sub={`${learner.completed_lessons}/${learner.total_lessons} lessons`}
        />
        <Stat label="Quiz attempts" value={String(detail.attemptCount)} />
        <Stat
          label="Time spent (approx.)"
          value={heartbeats > 0 ? `${Math.round((heartbeats * 60) / 60)}m` : "—"}
          sub="from study heartbeats"
        />
        <Stat label="Last active" value={timeAgo(learner.last_activity_at)} />
      </div>

      {/* ── Current flags ── */}
      {flags.length > 0 ? (
        <Card className="border-amber-200/70 bg-amber-50/40">
          <ul className="space-y-1 px-5 py-4">
            {flags.map((flag) => (
              <li key={flag.flag_type} className="flex items-center gap-2 text-sm text-amber-800">
                <Clock3 className="size-4 shrink-0 text-amber-500" aria-hidden />
                {describeLearnerFlag(
                  flag.flag_type as LearnerFlagType,
                  (flag.detail ?? {}) as Record<string, unknown>
                )}
                <span className="text-xs text-amber-600/70">
                  · flagged {timeAgo(flag.computed_at)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ── Per-lesson progress map ── */}
        <Card>
          <CardHeader title="Lesson progress" subtitle="In course order" />
          <ul className="divide-y divide-stone-100">
            {orderedLessons.map((lesson, i) => {
              const p = progressByLesson.get(lesson.id);
              const status = p?.status ?? "not_started";
              return (
                <li key={lesson.id} className="flex items-center gap-3 px-5 py-2.5">
                  {status === "completed" ? (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden />
                  ) : status === "in_progress" ? (
                    <CircleDot className="size-4 shrink-0 text-brand-500" aria-hidden />
                  ) : (
                    <Circle className="size-4 shrink-0 text-stone-300" aria-hidden />
                  )}
                  <span className="w-5 shrink-0 text-right font-mono text-[11px] text-stone-400">
                    {i + 1}
                  </span>
                  <span
                    className={cn(
                      "flex-1 truncate text-sm",
                      status === "not_started" ? "text-stone-400" : "text-stone-700"
                    )}
                  >
                    {lesson.title}
                  </span>
                  <span className="text-xs tabular-nums text-stone-400">
                    {p ? `${Number(p.pct).toFixed(0)}%` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* ── Quiz attempt history (expandable per-question) ── */}
        <Card>
          <CardHeader title="Quiz attempts" subtitle="Newest first" />
          {attempts.length === 0 ? (
            <p className="px-5 py-6 text-sm text-stone-500">No quiz attempts yet.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {attempts.map((attempt) => {
                const block = maps.blocks.get(attempt.block_id);
                const pct = Math.round((100 * attempt.score) / attempt.max_score);
                return (
                  <li key={attempt.id}>
                    <details className="group">
                      <summary className="flex cursor-pointer items-center gap-3 px-5 py-3 hover:bg-stone-50">
                        <ChevronRight
                          className="size-4 shrink-0 text-stone-400 transition-transform group-open:rotate-90"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-stone-800">
                            {block?.title || block?.lessonTitle || "Quiz"}
                          </span>
                          <span className="block text-xs text-stone-400">
                            Attempt {attempt.attempt_number} · {timeAgo(attempt.submitted_at)}
                            {attempt.version !== publication.version
                              ? ` · v${attempt.version}`
                              : ""}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                            pct >= 60
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-rose-50 text-rose-700"
                          )}
                        >
                          {attempt.score}/{attempt.max_score}
                        </span>
                      </summary>
                      <ul className="space-y-1.5 bg-stone-50/60 px-5 py-3 pl-12">
                        {attempt.question_responses.length === 0 ? (
                          <li className="text-xs text-stone-400">
                            No questions were answered on this attempt.
                          </li>
                        ) : (
                          attempt.question_responses.map((response) => {
                            const q = maps.questions.get(response.question_id);
                            return (
                              <li key={response.id} className="flex items-start gap-2 text-sm">
                                {response.correct ? (
                                  <CheckCircle2
                                    className="mt-0.5 size-3.5 shrink-0 text-emerald-500"
                                    aria-hidden
                                  />
                                ) : (
                                  <Circle
                                    className="mt-0.5 size-3.5 shrink-0 text-rose-400"
                                    aria-hidden
                                  />
                                )}
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate",
                                    response.correct ? "text-stone-600" : "text-rose-700"
                                  )}
                                  title={q?.prompt}
                                >
                                  {q?.prompt ?? response.question_id}
                                </span>
                                {response.time_ms !== null ? (
                                  <span className="shrink-0 text-xs tabular-nums text-stone-400">
                                    {formatDwell(response.time_ms)}
                                  </span>
                                ) : null}
                              </li>
                            );
                          })
                        )}
                      </ul>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* ── Messages to this learner (drafts managed in the stuck queue /
             agent panel; this is the audit view) ── */}
      {learnerMessages.length > 0 ? (
        <Card>
          <CardHeader title="Messages" subtitle="Check-ins drafted or sent to this learner" />
          <ul className="divide-y divide-stone-100">
            {learnerMessages.map((m) => {
              // M7: past 'sent', show where the delivery actually got to.
              const chip =
                m.status === "sent" &&
                m.delivery_status &&
                !["none", "sent"].includes(m.delivery_status)
                  ? m.delivery_status
                  : m.status;
              const tone =
                chip === "bounced" || chip === "complained" || chip === "failed"
                  ? "bg-rose-100 text-rose-700"
                  : chip === "delivered"
                    ? "bg-sky-100 text-sky-700"
                    : chip === "sent" || chip === "opened" || chip === "clicked"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-amber-100 text-amber-700";
              return (
                <li key={m.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-stone-700">{m.subject}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      tone
                    )}
                  >
                    {chip}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-stone-400">
                    {timeAgo(m.sent_at ?? m.created_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* ── Activity timeline (raw events, keyset-paginated) ── */}
      <Card>
        <CardHeader
          title="Activity timeline"
          subtitle="Raw learning events, newest first"
        />
        {visibleEvents.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Activity}
              title={!before ? "No activity recorded yet" : "No more activity"}
              hint={
                !before
                  ? "Events appear here as this learner studies — slide views, video progress, quiz attempts."
                  : "You've reached the end of this learner's history."
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-stone-100">
            {visibleEvents.map((event) => (
              <li key={event.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className="size-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-stone-600">
                  {eventLabel(event, maps)}
                </span>
                <span
                  className="shrink-0 text-xs tabular-nums text-stone-400"
                  title={new Date(event.server_ts).toLocaleString()}
                >
                  {timeAgo(event.server_ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {before || hasMore ? (
          <div className="flex items-center justify-between border-t border-stone-100 px-5 py-3">
            {before ? (
              <Link
                href={`/studio/${courseId}/analytics/learners/${learnerId}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-stone-600 hover:text-stone-900"
              >
                <ArrowLeft className="size-3.5" aria-hidden /> Newer
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-stone-400">
              {before ? `Before ${formatDate(before)}` : "Latest activity"}
            </span>
            {hasMore && oldestVisibleTs ? (
              <Link
                href={`/studio/${courseId}/analytics/learners/${learnerId}?before=${encodeURIComponent(oldestVisibleTs)}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-stone-600 hover:text-stone-900"
              >
                Older <ChevronRight className="size-3.5" aria-hidden />
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
