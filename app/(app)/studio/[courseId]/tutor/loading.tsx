import { Skeleton } from "@/components/ui/Skeleton";

const CARD = "rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]";

/**
 * Tutor console loading skeleton, shaped like the DEFAULT tab (Overview):
 * PageHeader, the ?tab= nav row, then the enablement card + the usage card
 * (3 stat tiles) + the spend card (rows) at their paddings so the swap doesn't
 * shift.
 */
export default function TutorConsoleLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      {/* PageHeader */}
      <div>
        <Skeleton className="h-9 w-72 max-w-full sm:h-10" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      </div>

      {/* Tab nav (px-4 py-2.5 links on a border-b rail) */}
      <div className="flex flex-wrap gap-1 border-b border-stone-200/80">
        {["w-20", "w-40", "w-28", "w-20"].map((w, i) => (
          <div key={i} className="px-4 py-2.5">
            <Skeleton className={`h-5 rounded-md ${w}`} />
          </div>
        ))}
      </div>

      {/* Enablement card */}
      <div aria-hidden className={CARD}>
        <div className="flex items-center justify-between gap-4 border-b border-stone-200/70 px-5 py-4">
          <div>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-1.5 h-3 w-64 max-w-full" />
          </div>
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-5 w-12 rounded-full" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        </div>
        <div className="px-5 py-4">
          <Skeleton className="h-4 w-52" />
        </div>
      </div>

      {/* Usage card (3 stat tiles) */}
      <div aria-hidden className={CARD}>
        <div className="border-b border-stone-200/70 px-5 py-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-1.5 h-3 w-48" />
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-stone-200/70 bg-stone-50/40 p-4">
              <Skeleton className="size-9 rounded-xl" />
              <div>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-7 w-12" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Spend card (rows) */}
      <div aria-hidden className={CARD}>
        <div className="flex items-start justify-between gap-4 border-b border-stone-200/70 px-5 py-4">
          <div>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-1.5 h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-5 w-16" />
        </div>
        <div className="divide-y divide-stone-200/70">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-5 py-3">
              <div>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-1.5 h-3 w-40" />
              </div>
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
