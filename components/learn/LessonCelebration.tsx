"use client";

/**
 * The lesson-complete celebration: rendered ONLY when completion flips
 * false→true during the session (LearnLessonView owns that transition —
 * lessons already complete on load keep the quiet emerald strip). An emerald
 * pop with a handful of deterministic confetti dots (transform/opacity only,
 * fixed positions — no Math.random in render) and the natural next action.
 *
 * Loaded via next/dynamic from LearnLessonView so framer-motion stays out of
 * the critical lesson bundle.
 */

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/ease";

/** Deterministic confetti burst — fixed origins/offsets, never random. */
const CONFETTI: {
  left: string;
  top: string;
  dx: number;
  dy: number;
  delay: number;
  className: string;
}[] = [
  { left: "14%", top: "30%", dx: -26, dy: -38, delay: 0.05, className: "bg-emerald-400" },
  { left: "26%", top: "16%", dx: -14, dy: -46, delay: 0.14, className: "bg-amber-400" },
  { left: "42%", top: "10%", dx: -4, dy: -40, delay: 0.02, className: "bg-learn-400" },
  { left: "58%", top: "10%", dx: 8, dy: -44, delay: 0.1, className: "bg-emerald-500" },
  { left: "74%", top: "16%", dx: 20, dy: -40, delay: 0.18, className: "bg-amber-500" },
  { left: "86%", top: "30%", dx: 30, dy: -30, delay: 0.08, className: "bg-learn-300" },
  { left: "8%", top: "52%", dx: -32, dy: -12, delay: 0.22, className: "bg-emerald-300" },
  { left: "92%", top: "52%", dx: 32, dy: -12, delay: 0.26, className: "bg-emerald-400" },
];

export function LessonCelebration({
  nextLesson,
  courseHref,
}: {
  /** Null on the last lesson — the CTA falls back to the course overview. */
  nextLesson: { title: string; href: string } | null;
  courseHref: string;
}) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.95, y: 10 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EASE }}
      role="status"
      className="relative overflow-hidden rounded-2xl border border-emerald-200/70 bg-emerald-50/80 px-6 py-8 text-center"
      data-ai-id="lesson-celebration"
    >
      {!reduce
        ? CONFETTI.map((dot, i) => (
            <motion.span
              key={i}
              aria-hidden
              className={cn("absolute size-1.5 rounded-full", dot.className)}
              style={{ left: dot.left, top: dot.top }}
              initial={{ opacity: 0, x: 0, y: 0, scale: 0.4 }}
              animate={{ opacity: [0, 1, 0], x: dot.dx, y: dot.dy, scale: [0.4, 1, 0.7] }}
              transition={{ duration: 1.1, delay: dot.delay, ease: "easeOut" }}
            />
          ))
        : null}

      <motion.span
        initial={reduce ? false : { scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.08, ease: EASE }}
        className="mx-auto grid size-12 place-items-center rounded-full bg-emerald-500 text-white shadow-sm shadow-emerald-600/25"
      >
        <CheckCircle2 className="size-6" aria-hidden />
      </motion.span>

      <h2 className="mt-4 text-2xl [font-family:var(--font-display)] font-light text-emerald-900">
        Lesson complete
      </h2>
      <p className="mt-1 text-sm text-emerald-700/90">
        Nice work — that one&apos;s in the books.
      </p>

      <div className="mt-5 flex justify-center">
        {nextLesson ? (
          <Link
            href={nextLesson.href}
            className="inline-flex max-w-full items-center gap-2 rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-emerald-600/25 transition-colors hover:bg-emerald-700"
          >
            <span className="shrink-0">Next up:</span>
            <span className="min-w-0 truncate">{nextLesson.title}</span>
            <ArrowRight className="size-4 shrink-0" aria-hidden />
          </Link>
        ) : (
          <Link
            href={courseHref}
            className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-emerald-600/25 transition-colors hover:bg-emerald-700"
          >
            Back to course
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
    </motion.div>
  );
}
