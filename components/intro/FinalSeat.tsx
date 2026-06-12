"use client";

/**
 * The close: one big sunset-gradient panel, one line, two doors, and a
 * footnote pointing educators to their dedicated tour (the original landing
 * page, preserved at /educators).
 */

import Link from "next/link";
import { Reveal } from "@/components/marketing/motion";
import { UnderlineScribble } from "./Annotate";
import { RippleArcs } from "./backgrounds";

export function FinalSeat() {
  return (
    <section className="bg-[#FAF7F1] px-4 py-20 sm:px-6 sm:py-28">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2.5rem] bg-gradient-to-br from-amber-500 via-orange-500 to-orange-600 px-6 py-24 shadow-[0_40px_90px_-30px_rgba(194,65,12,0.55)] sm:py-28">
        {/* concentric ripples rising from the bottom edge */}
        <div className="pointer-events-none absolute inset-0">
          <RippleArcs />
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-1/2 size-[34rem] -translate-x-1/2 rounded-full bg-amber-200/30 blur-3xl"
        />

        <div className="relative mx-auto max-w-3xl text-center">
          <Reveal>
            <h2 className="text-5xl font-light leading-[1.05] tracking-tight text-white [font-family:var(--font-display)] sm:text-6xl">
              Take a seat —{" "}
              <span className="relative inline-block whitespace-nowrap">
                either side
                <UnderlineScribble
                  className="absolute -bottom-2 left-0 h-3.5 w-full"
                  color="#ffffff"
                  delay={0.5}
                />
              </span>
              <br />
              of the desk.
            </h2>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mx-auto mt-6 max-w-md text-[15px] leading-relaxed text-orange-50/95">
              Learn something worth your evenings, or teach something worth
              paying for. The studio is open.
            </p>
          </Reveal>
          <Reveal delay={0.22}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/marketplace"
                className="group inline-flex h-12 items-center gap-2 rounded-full bg-white px-7 text-[15px] font-semibold text-orange-700 shadow-lg shadow-orange-900/20 transition-transform hover:-translate-y-0.5"
              >
                Start learning free
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
              <Link
                href="/dashboard"
                className="inline-flex h-12 items-center rounded-full px-6 text-[14.5px] font-medium text-white ring-1 ring-white/50 transition-colors hover:bg-white/10"
              >
                Build your first course
              </Link>
            </div>
            <p className="mt-8 font-mono text-[10.5px] uppercase tracking-[0.18em] text-orange-100/90">
              <span className="text-white">*</span> educators — your full tour lives{" "}
              <Link
                href="/educators"
                className="text-white underline decoration-orange-200 underline-offset-4 transition-colors hover:decoration-white"
              >
                over here
              </Link>
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
