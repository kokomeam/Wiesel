import Link from "next/link";
import { Check, Wand2, GraduationCap, ArrowRight } from "lucide-react";
import { Reveal } from "./motion";
import { creatorPath, studentPath } from "@/lib/marketing";

export function DualPath() {
  return (
    <section className="mx-auto max-w-6xl scroll-mt-20 px-6 py-24" id="creators">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-orange-600">
          Two doors, one platform
        </p>
        <h2 className="mt-3 text-3xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-4xl">
          Choose your path
        </h2>
        <p className="mt-3 text-base text-stone-500">
          Whether you build courses or take them, CourseGen Pro is made for you.
        </p>
      </Reveal>

      <div className="relative mt-12 grid gap-6 md:grid-cols-2 md:gap-8">
        {/* Creator */}
        <Reveal>
          <div className="group h-full overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-md">
            <div className="bg-gradient-to-b from-orange-50 to-transparent p-7">
              <div className="flex items-center justify-between">
                <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-sm shadow-orange-600/25">
                  <Wand2 className="size-5" aria-hidden />
                </span>
                <span className="rounded-full bg-orange-50 px-2.5 py-0.5 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-100">
                  {creatorPath.eyebrow}
                </span>
              </div>
              <h3 className="mt-5 text-xl font-semibold text-stone-900">
                {creatorPath.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-stone-500">
                {creatorPath.body}
              </p>
            </div>
            <div className="px-7 pb-7">
              <ul className="space-y-2.5">
                {creatorPath.bullets.map((b) => (
                  <li key={b} className="flex items-center gap-2.5 text-sm text-stone-700">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-orange-100 text-orange-700">
                      <Check className="size-3" aria-hidden />
                    </span>
                    {b}
                  </li>
                ))}
              </ul>
              <Link
                href={creatorPath.href}
                className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 text-sm font-semibold text-white shadow-sm shadow-orange-600/25 transition-all hover:-translate-y-px hover:shadow-md"
              >
                {creatorPath.cta}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </div>
          </div>
        </Reveal>

        {/* Student */}
        <Reveal delay={0.08} className="h-full">
          <div
            id="students"
            className="group h-full scroll-mt-24 overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="bg-gradient-to-b from-teal-50 to-transparent p-7">
              <div className="flex items-center justify-between">
                <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-sm shadow-teal-600/25">
                  <GraduationCap className="size-5" aria-hidden />
                </span>
                <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700 ring-1 ring-inset ring-teal-100">
                  {studentPath.eyebrow}
                </span>
              </div>
              <h3 className="mt-5 text-xl font-semibold text-stone-900">
                {studentPath.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-stone-500">
                {studentPath.body}
              </p>
            </div>
            <div className="px-7 pb-7">
              <ul className="space-y-2.5">
                {studentPath.bullets.map((b) => (
                  <li key={b} className="flex items-center gap-2.5 text-sm text-stone-700">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-teal-100 text-teal-700">
                      <Check className="size-3" aria-hidden />
                    </span>
                    {b}
                  </li>
                ))}
              </ul>
              <Link
                href={studentPath.href}
                className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-stone-200 bg-white text-sm font-semibold text-stone-800 transition-all hover:-translate-y-px hover:border-stone-300 hover:shadow-md"
              >
                {studentPath.cta}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </div>
          </div>
        </Reveal>

        {/* center "or" divider (desktop) */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 md:block">
          <span className="grid size-10 place-items-center rounded-full border border-stone-200 bg-white text-xs font-medium text-stone-400 shadow-sm">
            or
          </span>
        </div>
      </div>
    </section>
  );
}
