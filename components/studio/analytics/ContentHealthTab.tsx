import { Activity, ExternalLink, Film, HelpCircle } from "lucide-react";
import Link from "next/link";
import { BarChart } from "@/components/charts/BarChart";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  bucketLabel,
  editorBlockHref,
  type CourseAnalytics,
  type SnapshotMaps,
} from "@/lib/analytics/dashboard";
import { dwellOutlier, questionFlags, type QuestionFlag } from "@/lib/analytics/flags";
import { median } from "@/lib/analytics/stats";
import { cn } from "@/lib/cn";
import { EmptyState } from "./EmptyState";
import { formatDwell, formatPct } from "./format";

const FLAG_LABEL: Record<QuestionFlag["type"], string> = {
  low_correct: "Low % correct",
  strong_distractor: "Strong distractor",
  low_discrimination: "Low discrimination",
};

/** Content health: drop-off table · video retention · quiz item analysis ·
 *  slide dwell outliers. Every flagged row deep-links into the editor. */
export function ContentHealthTab({
  analytics,
  maps,
  courseId,
}: {
  analytics: CourseAnalytics;
  maps: SnapshotMaps;
  courseId: string;
}) {
  const { funnel, questionStats, slideDwell, videoRetention } = analytics;

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

  /* Slide dwell outliers vs the publication's reference median. */
  const referenceMedian =
    median(
      slideDwell
        .map((s) => s.median_dwell_ms)
        .filter((v): v is number => v !== null)
    ) ?? 0;
  const dwellOutliers = slideDwell
    .map((row) => ({
      row,
      outlier: dwellOutlier(row.median_dwell_ms ?? 0, referenceMedian, row.n),
    }))
    .filter((entry) => entry.outlier !== null);

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
            head={["#", "Lesson", "Started", "Completed", "Completion", "Drop-off", ""]}
          >
            {funnel.map((row) => {
              const title = maps.lessonTitles.get(row.lesson_id) ?? "Untitled lesson";
              const completion =
                row.started_count > 0
                  ? (100 * row.completed_count) / row.started_count
                  : null;
              const hotDrop = row.dropoff_pct !== null && row.dropoff_pct >= 0.3;
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
                <div key={video.block_id} className="rounded-xl border border-stone-200/80 p-4">
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

      {/* ── Slide dwell outliers ── */}
      <Card>
        <CardHeader
          title="Slide dwell outliers"
          subtitle="Slides learners skim past or stall on, vs the course median"
        />
        {slideDwell.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Activity}
              title="No slide dwell data yet"
              hint="Dwell times appear as learners page through slide decks."
            />
          </div>
        ) : dwellOutliers.length === 0 ? (
          <p className="px-5 py-6 text-sm text-stone-500">
            No outliers — slide dwell is even across the deck (course median{" "}
            {formatDwell(referenceMedian)}).
          </p>
        ) : (
          <Table head={["Slide of", "Lesson", "Views", "Median dwell", "p90", "Signal", ""]}>
            {dwellOutliers.map(({ row, outlier }) => {
              const info = maps.blocks.get(row.block_id);
              return (
                <tr key={row.slide_id} className="border-t border-stone-100">
                  <Td className="max-w-52 truncate font-medium text-stone-800">
                    {info?.title || "Slide deck"}
                  </Td>
                  <Td className="max-w-40 truncate text-stone-500">
                    {info?.lessonTitle ?? "—"}
                  </Td>
                  <Td className="tabular-nums">{row.n}</Td>
                  <Td className="tabular-nums">{formatDwell(row.median_dwell_ms)}</Td>
                  <Td className="tabular-nums">{formatDwell(row.p90_dwell_ms)}</Td>
                  <Td>
                    <span
                      className={cn(
                        "inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                        outlier === "skimmed"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-rose-100 text-rose-700"
                      )}
                    >
                      {outlier === "skimmed" ? "Skimmed" : "Stall"}
                    </span>
                  </Td>
                  <Td>
                    <EditorLink
                      href={editorBlockHref(courseId, row.lesson_id, row.block_id)}
                    />
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ───────────────────────────── Table shell ─────────────────────────────── */

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
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
