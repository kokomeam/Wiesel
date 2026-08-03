import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";

/** Settings loading skeleton — header, then the profile form + preview grid,
 *  then the account card, so the swap to real content doesn't jump. */
export default function SettingsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      <div className="space-y-2.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <SkeletonCard className="p-6">
          <div className="flex items-center gap-4">
            <Skeleton className="size-20 shrink-0 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-32 rounded-full" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
          <div className="mt-6 space-y-5">
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        </SkeletonCard>
        <SkeletonCard>
          <div className="space-y-3">
            <Skeleton className="h-3 w-32" />
            <div className="flex items-start gap-3 pt-1">
              <Skeleton className="size-12 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        </SkeletonCard>
      </div>

      <SkeletonCard className="p-0">
        <div className="border-b border-stone-100 px-5 py-4">
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="space-y-4 p-5">
          <Skeleton className="h-4 w-56" />
          <div className="grid gap-2 sm:grid-cols-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      </SkeletonCard>
    </div>
  );
}
