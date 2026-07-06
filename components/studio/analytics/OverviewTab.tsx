import { Share2, TrendingDown, Users } from "lucide-react";
import Link from "next/link";
import { AreaChart } from "@/components/charts/AreaChart";
import { Card, CardHeader } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import type { CourseAnalytics } from "@/lib/analytics/dashboard";
import { cn } from "@/lib/cn";
import { EmptyState } from "./EmptyState";
import { formatPct } from "./format";

/** Overview tab: enrollment stats + the hero lesson-by-lesson funnel. */
export function OverviewTab({
  analytics,
  slug,
  lessonTitles,
}: {
  analytics: CourseAnalytics;
  /** Live slug — powers the "share your course" empty-state link. */
  slug: string;
  lessonTitles: Map<string, string>;
}) {
  const { overview, funnel } = analytics;
  const completionRate =
    overview.totalEnrollments > 0
      ? (100 * overview.completedEnrollments) / overview.totalEnrollments
      : null;

  // Cumulative enrollments curve (AreaChart needs ≥2 points).
  const cumulative = overview.enrollmentsByDay.reduce<number[]>(
    (acc, d) => [...acc, (acc.at(-1) ?? 0) + d.count],
    []
  );

  const maxStarted = Math.max(0, ...funnel.map((f) => f.started_count));
  const steepest = funnel.reduce<(typeof funnel)[number] | null>(
    (worst, row) =>
      row.dropoff_pct !== null &&
      row.dropoff_pct > 0 &&
      (worst === null || (worst.dropoff_pct ?? 0) < row.dropoff_pct)
        ? row
        : worst,
    null
  );

  if (overview.totalEnrollments === 0) {
    return (
      <EmptyState
        icon={Share2}
        title="No learners yet"
        hint="Analytics appear as students enroll and study. Share your course link to get your first learners."
        action={
          <Link
            href={`/learn/${slug}`}
            className="brand-gradient mt-1 rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
          >
            Open your course page
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Enrollments" value={String(overview.totalEnrollments)} />
        <Stat
          label="Active learners (7d)"
          value={String(overview.active7d)}
          sub={`${overview.activeEnrollments} active enrollments`}
        />
        <Stat
          label="Completion rate"
          value={completionRate === null ? "—" : formatPct(completionRate)}
          sub={`${overview.completedEnrollments} completed`}
        />
        <Stat
          label="Lessons live"
          value={String(funnel.length)}
          sub="in the current version"
        />
      </div>

      {/* Hero: lesson-by-lesson funnel for the live version. */}
      <Card>
        <CardHeader
          title="Lesson funnel"
          subtitle="Learners who started each lesson, in course order"
          action={
            steepest ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600">
                <TrendingDown className="size-3.5" aria-hidden />
                {formatPct((steepest.dropoff_pct ?? 0) * 100)} drop at lesson{" "}
                {steepest.lesson_order}
              </span>
            ) : undefined
          }
        />
        {funnel.length === 0 || maxStarted === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Users}
              title="No lesson activity yet"
              hint="The funnel fills in as learners open lessons. Data refreshes nightly — or use “Refresh data” above."
            />
          </div>
        ) : (
          <div className="space-y-2 p-5">
            {funnel.map((row) => {
              const title = lessonTitles.get(row.lesson_id) ?? "Untitled lesson";
              const isSteepest = steepest?.lesson_id === row.lesson_id;
              return (
                <div key={row.lesson_id} className="flex items-center gap-3">
                  <span className="w-6 shrink-0 text-right font-mono text-[11px] text-stone-400">
                    {row.lesson_order}
                  </span>
                  <span className="w-52 shrink-0 truncate text-sm text-stone-700" title={title}>
                    {title}
                  </span>
                  <div className="h-5 flex-1 overflow-hidden rounded-md bg-stone-100">
                    <div
                      className={cn(
                        "h-full rounded-md",
                        isSteepest ? "bg-rose-400/80" : "brand-gradient opacity-80"
                      )}
                      style={{ width: `${(row.started_count / maxStarted) * 100}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right text-xs tabular-nums text-stone-500">
                    {row.started_count}
                  </span>
                  <span
                    className={cn(
                      "w-16 shrink-0 text-right text-xs tabular-nums",
                      row.dropoff_pct !== null && row.dropoff_pct >= 0.3
                        ? "font-semibold text-rose-600"
                        : "text-stone-400"
                    )}
                  >
                    {row.dropoff_pct === null ? "—" : `−${formatPct(row.dropoff_pct * 100)}`}
                  </span>
                </div>
              );
            })}
            <div className="flex justify-end gap-4 pt-1 text-[10px] uppercase tracking-wide text-stone-400">
              <span>started</span>
              <span>drop-off</span>
            </div>
          </div>
        )}
      </Card>

      {/* Enrollments over time (needs ≥2 days of signups for a curve). */}
      <Card>
        <CardHeader title="Enrollments over time" subtitle="Cumulative signups" />
        <div className="px-2 pb-4 pt-5">
          {cumulative.length >= 2 ? (
            <AreaChart data={cumulative} height={160} />
          ) : (
            <p className="px-3 pb-2 text-sm text-stone-500">
              {overview.totalEnrollments} enrollment
              {overview.totalEnrollments === 1 ? "" : "s"} so far — the curve appears
              once signups span more than one day.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
