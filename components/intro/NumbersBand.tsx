"use client";

/**
 * Early numbers in big serif numerals on warm paper. Counts up once in view;
 * screen readers get the final value immediately and reduced motion skips
 * the count.
 */

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "framer-motion";

const stats = [
  { value: 1900, suffix: "+", label: "courses crafted" },
  { value: 12480, suffix: "", label: "active learners" },
  { value: 94, suffix: "%", label: "lesson completion" },
  { value: 4.9, suffix: "", label: "avg course rating", decimals: 1 },
];

function format(n: number, decimals = 0) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function Numeral({
  value,
  suffix,
  decimals = 0,
  start,
}: {
  value: number;
  suffix: string;
  decimals?: number;
  start: boolean;
}) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    if (!start || done.current || reduce) return;
    done.current = true;
    const t0 = performance.now();
    const DURATION = 1300;
    let raf: number;
    const frame = (t: number) => {
      const p = Math.min(1, (t - t0) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(value * eased);
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [start, value, reduce]);

  const display = reduce ? value : shown;
  return (
    <span className="text-5xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-6xl">
      <span className="sr-only">
        {format(value, decimals)}
        {suffix}
      </span>
      <span aria-hidden>
        {format(display, decimals)}
        <span className="text-orange-500">{suffix}</span>
      </span>
    </span>
  );
}

export function NumbersBand() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section className="border-y border-stone-900/[0.07] bg-white py-20 sm:py-24">
      <div ref={ref} className="mx-auto max-w-6xl px-6">
        <p className="mb-12 text-center font-mono text-[11px] uppercase tracking-[0.28em] text-stone-400">
          The early numbers
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-12 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col items-center text-center">
              <dd>
                <Numeral
                  value={stat.value}
                  suffix={stat.suffix}
                  decimals={stat.decimals}
                  start={inView}
                />
              </dd>
              <dt className="mt-2.5 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-400">
                {stat.label}
              </dt>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
