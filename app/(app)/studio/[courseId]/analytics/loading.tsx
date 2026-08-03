import { Skeleton } from "@/components/ui/Skeleton";

const CARD = "rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]";

/**
 * Course-analytics loading skeleton, shaped like the DEFAULT tab (Overview):
 * PageHeader with the two action pills, the ?tab= nav row, the 4-Stat band,
 * then the two Overview cards (lesson funnel rows + the h-40 enrollments
 * chart) at their exact paddings so the swap doesn't shift.
 */
export default function CourseAnalyticsLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      {/* PageHeader + actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Skeleton className="h-9 w-80 max-w-full sm:h-10" />
          <Skeleton className="mt-2 h-4 w-56" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-32 rounded-full" />
          <Skeleton className="h-9 w-32 rounded-full" />
        </div>
      </div>

      {/* Tab nav (px-4 py-2.5 links on a border-b rail) */}
      <div className="flex flex-wrap gap-1 border-b border-stone-200/80">
        {["w-20", "w-28", "w-20", "w-24"].map((w, i) => (
          <div key={i} className="px-4 py-2.5">
            <Skeleton className={`h-5 rounded-md ${w}`} />
          </div>
        ))}
      </div>

      {/* Stat band (Stat: p-5, text-sm label / mt-2 text-3xl value / mt-1 sub) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} aria-hidden className={`${CARD} p-5`}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-9 w-16" />
            <Skeleton className="mt-1 h-4 w-28 max-w-full" />
          </div>
        ))}
      </div>

      {/* Lesson funnel card */}
      <div aria-hidden className={CARD}>
        <div className="flex items-start justify-between gap-4 border-b border-stone-200/70 px-5 py-4">
          <div>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-1.5 h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-6 w-36 rounded-md" />
        </div>
        <div className="space-y-2 p-5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-3 w-6 shrink-0" />
              <Skeleton className="h-4 w-52 shrink-0" />
              <Skeleton className="h-5 flex-1 rounded-md" />
              <Skeleton className="h-3 w-14 shrink-0" />
              <Skeleton className="h-3 w-16 shrink-0" />
            </div>
          ))}
          <div className="flex justify-end gap-4 pt-1">
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="h-2.5 w-12" />
          </div>
        </div>
      </div>

      {/* Enrollments-over-time card (AreaChart height 160 = h-40) */}
      <div aria-hidden className={CARD}>
        <div className="border-b border-stone-200/70 px-5 py-4">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-1.5 h-3 w-32" />
        </div>
        <div className="px-2 pb-4 pt-5">
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}
