/**
 * Learner shell — deliberately minimal and PUBLIC (course landings must be
 * shareable). No studio chrome, no editing affordances: a thin top bar with
 * the wordmark, plus "My courses"/"Sign in" depending on session.
 */

import Link from "next/link";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";
import { getSessionUser } from "@/lib/supabase/server";

export default async function LearnLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  return (
    <div className="min-h-screen bg-[#faf7f1] text-stone-900">
      <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-[#faf7f1]/90 backdrop-blur">
        {/* max-w-6xl matches the landing + lesson columns (2026-07-11 redesign). */}
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" aria-label="WiseSel home" className="inline-flex items-center">
            <WiseSelLogo variant="horizontal" className="h-7" />
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            {user ? (
              // Signed-in learners route to the student portal (was /marketplace
              // before the 2026-07-08 portal split).
              <>
                <Link
                  href="/explore"
                  className="rounded-full px-3.5 py-1.5 font-medium text-stone-600 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-900"
                >
                  Explore
                </Link>
                <Link
                  href="/home"
                  className="rounded-full px-3.5 py-1.5 font-medium text-stone-600 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-900"
                >
                  My courses
                </Link>
              </>
            ) : (
              <Link
                href="/login"
                className="brand-gradient rounded-full px-4 py-1.5 font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
