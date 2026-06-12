"use client";

/**
 * The opening statement: warm paper, flowing ink lines, a cursor-following
 * glow, an editorial serif headline with a hand-circled phrase, and an
 * audience toggle that flips the live demo and the primary CTA.
 */

import Link from "next/link";
import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/ease";
import { CircleScribble } from "./Annotate";
import { HeroDemo, type Audience } from "./HeroDemo";
import { WarmBackdrop } from "./WarmBackdrop";

const entrance = (reduce: boolean, delay: number) => ({
  initial: { opacity: reduce ? 1 : 0, y: reduce ? 0 : 22 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: reduce ? 0 : 0.7, delay, ease: EASE },
});

export function IntroHero() {
  const reduce = useReducedMotion();
  const [audience, setAudience] = useState<Audience>("learning");

  return (
    <header className="relative isolate overflow-hidden bg-[#FAF7F1] pb-20 pt-32 sm:pb-24 sm:pt-40">
      <WarmBackdrop />

      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
        {/* ── Copy ── */}
        <div>
          <motion.p
            {...entrance(!!reduce, 0)}
            className="font-mono text-[11px] uppercase tracking-[0.28em] text-orange-600"
          >
            CourseGen* — the course studio
          </motion.p>

          <motion.h1
            {...entrance(!!reduce, 0.08)}
            className="mt-5 text-[2.7rem] font-light leading-[1.04] tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-6xl"
          >
            Every great course
            <br />
            has{" "}
            <span className="relative inline-block whitespace-nowrap px-2">
              <CircleScribble
                className="absolute -inset-x-1 -inset-y-2 h-[calc(100%+1rem)] w-[calc(100%+0.5rem)]"
                color="#f97316"
                delay={0.9}
              />
              <em className="not-italic">two sides</em>
            </span>
            .
          </motion.h1>

          <motion.p
            {...entrance(!!reduce, 0.18)}
            className="mt-6 max-w-md text-[15px] leading-relaxed text-stone-500"
          >
            One side teaches, the other learns. CourseGen is the first studio
            built for both — where educators craft courses like products, and
            learners actually finish them.
          </motion.p>

          {/* Audience toggle */}
          <motion.div {...entrance(!!reduce, 0.28)} className="mt-8">
            <div
              role="group"
              aria-label="Choose your perspective"
              className="inline-flex rounded-full bg-stone-900/[0.05] p-1 ring-1 ring-stone-900/10"
            >
              {(
                [
                  ["learning", "I'm here to learn"],
                  ["teaching", "I'm here to teach"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={audience === value}
                  onClick={() => setAudience(value)}
                  className={cn(
                    "relative rounded-full px-4 py-2 text-[13px] font-medium transition-colors",
                    audience === value
                      ? "text-[#FAF7F1]"
                      : "text-stone-500 hover:text-stone-800"
                  )}
                >
                  {audience === value && (
                    <motion.span
                      layoutId="audience-pill"
                      className="absolute inset-0 rounded-full bg-stone-900"
                      transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
                    />
                  )}
                  <span className="relative">{label}</span>
                </button>
              ))}
            </div>
          </motion.div>

          {/* CTAs */}
          <motion.div
            {...entrance(!!reduce, 0.36)}
            className="mt-6 flex flex-wrap items-center gap-3"
          >
            <Link
              href={audience === "teaching" ? "/dashboard" : "/marketplace"}
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-orange-600 px-6 text-[15px] font-semibold text-white shadow-md shadow-orange-600/25 transition-transform hover:-translate-y-0.5"
            >
              {audience === "teaching" ? "Open the studio" : "Start learning free"}
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </Link>
            <Link
              href="/educators"
              className="inline-flex h-12 items-center gap-2 rounded-full bg-white/60 px-5 text-[14px] font-medium text-stone-700 ring-1 ring-stone-300 backdrop-blur transition-colors hover:bg-white hover:text-stone-900"
            >
              Educators: take the full tour
            </Link>
          </motion.div>

          <motion.p
            {...entrance(!!reduce, 0.44)}
            className="mt-5 font-mono text-[10px] uppercase tracking-[0.2em] text-stone-400"
          >
            *no credit card · no slideware · no 40-minute setup
          </motion.p>
        </div>

        {/* ── Demo ── */}
        <motion.div
          initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.8, delay: 0.25, ease: EASE }}
        >
          <HeroDemo audience={audience} />
        </motion.div>
      </div>
    </header>
  );
}
