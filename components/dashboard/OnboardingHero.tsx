import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
import { createNewCourse } from "@/app/(app)/studio/actions";
import { Button } from "@/components/ui/Button";

/**
 * Warm empty state for a creator with zero courses. The primary CTA is the
 * REAL createNewCourse server action (a form, not a link — Link prefetching
 * must never spawn phantom courses). (Profile nudging lives in the
 * CreatorIdentityHeader band above this, 2026-07-11.)
 */
export function OnboardingHero() {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-stone-200/80 bg-white px-6 py-16 text-center shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 left-1/2 h-64 w-[38rem] -translate-x-1/2 rounded-full bg-brand-100/50 blur-3xl"
      />
      <div className="relative">
        <p className="font-mono text-[11px] uppercase tracking-wider text-brand-600">
          Getting started
        </p>
        <h2 className="mt-3 text-3xl font-light text-stone-900 [font-family:var(--font-display)] sm:text-4xl">
          Create your first course
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-stone-500">
          Open the studio, tell the AI agent what you teach, and it drafts
          modules, slide decks, and quizzes you can shape from there — then
          publish and watch learners arrive.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <form action={createNewCourse}>
            <Button type="submit">
              <Plus className="size-4" aria-hidden />
              New Course
            </Button>
          </form>
          <Link
            href="/educators"
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            See how the studio works
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
