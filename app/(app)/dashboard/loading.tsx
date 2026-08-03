import { Skeleton } from "@/components/ui/Skeleton";

const CARD = "rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]";

/**
 * Dashboard loading skeleton — mirrors the page's shape (identity band with
 * avatar + name lines + action pills, 4 icon Stat tiles, then the 2/1 grid:
 * "Course health" section header + md:grid-cols-2 CourseHealthCards + funnel
 * card on the left, AttentionRail + RevenueCard on the right rail) so the
 * swap to real content doesn't jump.
 */
export default function DashboardLoading() {
  return (
    <div className="paper-glow mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      {/* Identity band (Card p-6 sm:p-8 — NOT SkeletonCard: its baked-in p-5
          would conflict, cn is not tailwind-merge) */}
      <div aria-hidden className={`${CARD} p-6 sm:p-8`}>
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <Skeleton className="size-20 shrink-0 rounded-full sm:size-24" />
          <div className="min-w-0 flex-1 space-y-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-64 max-w-full sm:h-10" />
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3 w-80 max-w-full" />
          </div>
          {/* Page actions + edit toggle (row on mobile, stacked right on sm+) */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-28 rounded-full" />
              <Skeleton className="h-9 w-32 rounded-full" />
            </div>
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
        </div>
      </div>

      {/* Stat tiles (icon chip + label, mt-2 value, mt-1 sub) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} aria-hidden className={`${CARD} p-5`}>
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0 rounded-xl" />
              <Skeleton className="h-4 w-24" />
            </div>
            <Skeleton className="mt-2 h-9 w-20" />
            <Skeleton className="mt-1 h-4 w-36 max-w-full" />
          </div>
        ))}
      </div>

      {/* Main 2/1 grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* "Course health" section: eyebrow + serif heading + count */}
          <section className="space-y-4" aria-hidden>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-1.5 h-6 w-32" />
              </div>
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className={`${CARD} flex flex-col p-5`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Skeleton className="size-14 shrink-0 rounded-xl" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                    <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
                  </div>
                  <div className="mt-3 flex items-center gap-4">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                    <Skeleton className="h-3 w-24" />
                    <div className="flex items-center gap-1.5">
                      <Skeleton className="h-8 w-16 rounded-full" />
                      <Skeleton className="h-8 w-24 rounded-full" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Funnel snapshot card (px-5 pt-5 eyebrow + serif title header,
              per-lesson label + h-2.5 bar rows, legend, p-5 footer callout) */}
          <div aria-hidden className={CARD}>
            <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
              <div>
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1 h-7 w-52 max-w-full" />
              </div>
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="space-y-3.5 px-5 pt-4">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i}>
                  <div className="flex items-baseline justify-between gap-3">
                    <Skeleton className={`h-3 ${i % 2 === 0 ? "w-40" : "w-48"} max-w-full`} />
                    <Skeleton className="h-3 w-32 shrink-0" />
                  </div>
                  <Skeleton className="mt-1.5 h-2.5 w-full rounded-full" />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 px-5 pt-3">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="p-5">
              <Skeleton className="h-12 w-full rounded-xl" />
            </div>
          </div>
        </div>

        {/* Right rail: AttentionRail + RevenueCard */}
        <div className="space-y-6">
          <div aria-hidden className={CARD}>
            <div className="px-5 pt-5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-1 h-7 w-56 max-w-full" />
            </div>
            <div className="space-y-2.5 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="space-y-2 rounded-xl border border-stone-200/80 bg-stone-50/40 p-3.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          </div>

          <div aria-hidden className={`${CARD} p-5`}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-9 w-12" />
            <Skeleton className="mt-1 h-4 w-48 max-w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
