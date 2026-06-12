"use client";

/**
 * Feature bento — every cell is a real product idea drawn with UI primitives.
 * Calm hover micro-motion only; nothing loops off-screen.
 */

import { Reveal, Stagger, StaggerItem } from "@/components/marketing/motion";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/ease";

function Cell({
  eyebrow,
  title,
  body,
  className,
  children,
}: {
  eyebrow: string;
  title: string;
  body: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <StaggerItem
      className={cn(
        "group flex flex-col justify-between gap-6 rounded-[1.75rem] bg-white p-7 ring-1 ring-stone-200 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_18px_44px_rgba(28,25,23,0.08)]",
        className
      )}
    >
      <div>
        <p className="font-mono text-[9px] uppercase tracking-[0.26em] text-stone-400">
          {eyebrow}
        </p>
        <h3 className="mt-2.5 text-[19px] font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
          {title}
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-stone-500">{body}</p>
      </div>
      {children}
    </StaggerItem>
  );
}

/* Mini visuals ------------------------------------------------------------ */

function CanvasMini() {
  return (
    <div
      role="img"
      aria-label="A slide with freely positioned elements"
      className="relative h-36 overflow-hidden rounded-xl bg-stone-100/80"
    >
      <div className="absolute left-5 top-5 h-2.5 w-32 rounded-sm bg-stone-800 transition-transform duration-500 group-hover:-translate-y-0.5" />
      <div className="absolute left-5 top-12 space-y-1.5">
        <div className="h-1.5 w-24 rounded-full bg-stone-300" />
        <div className="h-1.5 w-20 rounded-full bg-stone-300" />
        <div className="h-1.5 w-16 rounded-full bg-stone-300" />
      </div>
      <div className="absolute right-5 top-9 h-16 w-24 rounded-lg bg-amber-100 ring-1 ring-amber-200 transition-transform duration-500 group-hover:translate-x-1 group-hover:-translate-y-1" />
      <div className="absolute bottom-4 left-5 rounded-md bg-amber-200/80 px-2 py-1 font-mono text-[8px] text-stone-700 transition-transform duration-500 group-hover:translate-y-[-2px]">
        key takeaway
      </div>
      {/* selection handles */}
      <div className="absolute right-3 top-7 size-1.5 rounded-full bg-white ring-1 ring-stone-400" />
      <div className="absolute right-[6.5rem] top-[6.1rem] size-1.5 rounded-full bg-white ring-1 ring-stone-400" />
    </div>
  );
}

function FeedbackMini() {
  const reduce = useReducedMotion();
  return (
    <div className="space-y-2" role="img" aria-label="Quality feedback resolving itself">
      <motion.div
        initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
        className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-amber-200/70"
      >
        <span className="size-1.5 rounded-full bg-amber-400" />
        <span className="text-[11px] text-amber-800">9 bullets is a lot for one slide</span>
      </motion.div>
      <motion.div
        initial={{ opacity: reduce ? 1 : 0, y: reduce ? 0 : 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.7, ease: EASE }}
        className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 ring-1 ring-emerald-300/70"
      >
        <span className="size-1.5 rounded-full bg-emerald-500" />
        <span className="text-[11px] text-stone-700">
          Fixed — 4 bullets, rest moved to speaker notes
        </span>
      </motion.div>
    </div>
  );
}

function PracticeMini() {
  const reduce = useReducedMotion();
  return (
    <div
      role="img"
      aria-label="A quiz answer marked correct"
      className="rounded-xl bg-stone-100/80 p-4"
    >
      <div className="h-1.5 w-3/4 rounded-full bg-stone-300" />
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-emerald-400">
        <svg viewBox="0 0 14 14" className="size-3.5" fill="none" aria-hidden>
          <motion.path
            d="M2.5 7.5 L5.5 10.5 L11.5 3.5"
            stroke="#059669"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: reduce ? 1 : 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true }}
            transition={{ duration: reduce ? 0 : 0.5, delay: 0.4, ease: EASE }}
          />
        </svg>
        <span className="text-[11px] font-medium text-stone-700">Two pointers</span>
        <span className="ml-auto font-mono text-[9px] text-stone-400">
          because it&rsquo;s sorted
        </span>
      </div>
    </div>
  );
}

function SubjectsMini() {
  return (
    <div className="flex flex-wrap gap-1.5" aria-hidden>
      {["algorithms", "watercolor", "AP bio", "korean", "finance", "jazz piano"].map((t) => (
        <span
          key={t}
          className="rounded-full bg-stone-100 px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider text-stone-500 transition-colors group-hover:bg-amber-100 group-hover:text-stone-700"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

function ShipMini() {
  const reduce = useReducedMotion();
  const steps = ["Draft", "Polish", "Publish", "Earn"];
  return (
    <div role="img" aria-label="Draft to published timeline" className="pt-1">
      <div className="relative flex items-center justify-between">
        <div className="absolute inset-x-2 top-[7px] h-px bg-stone-200" />
        <motion.div
          className="absolute left-2 top-[7px] h-px origin-left bg-orange-500"
          style={{ right: 8 }}
          initial={{ scaleX: reduce ? 1 : 0 }}
          whileInView={{ scaleX: 1 }}
          viewport={{ once: true }}
          transition={{ duration: reduce ? 0 : 1, delay: 0.3, ease: EASE }}
        />
        {steps.map((label, i) => (
          <div key={label} className="relative flex flex-col items-center gap-2">
            <span
              className={cn(
                "size-3.5 rounded-full ring-2 ring-white",
                i < 3 ? "bg-orange-500" : "bg-stone-300"
              )}
            />
            <span className="font-mono text-[9px] uppercase tracking-wider text-stone-500">
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* Section ------------------------------------------------------------------ */

export function IntroBento() {
  return (
    <section id="product" className="bg-stone-100 pb-24 sm:pb-32">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-stone-500">
            Under the hood
          </p>
          <h2 className="mt-4 max-w-2xl text-4xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-5xl">
            Built like a product, not a PDF.
          </h2>
        </Reveal>

        <Stagger className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" stagger={0.08}>
          <Cell
            eyebrow="The canvas"
            title="Slides that feel designed"
            body="Free placement, real layouts, themes that stay out of your way — a proper canvas, not a bullet form."
            className="lg:col-span-2"
          >
            <CanvasMini />
          </Cell>
          <Cell
            eyebrow="The co-author"
            title="Feedback while you write"
            body="Crowded slides, missing alt text, low contrast — caught and fixed in one click, before students ever see them."
          >
            <FeedbackMini />
          </Cell>
          <Cell
            eyebrow="Practice"
            title="Checkpoints that explain"
            body="Every quiz answer carries its why, so learners keep momentum instead of collecting red marks."
          >
            <PracticeMini />
          </Cell>
          <Cell
            eyebrow="Any subject"
            title="From USACO to watercolor"
            body="The structure is universal: slides, examples, practice. The expertise is yours."
          >
            <SubjectsMini />
          </Cell>
          <Cell
            eyebrow="The arc"
            title="Draft today, earn this month"
            body="Courses ship to a marketplace where learners pay for the ones worth finishing."
          >
            <ShipMini />
          </Cell>
        </Stagger>
      </div>
    </section>
  );
}
