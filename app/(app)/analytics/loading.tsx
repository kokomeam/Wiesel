import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

/**
 * Analytics course-picker loading skeleton — header + the 3-column card grid
 * (icon tile, badge, title, learner-count footer) matching the real cards.
 */
export default function AnalyticsPickerLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <div className="space-y-2.5">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-[28rem] max-w-full" />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <SkeletonCard key={i}>
            <div className="flex h-full flex-col space-y-4">
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="size-10 rounded-xl" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
              </div>
              <Skeleton className="mt-auto h-3 w-24" />
            </div>
          </SkeletonCard>
        ))}
      </div>
    </div>
  );
}
