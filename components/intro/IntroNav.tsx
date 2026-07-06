"use client";

/**
 * Minimal text nav for the introduction page. Typographic wordmark (the
 * orange asterisk is the brand mark — a footnote, not a sparkle).
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";

const links = [
  { label: "Product", href: "#product" },
  { label: "Learners", href: "#learners" },
  { label: "Educators", href: "/educators" },
  { label: "Marketplace", href: "/marketplace" },
];

/** The WiseSel wordmark with an optional mono tagline (used by the footer). */
export function Wordmark({ suffix }: { suffix?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <WiseSelLogo variant="wordmark" className="h-5 w-auto" />
      {suffix && (
        <span className="font-mono text-[10px] font-normal uppercase tracking-[0.2em] text-stone-400">
          {suffix}
        </span>
      )}
    </span>
  );
}

export function IntroNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
        scrolled
          ? "border-b border-stone-900/[0.06] bg-[#FAF7F1]/85 backdrop-blur-md"
          : "bg-transparent"
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" aria-label="WiseSel home">
          <WiseSelLogo variant="horizontal" priority className="h-8" />
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-500 transition-colors hover:text-stone-900"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="hidden rounded-full px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:text-stone-900 md:block"
          >
            Sign in
          </Link>
          <Link
            href="/marketplace"
            className="rounded-full bg-gradient-to-r from-amber-500 to-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-orange-600/25 transition-transform hover:-translate-y-px"
          >
            Get started
          </Link>
        </div>
      </div>
    </nav>
  );
}
