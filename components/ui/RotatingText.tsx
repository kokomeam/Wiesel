"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";

/**
 * Cycles a list of words in place with an upward spring slide.
 * - Reserves the line height with an invisible spacer (no layout shift).
 * - Respects prefers-reduced-motion (shows the first word, no cycling).
 * - Exposes the full word list to assistive tech via an sr-only node.
 */
export function RotatingText({
  words,
  interval = 2200,
  className,
}: {
  words: string[];
  interval?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduce || words.length <= 1) return;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % words.length),
      interval
    );
    return () => clearInterval(id);
  }, [reduce, words.length, interval]);

  return (
    <span className="relative block overflow-hidden pb-1">
      {/* reserves the line box height */}
      <span className="invisible" aria-hidden>
        {words[0]}
      </span>
      {/* canonical reading for screen readers */}
      <span className="sr-only">{words.join(", ")}</span>

      {words.map((word, i) => {
        const active = i === index;
        return (
          <motion.span
            key={word}
            aria-hidden
            className={cn(
              "absolute left-0 top-0 whitespace-nowrap",
              className
            )}
            initial={false}
            animate={
              reduce
                ? { y: "0%", opacity: active ? 1 : 0 }
                : active
                  ? { y: "0%", opacity: 1 }
                  : { y: index > i ? "-120%" : "120%", opacity: 0 }
            }
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 200, damping: 26, mass: 0.8 }
            }
          >
            {word}
          </motion.span>
        );
      })}
    </span>
  );
}
