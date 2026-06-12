"use client";

/**
 * A slow typographic marquee of real course subjects — breadth without stock
 * imagery. Scrolls only while visible; sits still under reduced motion.
 */

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";

const topics = [
  "Two Pointers in C++",
  "Watercolor Botanicals",
  "AP Physics: Mechanics",
  "Conversational Korean",
  "Financial Modeling",
  "Short Fiction Workshop",
  "Linear Algebra, Visualized",
  "Espresso Fundamentals",
  "Graph Theory Bootcamp",
  "Music Theory for Producers",
];

function Row() {
  return (
    <div className="flex shrink-0 items-center">
      {topics.map((topic, i) => (
        <span key={topic} className="flex items-center">
          <span className="px-5 font-mono text-[11px] uppercase tracking-[0.2em] text-stone-500">
            <span className="mr-3 text-orange-500/70">{String(i + 1).padStart(2, "0")}</span>
            {topic}
          </span>
          <span aria-hidden className="text-stone-300">
            ·
          </span>
        </span>
      ))}
    </div>
  );
}

export function TopicMarquee() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2 });
  const reduce = useReducedMotion();

  return (
    <section
      ref={ref}
      aria-label="Subjects taught on CourseGen"
      className="relative overflow-hidden border-y border-stone-900/[0.07] bg-[#FAF7F1] py-5"
    >
      <div
        className="flex w-max"
        style={{
          maskImage: "linear-gradient(to right, transparent, black 12%, black 88%, transparent)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent, black 12%, black 88%, transparent)",
        }}
      >
        <motion.div
          className="flex"
          animate={inView && !reduce ? { x: ["0%", "-50%"] } : undefined}
          transition={{ duration: 48, repeat: Infinity, ease: "linear" }}
        >
          <Row />
          <div aria-hidden>
            <Row />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
