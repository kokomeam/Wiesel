import Link from "next/link";
import { footerColumns } from "@/lib/marketing";

/** Best-effort routing for footer links; placeholders fall back to "#". */
const hrefFor: Record<string, string> = {
  Marketplace: "/marketplace",
  Pricing: "/settings",
  Exports: "/exports",
  "Creator Studio": "/studio",
  Analytics: "/analytics",
  Marketing: "/marketing",
  "Browse courses": "/marketplace",
  "My learning": "/marketplace",
};

export function MarketingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-stone-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-6">
          <div className="col-span-2">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="text-[17px] font-semibold tracking-tight text-stone-900">
                CourseGen<span className="text-orange-500">*</span>
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-400">
                for educators
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-stone-500">
              The all-in-one AI platform to build, market, and monetize courses —
              and a beautiful place for learners to grow.
            </p>
          </div>

          {footerColumns.map((col) => (
            <div key={col.title}>
              <h3 className="text-sm font-semibold text-stone-900">{col.title}</h3>
              <ul className="mt-3 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link}>
                    <Link
                      href={hrefFor[link] ?? "#"}
                      className="rounded text-sm text-stone-500 transition-colors hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40"
                    >
                      {link}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-stone-100 pt-8 sm:flex-row">
          <p className="text-xs text-stone-400">
            © {year} CourseGen Pro. All rights reserved.
          </p>
          <div className="flex items-center gap-6 text-xs">
            {["Privacy", "Terms", "Status"].map((item) => (
              <Link
                key={item}
                href="#"
                className="rounded text-stone-400 transition-colors hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40"
              >
                {item}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
