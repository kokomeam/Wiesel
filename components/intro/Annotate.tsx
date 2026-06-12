"use client";

/**
 * Hand-drawn annotation strokes — the page's signature motif. A circled word,
 * an underline swoosh: marginalia, not machinery. SVG paths draw themselves
 * in once when scrolled into view (or instantly under reduced motion).
 */

import { motion, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/ease";

export function CircleScribble({
  className,
  color = "#bef264",
  delay = 0,
}: {
  className?: string;
  color?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <svg
      viewBox="0 0 260 90"
      fill="none"
      aria-hidden
      className={className}
      preserveAspectRatio="none"
    >
      <motion.path
        d="M28 52 C 16 24, 96 8, 158 10 C 224 12, 252 28, 248 47 C 244 70, 170 84, 96 81 C 40 78, 14 66, 22 48"
        stroke={color}
        strokeWidth={4.5}
        strokeLinecap="round"
        initial={{ pathLength: reduce ? 1 : 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: reduce ? 0 : 0.9, delay, ease: EASE }}
      />
    </svg>
  );
}

export function UnderlineScribble({
  className,
  color = "#bef264",
  delay = 0,
}: {
  className?: string;
  color?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <svg
      viewBox="0 0 220 14"
      fill="none"
      aria-hidden
      className={className}
      preserveAspectRatio="none"
    >
      <motion.path
        d="M4 9 C 48 3, 120 2, 216 6"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        initial={{ pathLength: reduce ? 1 : 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: reduce ? 0 : 0.7, delay, ease: EASE }}
      />
    </svg>
  );
}

/** A small hand-drawn arrow, pointing down-right by default. */
export function ArrowScribble({
  className,
  color = "#a8a29e",
  delay = 0,
}: {
  className?: string;
  color?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <svg viewBox="0 0 80 70" fill="none" aria-hidden className={className}>
      <motion.path
        d="M8 6 C 22 34, 38 50, 62 58 M62 58 L 44 54 M62 58 L 58 40"
        stroke={color}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: reduce ? 1 : 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: "-40px" }}
        transition={{ duration: reduce ? 0 : 0.7, delay, ease: EASE }}
      />
    </svg>
  );
}
