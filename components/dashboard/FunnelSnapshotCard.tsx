import Link from "next/link";
import { ArrowRight, BarChart3, TrendingDown } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { CourseHealth, FunnelSummary } from "@/lib/analytics/creatorHome";

function barPct(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/**
 * The dashboard funnel snapshot for the spotlight course (most learners with
 * a live publication): per-lesson started/completed bars over the SQL rollup
 * (rollup_lesson_funnel — dropoff_pct precomputed via lag()), plus the
 * biggest-dropoff callout. Counts render as text; the bars are decorative.
 */
export function FunnelSnapshotCard({
  course,
  summary,
  lessonTitles,
}: {
  course: CourseHealth;
  summary: FunnelSummary;
  lessonTitles: Record<string, string>;
}) {
  const dropoff = summary.biggestDropoff;
  const dropoffTitle = dropoff
    ? (lessonTitles[dropoff.lessonId] ?? "an untitled lesson")
    : null;

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-wider text-brand-700">
            Funnel snapshot
          </p>
          <h2 className="mt-1 truncate text-lg font-light text-stone-900 [font-family:var(--font-display)]">
            {course.title}
          </h2>
        </div>
        <Link
          href={`/studio/${course.id}/analytics?tab=content`}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 focus-visible:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          Content health
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>

      <ol className="space-y-3.5 px-5 pt-4">
        {summary.lessons.map((lesson, i) => (
          <li key={lesson.lessonId}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-medium text-stone-700">
                {i + 1}. {lessonTitles[lesson.lessonId] ?? "Untitled lesson"}
              </span>
              <span className="shrink-0 tabular-nums text-stone-400">
                {lesson.started} started · {lesson.completed} completed
              </span>
            </div>
            <div
              aria-hidden
              className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-stone-100"
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-brand-200/70"
                style={{ width: `${barPct(lesson.started, summary.maxStarted)}%` }}
              />
              <div
                className="brand-gradient absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${barPct(lesson.completed, summary.maxStarted)}%` }}
              />
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-3 text-[11px] text-stone-400">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full bg-brand-200" />
          Started
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="brand-gradient size-2 rounded-full" />
          Completed
        </span>
      </div>

      <div className="p-5">
        {dropoff ? (
          <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 ring-1 ring-inset ring-amber-100">
            <TrendingDown className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Biggest drop-off: <strong className="font-semibold">{dropoffTitle}</strong>{" "}
              — {Math.round(dropoff.dropoffPct ?? 0)}% fewer learners start it than
              the lesson before.
            </span>
          </p>
        ) : (
          <p className="rounded-xl bg-stone-50 px-3.5 py-2.5 text-xs text-stone-500 ring-1 ring-inset ring-stone-100">
            No drop-off between lessons yet — learners are flowing straight through.
          </p>
        )}
      </div>
    </Card>
  );
}

/** Honest empty state when no live course has funnel rollups yet. */
export function FunnelEmptyCard() {
  return (
    <Card className="p-5">
      <p className="font-mono text-[11px] uppercase tracking-wider text-brand-700">
        Funnel snapshot
      </p>
      <div className="mt-4 flex flex-col items-center gap-2 py-6 text-center">
        <span className="grid size-10 place-items-center rounded-full bg-stone-100 text-stone-400">
          <BarChart3 className="size-5" aria-hidden />
        </span>
        <p className="text-sm font-medium text-stone-700">No funnel data yet</p>
        <p className="max-w-sm text-xs leading-relaxed text-stone-400">
          Publish a course and the lesson-by-lesson funnel appears here after
          your first learners start studying.
        </p>
      </div>
    </Card>
  );
}
