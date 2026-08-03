"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Reveal, Stagger, StaggerItem } from "./motion";
import { steps } from "@/lib/marketing";
import { EASE } from "@/lib/ease";

export function HowItWorks() {
  const reduce = useReducedMotion();
  return (
    <section className="border-y border-stone-200/60 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-orange-600">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-4xl">
            From idea to published course in three steps
          </h2>
        </Reveal>

        <div className="relative mt-16">
          {/* connective hairline (desktop) */}
          <motion.div
            className="absolute left-0 right-0 top-6 hidden h-px origin-left bg-gradient-to-r from-orange-200 via-stone-200 to-stone-200 md:block"
            initial={{ scaleX: reduce ? 1 : 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.9, ease: EASE }}
          />

          <Stagger className="grid gap-10 md:grid-cols-3" stagger={0.12}>
            {steps.map((step) => (
              <StaggerItem key={step.n}>
                <div className="relative">
                  <div className="flex items-center gap-3">
                    <span className="relative z-10 grid size-12 place-items-center rounded-full bg-gradient-to-br from-amber-500 to-orange-600 text-base font-bold text-white shadow-sm shadow-orange-600/25 ring-4 ring-white">
                      {step.n}
                    </span>
                    <span className="grid size-9 place-items-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
                      <step.icon className="size-4" aria-hidden />
                    </span>
                  </div>
                  <h3 className="mt-5 text-lg font-semibold text-stone-900">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-stone-500">
                    {step.body}
                  </p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  );
}
