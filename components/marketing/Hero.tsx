"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useInView } from "framer-motion";
import { Rocket, Compass, Users, FileDown, Store } from "lucide-react";
import { HeroPreview } from "./HeroPreview";
import { CtaPrimary, CtaSecondary } from "./Cta";
import { RotatingText } from "@/components/ui/RotatingText";
import { BackgroundPaths } from "@/components/ui/background-paths";
import { EASE } from "@/lib/ease";

// Fades the flowing paths out toward the bottom of the hero so the sections
// below stay clean.
const pathsMask =
  "linear-gradient(to bottom, black 0%, black 58%, transparent 94%)";

const audiences = ["educators", "coaches", "creators", "experts", "trainers"];

const trustline = [
  { icon: Users, label: "Built for educators" },
  { icon: FileDown, label: "PPTX & PDF exports" },
  { icon: Store, label: "Marketplace-ready" },
];

export function Hero() {
  const reduce = useReducedMotion();

  const container = {
    hidden: {},
    show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
  };
  const item = {
    hidden: { opacity: reduce ? 1 : 0, y: reduce ? 0 : 14 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: reduce ? 0 : 0.55, ease: EASE },
    },
  };

  return (
    <section className="relative">
      {/* Flowing animated paths (warm ink lines, faded) */}
      <BackgroundPaths
        className="-z-0 opacity-90"
        style={{ maskImage: pathsMask, WebkitMaskImage: pathsMask }}
      />
      {/* Aurora — warm light, never a fill */}
      <AuroraBlob />

      <div className="relative z-10 mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-20 sm:py-24 lg:grid-cols-12 lg:gap-8 lg:py-28">
        {/* Text column */}
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="max-w-xl lg:col-span-6"
        >
          <motion.div variants={item}>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-orange-700 ring-1 ring-inset ring-orange-100">
              <span aria-hidden className="text-sm leading-none text-orange-500">*</span>
              The educator deep-dive
            </span>
          </motion.div>

          <motion.h1
            variants={item}
            className="mt-5 text-[clamp(2.6rem,6vw,4.25rem)] font-light leading-[1.05] tracking-tight text-stone-900 [font-family:var(--font-display)]"
          >
            <span className="block">Built for</span>
            <RotatingText
              words={audiences}
              className="bg-gradient-to-r from-amber-500 to-orange-600 bg-clip-text pr-[0.12em] text-transparent"
            />
          </motion.h1>

          <motion.p
            variants={item}
            className="mt-5 max-w-md text-lg leading-relaxed text-stone-500"
          >
            WiseSel turns your expertise into polished, monetizable courses —
            and gives learners a beautiful place to study them.
          </motion.p>

          <motion.div variants={item} className="mt-8 flex flex-wrap items-center gap-3">
            <CtaPrimary href="/dashboard">
              <Rocket className="size-4" aria-hidden />
              Start creating
            </CtaPrimary>
            <CtaSecondary href="/marketplace">
              <Compass className="size-4" aria-hidden />
              Explore courses
            </CtaSecondary>
          </motion.div>

          <motion.div
            variants={item}
            className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500"
          >
            {trustline.map((t, i) => (
              <span key={t.label} className="inline-flex items-center gap-2">
                {i > 0 && <span className="text-stone-300">·</span>}
                <span className="inline-flex items-center gap-1.5">
                  <t.icon className="size-3.5" aria-hidden />
                  {t.label}
                </span>
              </span>
            ))}
          </motion.div>
        </motion.div>

        {/* Product cluster */}
        <div className="lg:col-span-6">
          <HeroPreview />
        </div>
      </div>
    </section>
  );
}

function AuroraBlob() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "0px" });
  const loop = inView && !reduce;
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-0 -z-0 overflow-hidden"
      aria-hidden
    >
      <motion.div
        className="absolute -right-32 -top-40 size-[42rem] rounded-full bg-orange-500/12 blur-[120px]"
        animate={loop ? { scale: [1, 1.05, 1], opacity: [0.1, 0.14, 0.1] } : undefined}
        transition={loop ? { duration: 18, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
      <div className="absolute -left-40 top-1/3 size-[34rem] rounded-full bg-orange-400/8 blur-[120px]" />
    </div>
  );
}
