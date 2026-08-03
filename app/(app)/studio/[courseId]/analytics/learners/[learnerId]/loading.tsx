import { Skeleton } from "@/components/ui/Skeleton";

const CARD = "rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]";

/**
 * Learner-detail loading skeleton — mirrors the page: back link, name header
 * with the risk badge, the 4-Stat band, the two-column lesson-progress /
 * quiz-attempts grid, then the activity-timeline card's divide-y rows.
 */
export default function LearnerDetailLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      {/* Back link */}
      <Skeleton className="h-4 w-48" />

      {/* Name + meta / risk badge */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          {/* h1 is text-[1.7rem] at inherited 1.5 leading ≈ a 40px line box */}
          <Skeleton className="h-10 w-56 max-w-full" />
          <Skeleton className="mt-1 h-5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>

      {/* Stat band */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} aria-hidden className={`${CARD} p-5`}>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-9 w-16" />
            <Skeleton className="mt-1 h-4 w-28 max-w-full" />
          </div>
        ))}
      </div>

      {/* Lesson progress / quiz attempts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div aria-hidden className={CARD}>
          <div className="border-b border-stone-200/70 px-5 py-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-1.5 h-3 w-24" />
          </div>
          <div className="divide-y divide-stone-100">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-2.5">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <Skeleton className="h-3 w-5 shrink-0" />
                <Skeleton className={`h-4 ${i % 2 === 0 ? "w-3/5" : "w-2/5"}`} />
                <Skeleton className="ml-auto h-3 w-8 shrink-0" />
              </div>
            ))}
          </div>
        </div>

        <div aria-hidden className={CARD}>
          <div className="border-b border-stone-200/70 px-5 py-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-1.5 h-3 w-20" />
          </div>
          <div className="divide-y divide-stone-100">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3">
                <Skeleton className="size-4 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-5 w-12 shrink-0 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Activity timeline */}
      <div aria-hidden className={CARD}>
        <div className="border-b border-stone-200/70 px-5 py-4">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-1.5 h-3 w-48" />
        </div>
        <div className="divide-y divide-stone-100">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-5 py-2.5">
              <Skeleton className="size-1.5 shrink-0 rounded-full" />
              <Skeleton className={`h-4 ${i % 3 === 0 ? "w-1/2" : "w-2/3"}`} />
              <Skeleton className="ml-auto h-3 w-16 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
