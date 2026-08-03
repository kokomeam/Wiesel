import { cn } from "@/lib/cn";

/**
 * Loading placeholder blocks for route-level loading.tsx files and
 * Suspense fallbacks. Server-safe (no client hooks); the shimmer sweep
 * lives in globals.css (.skeleton-shimmer) and is neutralized by the
 * global reduced-motion guard.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("skeleton-shimmer rounded-xl bg-stone-200/60", className)}
    />
  );
}

/** A card-shaped skeleton matching the house Card chrome. */
export function SkeletonCard({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "rounded-card border border-stone-200/80 bg-white p-5 shadow-card",
        className
      )}
    >
      {children ?? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}
    </div>
  );
}

/** Standard page scaffold: header row + a grid of skeleton cards. */
export function SkeletonPage({ cards = 6 }: { cards?: number }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-8 space-y-2.5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
