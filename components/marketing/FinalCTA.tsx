"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useInView } from "framer-motion";
import { Rocket, Compass } from "lucide-react";
import { Reveal } from "./motion";
import { CtaPrimary, CtaSecondary } from "./Cta";

export function FinalCTA() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { margin: "0px" });
  const loop = inView && !reduce;
  return (
    <section ref={ref} className="relative overflow-hidden">
      {/* mirrored aurora */}
      <div className="pointer-events-none absolute inset-0 -z-0 overflow-hidden" aria-hidden>
        <motion.div
          className="absolute -bottom-40 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-orange-500/10 blur-[120px]"
          animate={loop ? { scale: [1, 1.05, 1], opacity: [0.08, 0.12, 0.08] } : undefined}
          transition={loop ? { duration: 18, repeat: Infinity, ease: "easeInOut" } : undefined}
        />
      </div>

      <div className="relative mx-auto max-w-3xl px-6 py-28 text-center">
        <Reveal>
          <h2 className="text-4xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-5xl">
            Your next course is one{" "}
            <span className="bg-gradient-to-br from-amber-500 to-orange-600 bg-clip-text text-transparent">prompt</span>{" "}
            away.
          </h2>
          <p className="mt-4 text-lg text-stone-500">
            Join thousands of educators and learners building the future of teaching.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <CtaPrimary href="/dashboard">
              <Rocket className="size-4" aria-hidden />
              Start creating
            </CtaPrimary>
            <CtaSecondary href="/marketplace">
              <Compass className="size-4" aria-hidden />
              Explore courses
            </CtaSecondary>
          </div>
          <p className="mt-5 text-xs text-stone-400">
            No credit card to start · Free Hobbyist plan available
          </p>
        </Reveal>
      </div>
    </section>
  );
}
