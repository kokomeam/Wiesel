import { Search, Star, Users, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { marketplaceListings, marketplaceFilters } from "@/lib/data";

export default function MarketplacePage() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      <PageHeader
        title="Marketplace"
        description="Discover and sell specialized, high-stakes prep courses."
        actions={<Button>List a Course</Button>}
      />

      {/* Search + filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
          <input
            placeholder="Search by subject, level or competition (USACO, FBLA…)"
            className="h-10 w-full rounded-lg border border-stone-200 bg-white pl-9 pr-3 text-sm text-stone-700 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15"
          />
        </div>
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-thin">
          {marketplaceFilters.levels.map((lvl, i) => (
            <button
              key={lvl}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                i === 0
                  ? "border-brand-200 bg-brand-50 text-brand-700"
                  : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
              )}
            >
              {lvl}
            </button>
          ))}
          <button className="grid size-8 shrink-0 place-items-center rounded-full border border-stone-200 bg-white text-stone-500 hover:bg-stone-50">
            <SlidersHorizontal className="size-4" />
          </button>
        </div>
      </div>

      {/* Listings */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {marketplaceListings.map((c) => (
          <Card key={c.id} className="group overflow-hidden transition-all hover:shadow-md">
            <div
              className={`relative flex h-28 items-end bg-gradient-to-br ${c.accent} p-4`}
            >
              <span className="absolute right-3 top-3 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold text-white backdrop-blur">
                {c.level}
              </span>
              <h3 className="text-base font-semibold leading-tight text-white drop-shadow-sm">
                {c.title}
              </h3>
            </div>
            <div className="p-4">
              <p className="text-xs text-stone-500">by {c.creator}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.tags.map((t) => (
                  <Badge key={t} tone="slate">
                    {t}
                  </Badge>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-3 text-xs text-stone-500">
                <span className="inline-flex items-center gap-1 font-medium text-stone-700">
                  <Star className="size-3.5 fill-amber-400 text-amber-400" />
                  {c.rating}
                </span>
                <span className="text-stone-300">·</span>
                <span>{c.reviews} reviews</span>
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3.5" />
                  {c.students.toLocaleString()}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-4">
                <span className="text-lg font-bold text-stone-900">
                  {c.price === 0 ? "Free" : `$${c.price}`}
                </span>
                <Button variant="outline" size="sm">
                  View course
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
