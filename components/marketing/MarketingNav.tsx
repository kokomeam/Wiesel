"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";
import { marketingNav } from "@/lib/marketing";

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav aria-label="Primary" className="sticky top-0 z-50 bg-[#FAF7F1]/85 backdrop-blur-md">
      <motion.div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-stone-900/10"
        initial={false}
        animate={{ opacity: scrolled ? 1 : 0 }}
        transition={{ duration: 0.3 }}
      />
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        {/* Brand */}
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-[17px] font-semibold tracking-tight text-stone-900">
            WiseSel<span className="text-orange-500">*</span>
          </span>
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-stone-400 sm:inline">
            for educators
          </span>
        </Link>

        {/* Center links */}
        <div className="hidden items-center gap-1 lg:flex">
          <Link
            href="/"
            className="group relative rounded-lg px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-stone-500 transition-colors hover:text-stone-900"
          >
            Overview
            <span className="absolute inset-x-3 -bottom-px h-px origin-center scale-x-0 bg-stone-900 transition-transform duration-300 group-hover:scale-x-100" />
          </Link>
          {marketingNav.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="group relative rounded-lg px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-stone-500 transition-colors hover:text-stone-900"
            >
              {link.label}
              <span className="absolute inset-x-3 -bottom-px h-px origin-center scale-x-0 bg-stone-900 transition-transform duration-300 group-hover:scale-x-100" />
            </Link>
          ))}
        </div>

        {/* Right actions */}
        <div className="hidden items-center gap-2 lg:flex">
          <Link
            href="/marketplace"
            className="rounded-lg px-3 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900"
          >
            Student login
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 px-4 text-sm font-semibold text-white shadow-sm shadow-orange-600/25 transition-all hover:-translate-y-px hover:shadow-md"
          >
            Creator login
          </Link>
        </div>

        {/* Mobile toggle */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="grid size-9 place-items-center rounded-lg text-stone-600 hover:bg-stone-100 lg:hidden"
          aria-label="Toggle menu"
          aria-expanded={open}
          aria-controls="mobile-menu"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {open && (
          <motion.div
            id="mobile-menu"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden border-t border-stone-200 bg-[#FAF7F1] lg:hidden"
          >
            <div className="space-y-1 px-6 py-4">
              {marketingNav.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100"
                >
                  {link.label}
                </Link>
              ))}
              <div className="flex gap-2 pt-2">
                <Link
                  href="/marketplace"
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-full border border-stone-200 py-2 text-center text-sm font-medium text-stone-700"
                >
                  Student login
                </Link>
                <Link
                  href="/dashboard"
                  onClick={() => setOpen(false)}
                  className="flex-1 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 py-2 text-center text-sm font-semibold text-white"
                >
                  Creator login
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
