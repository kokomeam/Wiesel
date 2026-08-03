/**
 * Loading skeleton for the marketing hub (UI-1 W5.3) — mirrors the real
 * layout's dimensions (header, nav strip, ask bar, stat tiles, two-column
 * grid) so the swap to content causes no layout shift.
 */

import { cn } from "@/lib/cn";

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-panel bg-stone-200/60", className)} />;
}

function CardBone({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("rounded-card border border-stone-200/80 bg-white p-card-pad shadow-card", className)}>
      {children}
    </div>
  );
}

export function HubSkeleton() {
  return (
    <div className="mx-auto max-w-7xl space-y-section-gap p-6 lg:p-8" data-testid="hub-skeleton" aria-busy>
      {/* page header */}
      <div className="space-y-2">
        <Bone className="h-9 w-72" />
        <Bone className="h-4 w-96 max-w-full" />
      </div>
      {/* section nav strip */}
      <div className="flex gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Bone key={i} className="h-8 w-28 rounded-full" />
        ))}
      </div>
      {/* ask bar */}
      <CardBone>
        <div className="flex items-center gap-3">
          <Bone className="size-9" />
          <Bone className="h-10 flex-1" />
          <Bone className="h-9 w-20 rounded-full" />
        </div>
      </CardBone>
      {/* stat tiles */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <CardBone key={i} className="p-4">
            <Bone className="h-3 w-20" />
            <Bone className="mt-2 h-7 w-16" />
            <Bone className="mt-1.5 h-3 w-24" />
          </CardBone>
        ))}
      </div>
      {/* work column + rail */}
      <div className="grid grid-cols-1 items-start gap-gutter lg:grid-cols-[minmax(0,1fr)_var(--spacing-rail)]">
        <div className="min-w-0 space-y-section-gap">
          <CardBone>
            <div className="flex items-center gap-3">
              <Bone className="size-9" />
              <div className="min-w-0 flex-1 space-y-2">
                <Bone className="h-4 w-1/2" />
                <Bone className="h-3 w-1/3" />
              </div>
              <Bone className="h-8 w-24 rounded-full" />
            </div>
          </CardBone>
          <CardBone>
            <Bone className="h-4 w-32" />
            <div className="mt-4 space-y-3">
              <Bone className="h-10 w-full" />
              <Bone className="h-10 w-full" />
            </div>
          </CardBone>
        </div>
        <div className="min-w-0 space-y-section-gap">
          <CardBone>
            <Bone className="h-4 w-24" />
            <div className="mt-3 space-y-2.5">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Bone className="size-4 rounded-full" />
                  <Bone className="h-3.5 flex-1" />
                  <Bone className="h-4 w-14 rounded-full" />
                </div>
              ))}
            </div>
          </CardBone>
          <CardBone className="p-4">
            <div className="flex items-center gap-3">
              <Bone className="size-8" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Bone className="h-3.5 w-2/3" />
                <Bone className="h-3 w-1/2" />
              </div>
            </div>
          </CardBone>
        </div>
      </div>
    </div>
  );
}
