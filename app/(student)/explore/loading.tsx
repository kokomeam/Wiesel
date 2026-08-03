import { Skeleton } from "@/components/ui/Skeleton";

/**
 * /explore loading skeleton — mirrors the real page (paper-glow container,
 * learn-toned PageHeader with eyebrow, the 3-col grid of ListingCards with
 * their aspect-[16/9] cover media) so the swap to real content doesn't shift.
 */

/** Geometry twin of components/learn/CourseCards.tsx ListingCard. */
function ListingCardSkeleton() {
  return (
    <div
      aria-hidden
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      {/* Cover media */}
      <Skeleton className="aspect-[16/9] w-full rounded-none" />
      <div className="flex flex-1 flex-col p-4">
        {/* Title (line-clamp-2 min-h-[2.5rem]) */}
        <div className="min-h-[2.5rem] space-y-1.5">
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        {/* Creator + rating row */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </span>
          <Skeleton className="h-3 w-14" />
        </div>
        {/* Description */}
        <div className="mt-2 space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
        {/* Module / lesson meta chips */}
        <div className="mb-4 mt-3 flex items-center gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-16" />
        </div>
        {/* Free + CTA pill footer */}
        <div className="mt-auto flex items-center justify-between border-t border-stone-100 pt-4">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-7 w-24 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export default function ExploreLoading() {
  return (
    <div
      className="paper-glow mx-auto w-full max-w-6xl px-6 py-8"
      style={{ "--glow-color": "rgba(125,211,252,0.25)" } as React.CSSProperties}
    >
      {/* PageHeader (eyebrow + serif title + description) */}
      <div>
        <Skeleton className="mb-2 h-4 w-28" />
        <Skeleton className="h-9 w-36 sm:h-10" />
        <Skeleton className="mt-1.5 h-5 w-80 max-w-full" />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <ListingCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
