import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

/**
 * Lesson-player loading skeleton — the contents sidebar rail (lg+) beside the
 * lesson column (back link, serif title, meta line, content blocks, prev/next
 * bar), matching /learn/[slug]/[lessonId]'s real shape. The content column
 * also mirrors LearnLessonView's two rows ABOVE the deck — the sticky
 * micro-progress pill and the objective callout — at their real geometry so
 * the deck frame (and everything below it) doesn't shift on swap.
 */
export default function LessonPlayerLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:gap-10 lg:py-10">
      {/* Contents rail (mobile shows the pill trigger) */}
      <div className="lg:hidden">
        <Skeleton className="h-9 w-40 rounded-full" />
      </div>
      <aside className="hidden w-72 shrink-0 lg:block" aria-hidden>
        <SkeletonCard className="sticky top-20 p-0">
          <div className="space-y-2 border-b border-stone-100 px-3.5 py-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
          <div className="space-y-3 px-3.5 py-4">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className={`h-3.5 ${i % 3 === 0 ? "w-2/3" : "w-4/5"}`} />
              </div>
            ))}
          </div>
        </SkeletonCard>
      </aside>

      {/* Lesson column */}
      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-3xl">
          {/* Header: back link, title, meta */}
          <div className="mb-8 space-y-3">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-4 w-56" />
          </div>

          {/* Content blocks: a slide-deck-shaped 16:9 frame + prose lines */}
          <div className="space-y-8">
            {/* Sticky micro-progress pill (LearnLessonView: sticky top-16,
                rounded-full bar, px-4 py-2 — text-xs line + w-20/28 bar) */}
            <div className="sticky top-16 z-20" aria-hidden>
              <div className="flex items-center gap-3 rounded-full border border-stone-200/80 bg-white/90 px-4 py-2 shadow-[0_2px_10px_rgba(68,48,28,0.1)] backdrop-blur">
                <span className="min-w-0 flex-1">
                  <Skeleton className="h-4 w-56 max-w-full" />
                </span>
                <Skeleton className="h-1.5 w-20 shrink-0 rounded-full sm:w-28" />
                <Skeleton className="h-4 w-8 shrink-0" />
              </div>
            </div>

            {/* Objective callout (rounded-xl px-5 py-4: mono eyebrow +
                mt-1 text-[15px] line) */}
            <div
              aria-hidden
              className="rounded-xl border border-learn-100 bg-learn-50/60 px-5 py-4"
            >
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-1.5 h-4 w-4/5" />
            </div>

            <Skeleton className="aspect-video w-full rounded-2xl" />
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <SkeletonCard>
              <div className="space-y-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </SkeletonCard>
          </div>

          {/* Prev / next bar */}
          <div className="mt-12 flex items-stretch justify-between gap-4 border-t border-stone-200/70 pt-6">
            <Skeleton className="h-14 w-40 rounded-xl" />
            <Skeleton className="h-14 w-40 rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
