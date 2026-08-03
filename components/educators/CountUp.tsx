"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useInView, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/ease";

/** Counts up from 0 to `to` the first time it scrolls into view. */
export function CountUp({
  to,
  suffix = "",
  duration = 1.6,
}: {
  to: number;
  suffix?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!inView || reduce) return;
    const controls = animate(0, to, {
      duration,
      ease: EASE,
      onUpdate: (v) => setValue(Math.round(v)),
    });
    return () => controls.stop();
  }, [inView, to, reduce, duration]);

  // Reduced-motion users get the final value with no animation.
  const display = reduce ? to : value;

  return (
    <span ref={ref}>
      {/* Expose the final value to assistive tech; animate the visual only. */}
      <span className="sr-only">
        {to.toLocaleString()}
        {suffix}
      </span>
      <span aria-hidden>
        {display.toLocaleString()}
        {suffix}
      </span>
    </span>
  );
}
