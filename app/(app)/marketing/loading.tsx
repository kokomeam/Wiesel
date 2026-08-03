import { Skeleton } from "@/components/ui/Skeleton";

const CARD = "rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]";

/**
 * Marketing hub loading skeleton — mirrors MarketingHub's real geometry:
 * max-w-7xl container, PageHeader with action pills, the full-width ask-bar
 * card (icon + input + button + suggestion chips), then the
 * 1fr/320px two-column grid (work column: campaign + landing-pages cards;
 * quiet rail: Explore nav + a collapsed disclosure bar).
 */
export default function MarketingLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      {/* PageHeader + actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Skeleton className="h-9 w-72 max-w-full sm:h-10" />
          <Skeleton className="mt-2 h-4 w-[26rem] max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-28 rounded-full" />
          <Skeleton className="h-9 w-32 rounded-full" />
        </div>
      </div>

      {/* Ask-bar card (agent, front and center) */}
      <div aria-hidden className={`${CARD} p-4`}>
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 shrink-0 rounded-xl" />
          <Skeleton className="h-10 min-w-0 flex-1 rounded-xl" />
          <Skeleton className="h-9 w-20 rounded-full" />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5 sm:pl-12">
          <Skeleton className="h-6 w-64 max-w-full rounded-full" />
          <Skeleton className="h-6 w-40 rounded-full" />
          <Skeleton className="h-6 w-56 max-w-full rounded-full" />
        </div>
      </div>

      {/* Work column + quiet rail */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {/* CampaignCard */}
          <div aria-hidden className={`${CARD} p-5`}>
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-9 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48 max-w-full" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
              <Skeleton className="h-4 w-14 shrink-0" />
            </div>
          </div>

          {/* Landing pages card */}
          <div aria-hidden className={`${CARD}`}>
            <div className="flex items-start justify-between gap-4 border-b border-stone-200/70 px-5 py-4">
              <div>
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1.5 h-3 w-16" />
              </div>
              <Skeleton className="h-8 w-24 rounded-full" />
            </div>
            <div className="p-4">
              <div className="divide-y divide-stone-100">
                {Array.from({ length: 2 }, (_, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-24 rounded-md" />
                    <span className="flex-1" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-4 w-16" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Quiet rail */}
        <div className="min-w-0 space-y-4">
          {/* Explore nav card */}
          <div aria-hidden className={`${CARD}`}>
            <div className="border-b border-stone-200/70 px-5 py-3">
              <Skeleton className="h-4 w-16" />
            </div>
            <div className="p-2">
              {Array.from({ length: 7 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2">
                  <Skeleton className="size-8 shrink-0 rounded-lg" />
                  {/* min-h-9 = the real text-sm + text-xs stack (36px) */}
                  <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center gap-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-36 max-w-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Collapsed "Agent autonomy" disclosure bar */}
          <div aria-hidden className={`${CARD} flex items-center gap-2 px-4 py-3`}>
            <Skeleton className="size-4 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
