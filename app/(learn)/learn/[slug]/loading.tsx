import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

/** Mirrors the /learn/[slug] landing: hero grid (copy + conversion card with
 *  aspect-video cover), outcomes card, curriculum module cards. */
export default function CourseLandingLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10 sm:py-14">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        {/* Hero copy */}
        <div>
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-4 h-12 w-4/5" />
          <Skeleton className="mt-5 h-4 w-full max-w-2xl" />
          <Skeleton className="mt-2 h-4 w-3/5" />
          <div className="mt-6 flex gap-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
          </div>
          <div className="mt-5 flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>

        {/* Conversion card */}
        <SkeletonCard className="w-full p-0">
          <Skeleton className="aspect-video w-full rounded-b-none rounded-t-2xl" />
          <div className="p-6">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="mt-2 h-3 w-52" />
            <Skeleton className="mt-5 h-11 w-full rounded-full" />
            <div className="mt-6 space-y-2.5 border-t border-stone-100 pt-5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-36" />
            </div>
          </div>
        </SkeletonCard>
      </div>

      {/* Outcomes */}
      <div className="mt-16 sm:mt-20">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-8 w-64" />
        <SkeletonCard className="mt-6 p-6 sm:p-8">
          <div className="grid gap-x-8 gap-y-3.5 sm:grid-cols-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="size-5 rounded-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ))}
          </div>
        </SkeletonCard>
      </div>

      {/* Curriculum */}
      <div className="mt-16 sm:mt-20">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-8 w-56" />
        <div className="mt-6 space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonCard key={i} className="p-0">
              <div className="flex items-center gap-4 px-5 py-4 sm:px-6">
                <Skeleton className="size-9 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="size-4 rounded" />
              </div>
            </SkeletonCard>
          ))}
        </div>
      </div>
    </div>
  );
}
