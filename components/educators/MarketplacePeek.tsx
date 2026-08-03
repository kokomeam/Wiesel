import Link from "next/link";
import { Star, ArrowRight } from "lucide-react";
import { Reveal, Stagger, StaggerItem } from "./motion";
import { marketplaceListings } from "@/lib/data";

const picks = marketplaceListings.slice(0, 4);

export function MarketplacePeek() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <Reveal className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div className="max-w-xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-orange-600">
            Marketplace
          </p>
          <h2 className="mt-3 text-3xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-4xl">
            Discover courses worth finishing
          </h2>
          <p className="mt-3 text-base text-stone-500">
            Niche, high-stakes prep from expert creators — searchable by subject,
            level and competition.
          </p>
        </div>
        <Link
          href="/marketplace"
          className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-orange-600 hover:text-orange-700"
        >
          Explore the marketplace
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </Link>
      </Reveal>

      <Stagger
        className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4"
        stagger={0.08}
      >
        {picks.map((c) => (
          <StaggerItem key={c.id}>
            <div className="group h-full overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all hover:-translate-y-1 hover:shadow-md">
              <div
                className={`relative flex h-24 items-end bg-gradient-to-br ${c.accent} p-3.5`}
              >
                <span className="absolute right-3 top-3 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                  {c.level}
                </span>
                <h3 className="text-sm font-semibold leading-tight text-white drop-shadow-sm">
                  {c.title}
                </h3>
              </div>
              <div className="p-4">
                <p className="text-xs text-stone-500">by {c.creator}</p>
                <div className="mt-3 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-stone-600">
                    <Star className="size-3.5 fill-amber-400 text-amber-400" aria-hidden />
                    {c.rating}
                    <span className="text-stone-300">·</span>
                    <span className="text-stone-400">
                      {(c.students / 1000).toFixed(1)}k
                    </span>
                  </span>
                  <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold text-stone-900">
                    {c.price === 0 ? "Free" : `$${c.price}`}
                  </span>
                </div>
              </div>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
