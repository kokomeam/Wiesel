import { Activity, ExternalLink, Film, HelpCircle, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { BarChart } from "@/components/charts/BarChart";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  bucketLabel,
  editorBlockHref,
  parseFeedbackComments,
  type ContentFeedbackRow,
  type CourseAnalytics,
  type SlideDwellRow,
  type SnapshotMaps,
} from "@/lib/analytics/dashboard";
import {
  dwellOutlier,
  feedbackOutlier,
  questionFlags,
  type DwellOutlier,
  type QuestionFlag,
} from "@/lib/analytics/flags";
import { median } from "@/lib/analytics/stats";
import { cn } from "@/lib/cn";
import { EmptyState } from "./EmptyState";
import { formatDwell, formatPct, timeAgo } from "./format";

const FLAG_LABEL: Record<QuestionFlag["type"], string> = {
  low_correct: "Low % correct",
  strong_distractor: "Strong distractor",
  low_discrimination: "Low discrimination",
};

/** Content health: drop-off table · video retention · quiz item analysis ·
 *  slide health (dwell + M10 learner feedback, ONE unified per-slide
 *  surface). Every flagged row deep-links into the editor. */
export function ContentHealthTab({
  analytics,
  maps,
  courseId,
}: {
  analytics: CourseAnalytics;
  maps: SnapshotMaps;
  courseId: string;
}) {
  const { funnel, questionStats, slideDwell, videoRetention, contentFeedback } = analytics;
  const slideFeedback = contentFeedback.filter((f) => f.slide_id !== null);
  const lessonFeedback = new Map(
    contentFeedback.filter((f) => f.slide_id === null).map((f) => [f.lesson_id, f])
  );

  /* Quiz item analysis — flags computed at render time (lib/analytics/flags). */
  const questionRows = questionStats
    .map((row) => {
      const distribution = (row.answer_distribution ?? {}) as Record<string, number>;
      const flags = questionFlags({
        n: row.n,
        pctCorrect: row.pct_correct,
        answerDistribution: distribution,
        keyValue: row.key_value,
        discrimination: row.discrimination,
      });
      const topWrong = Object.entries(distribution)
        .filter(([bucket]) => bucket !== row.key_value)
        .sort((a, b) => b[1] - a[1])[0];
      return { row, flags, topWrong };
    })
    .sort((a, b) => b.flags.length - a.flags.length || a.row.n - b.row.n);

  /* Slide health: dwell outliers vs the publication's reference median,
     JOINED with per-slide learner feedback (M10) into one row set — a slide
     appears when it trips a dwell signal, a feedback flag, or has any
     reactions/comments at all. */
  const referenceMedian =
    median(
      slideDwell
        .map((s) => s.median_dwell_ms)
        .filter((v): v is number => v !== null)
    ) ?? 0;
  const dwellBySlide = new Map(slideDwell.map((r) => [r.slide_id, r]));
  const feedbackBySlide = new Map(slideFeedback.map((r) => [r.slide_id as string, r]));
  interface SlideHealthRow {
    slideId: string;
    lessonId: string;
    blockId: string | null;
    dwell: SlideDwellRow | null;
    feedback: ContentFeedbackRow | null;
    dwellSignal: DwellOutlier;
    feedbackSignal: "confusing" | null;
  }
  const slideHealth: SlideHealthRow[] = [
    ...new Set([...dwellBySlide.keys(), ...feedbackBySlide.keys()]),
  ]
    .map((slideId) => {
      const dwell = dwellBySlide.get(slideId) ?? null;
      const feedback = feedbackBySlide.get(slideId) ?? null;
      return {
        slideId,
        lessonId: (dwell?.lesson_id ?? feedback?.lesson_id)!,
        blockId: dwell?.block_id ?? feedback?.block_id ?? null,
        dwell,
        feedback,
        dwellSignal: dwell
          ? dwellOutlier(dwell.median_dwell_ms ?? 0, referenceMedian, dwell.n)
          : null,
        feedbackSignal: feedback
          ? feedbackOutlier(feedback.helpful_count, feedback.confusing_count)
          : null,
      };
    })
    .filter(
      (r) =>
        r.dwellSignal !== null ||
        r.feedbackSignal !== null ||
        (r.feedback !== null && r.feedback.helpful_count + r.feedback.confusing_count > 0)
    )
    .sort(
      (a, b) =>
        Number(b.feedbackSignal !== null) - Number(a.feedbackSignal !== null) ||
        Number(b.dwellSignal !== null) - Number(a.dwellSignal !== null)
    );

  const videoBlocks = videoRetention.filter((v) => maps.blocks.has(v.block_id));

  return (
    <div className="space-y-6">
      {/* ── Per-lesson drop-off ── */}
      <Card>
        <CardHeader title="Lesson drop-off" subtitle="Started vs completed, per lesson" />
        {funnel.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Activity}
              title="No lesson data yet"
              hint="This table fills in as learners work through the course."
            />
          </div>
        ) : (
          <Table
            head={["#", "Lesson", "Started", "Completed", "Completion", "Drop-off", "Feedback", ""]}
            estimateRows={funnel.length}
          >
            {funnel.map((row) => {
              const title = maps.lessonTitles.get(row.lesson_id) ?? "Untitled lesson";
              const completion =
                row.started_count > 0
                  ? (100 * row.completed_count) / row.started_count
                  : null;
              const hotDrop = row.dropoff_pct !== null && row.dropoff_pct >= 0.3;
              const fb = lessonFeedback.get(row.lesson_id);
              return (
                <tr key={row.lesson_id} className="border-t border-stone-100">
                  <Td className="font-mono text-[11px] text-stone-400">{row.lesson_order}</Td>
                  <Td className="max-w-60 truncate font-medium text-stone-800">{title}</Td>
                  <Td className="tabular-nums">{row.started_count}</Td>
                  <Td className="tabular-nums">{row.completed_count}</Td>
                  <Td className="tabular-nums">{formatPct(completion)}</Td>
                  <Td
                    className={cn(
                      "tabular-nums",
                      hotDrop ? "font-semibold text-rose-600" : "text-stone-500"
                    )}
                  >
                    {row.dropoff_pct === null ? "—" : `−${formatPct(row.dropoff_pct * 100)}`}
                  </Td>
                  <Td>
                    {fb && fb.helpful_count + fb.confusing_count > 0 ? (
                      <FeedbackCounts
                        helpful={fb.helpful_count}
                        confusing={fb.confusing_count}
                        flagged={feedbackOutlier(fb.helpful_count, fb.confusing_count) !== null}
                      />
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    <EditorLink href={editorBlockHref(courseId, row.lesson_id)} />
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {/* ── Video retention ── */}
      <Card>
        <CardHeader
          title="Video retention"
          subtitle="Learners reaching each quartile, per video lesson"
        />
        {videoBlocks.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Film}
              title="No video plays yet"
              hint="Quartile retention appears once learners start watching video lessons."
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {videoBlocks.map((video) => {
              const info = maps.blocks.get(video.block_id);
              const bars = [video.q1_count, video.q2_count, video.q3_count, video.q4_count];
              const hasPlays = Math.max(...bars, video.viewers) > 0;
              return (
                /* .cv-row per card (divs support containment): off-screen
                   retention cards skip layout/paint. ~190px ≈ title + chart. */
                <div
                  key={video.block_id}
                  style={{ "--cv-size": "190px" } as React.CSSProperties}
                  className="cv-row rounded-xl border border-stone-200/80 p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-medium text-stone-800">
                      {info?.title || info?.lessonTitle || "Video lesson"}
                    </p>
                    <EditorLink
                      href={editorBlockHref(courseId, video.lesson_id, video.block_id)}
                    />
                  </div>
                  <p className="mt-0.5 text-xs text-stone-400">
                    {video.viewers} viewer{video.viewers === 1 ? "" : "s"} ·{" "}
                    {video.completed_count} finished
                  </p>
                  {hasPlays ? (
                    <div className="mt-3 h-24">
                      <BarChart data={bars} labels={["25%", "50%", "75%", "Done"]} />
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-stone-400">No plays recorded yet.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ── Quiz item analysis — rendered ONLY when the publication has quizzes ── */}
      {maps.hasQuiz ? (
        <Card>
          <CardHeader
            title="Quiz item analysis"
            subtitle="Per-question difficulty, distractors, and discrimination"
          />
          {questionRows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={HelpCircle}
                title="No quiz responses yet"
                hint="Item analysis appears after learners submit quiz attempts."
              />
            </div>
          ) : (
            <Table
              head={["Question", "Lesson", "n", "% correct", "Discrim.", "Top wrong answer", "Flags", ""]}
              estimateRows={questionRows.length}
            >
              {questionRows.map(({ row, flags, topWrong }) => {
                const q = maps.questions.get(row.question_id);
                const info = maps.blocks.get(row.block_id);
                return (
                  <tr
                    key={row.question_id}
                    className={cn("border-t border-stone-100", flags.length > 0 && "bg-rose-50/40")}
                  >
                    <Td className="max-w-64 truncate font-medium text-stone-800">
                      {q?.prompt ?? row.question_id}
                    </Td>
                    <Td className="max-w-40 truncate text-stone-500">
                      {info?.lessonTitle ?? "—"}
                    </Td>
                    <Td className="tabular-nums">{row.n}</Td>
                    <Td
                      className={cn(
                        "tabular-nums",
                        flags.some((f) => f.type === "low_correct") &&
                          "font-semibold text-rose-600"
                      )}
                    >
                      {formatPct(row.pct_correct)}
                    </Td>
                    <Td
                      className={cn(
                        "tabular-nums",
                        flags.some((f) => f.type === "low_discrimination") &&
                          "font-semibold text-rose-600"
                      )}
                    >
                      {row.discrimination === null ? "—" : row.discrimination.toFixed(2)}
                    </Td>
                    <Td className="max-w-44 truncate text-stone-500">
                      {topWrong ? `${bucketLabel(topWrong[0], maps)} (${topWrong[1]})` : "—"}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {flags.map((f) => (
                          <span
                            key={f.type}
                            title={f.detail}
                            className="inline-flex rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700"
                          >
                            {FLAG_LABEL[f.type]}
                          </span>
                        ))}
                      </span>
                    </Td>
                    <Td>
                      <EditorLink
                        href={editorBlockHref(
                          courseId,
                          row.lesson_id,
                          row.block_id
                        )}
                      />
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      ) : null}

      {/* ── Slide health — dwell + learner feedback, one per-slide surface ── */}
      <Card>
        <CardHeader
          title="Slide health"
          subtitle="Dwell outliers and learner feedback (latest reaction per learner), one signal per slide"
        />
        {slideDwell.length === 0 && slideFeedback.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Activity}
              title="No slide signals yet"
              hint="Dwell times and 👍/👎 reactions appear as learners page through slide decks."
            />
          </div>
        ) : slideHealth.length === 0 ? (
          <p className="px-5 py-6 text-sm text-stone-500">
            No outliers or feedback — slide dwell is even across the deck (course median{" "}
            {formatDwell(referenceMedian)}) and no reactions have landed yet.
          </p>
        ) : (
          <Table
            head={["Slide of", "Lesson", "Views", "Median dwell", "Helpful", "Confusing", "Signals", ""]}
            estimateRows={slideHealth.length}
          >
            {slideHealth.map((entry) => {
              const info = entry.blockId ? maps.blocks.get(entry.blockId) : undefined;
              const comments = parseFeedbackComments(entry.feedback?.recent_comments);
              const flagged = entry.feedbackSignal !== null;
              return (
                <FragmentRows key={entry.slideId}>
                  <tr className={cn("border-t border-stone-100", flagged && "bg-rose-50/40")}>
                    <Td className="max-w-52 truncate font-medium text-stone-800">
                      {info?.title || "Slide deck"}
                    </Td>
                    <Td className="max-w-40 truncate text-stone-500">
                      {info?.lessonTitle ?? maps.lessonTitles.get(entry.lessonId) ?? "—"}
                    </Td>
                    <Td className="tabular-nums">{entry.dwell?.n ?? "—"}</Td>
                    <Td className="tabular-nums">
                      {entry.dwell ? formatDwell(entry.dwell.median_dwell_ms) : "—"}
                    </Td>
                    <Td className="tabular-nums">{entry.feedback?.helpful_count ?? 0}</Td>
                    <Td
                      className={cn(
                        "tabular-nums",
                        flagged && "font-semibold text-rose-600"
                      )}
                    >
                      {entry.feedback?.confusing_count ?? 0}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {entry.dwellSignal ? (
                          <span
                            className={cn(
                              "inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                              entry.dwellSignal === "skimmed"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-rose-100 text-rose-700"
                            )}
                          >
                            {entry.dwellSignal === "skimmed" ? "Skimmed" : "Stall"}
                          </span>
                        ) : null}
                        {entry.feedbackSignal ? (
                          <span
                            title={`${entry.feedback?.confusing_pct ?? 0}% of learners marked this confusing`}
                            className="inline-flex rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700"
                          >
                            Confusing
                          </span>
                        ) : null}
                      </span>
                    </Td>
                    <Td>
                      <EditorLink
                        href={editorBlockHref(
                          courseId,
                          entry.lessonId,
                          entry.blockId ?? undefined
                        )}
                      />
                    </Td>
                  </tr>
                  {comments.length > 0 ? (
                    <tr className={cn(flagged && "bg-rose-50/40")}>
                      <td colSpan={8} className="px-5 pb-3 pt-0">
                        <ul className="space-y-1">
                          {comments.slice(0, 3).map((c, i) => (
                            <li
                              key={`${c.at}-${i}`}
                              className="flex items-start gap-2 text-xs text-stone-500"
                            >
                              {c.reaction === "helpful" ? (
                                <ThumbsUp className="mt-0.5 size-3 shrink-0 text-emerald-500" aria-hidden />
                              ) : (
                                <ThumbsDown className="mt-0.5 size-3 shrink-0 text-rose-400" aria-hidden />
                              )}
                              <span className="min-w-0 flex-1">
                                “{c.comment}”
                                {c.at ? (
                                  <span className="ml-1 text-stone-400">· {timeAgo(c.at)}</span>
                                ) : null}
                              </span>
                            </li>
                          ))}
                          {comments.length > 3 ? (
                            <li className="text-xs text-stone-400">
                              +{comments.length - 3} more comment{comments.length - 3 === 1 ? "" : "s"}
                            </li>
                          ) : null}
                        </ul>
                      </td>
                    </tr>
                  ) : null}
                </FragmentRows>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}

/** 👍/👎 count pair for the funnel's Feedback column. */
function FeedbackCounts({
  helpful,
  confusing,
  flagged,
}: {
  helpful: number;
  confusing: number;
  flagged: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-xs tabular-nums">
      <span className="inline-flex items-center gap-1 text-stone-500">
        <ThumbsUp className="size-3 text-emerald-500" aria-hidden />
        {helpful}
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-1",
          flagged ? "font-semibold text-rose-600" : "text-stone-500"
        )}
      >
        <ThumbsDown className={cn("size-3", flagged ? "text-rose-500" : "text-rose-300")} aria-hidden />
        {confusing}
      </span>
    </span>
  );
}

/** Keyed multi-row wrapper (a slide row + its optional comments row). */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/* ───────────────────────────── Table shell ─────────────────────────────── */

/** PERF-1 D2 (A5 §6, A6 #23): CSS containment has no effect on <tr> (internal
 *  table boxes), so each table's scroll WRAPPER is the skippable unit — the
 *  stacked below-the-fold tables on this tab (quiz item analysis, slide
 *  health) skip layout/paint until scrolled to. `estimateRows` sizes the
 *  placeholder (~45px/row + header); row-level DOM/payload bounding is the
 *  recorded C2-backlog pagination item. */
function Table({
  head,
  estimateRows = 8,
  children,
}: {
  head: string[];
  estimateRows?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="cv-row overflow-x-auto"
      style={{ "--cv-size": `${40 + estimateRows * 45}px` } as React.CSSProperties}
    >
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={`${h}-${i}`}
                className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ className, children }: { className?: string; children: React.ReactNode }) {
  return <td className={cn("px-5 py-3 text-sm text-stone-600", className)}>{children}</td>;
}

function EditorLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      title="Open in the editor"
      className="inline-flex size-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-brand-600"
    >
      <ExternalLink className="size-3.5" aria-hidden />
    </Link>
  );
}
