import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

/** Mirrors /home's real shape: greeting → continue hero → 4-tile stat band →
 *  course grid, with the AI-tutor rail on xl. */
export default function HomeLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-8">
          <div className="space-y-2.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-9 w-72 max-w-full" />
          </div>
          <SkeletonCard>
            <div className="space-y-4">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-1.5 w-full" />
              <Skeleton className="h-9 w-40 rounded-full" />
            </div>
          </SkeletonCard>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonCard key={i}>
                <div className="space-y-2.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-8 w-14" />
                </div>
              </SkeletonCard>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </div>
        <div className="hidden xl:block">
          <SkeletonCard className="h-[540px]">
            <div className="space-y-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-8 w-3/4 rounded-full" />
              <Skeleton className="h-8 w-2/3 rounded-full" />
            </div>
          </SkeletonCard>
        </div>
      </div>
    </div>
  );
}
