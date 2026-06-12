"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";

/**
 * Animated flowing SVG paths — adapted from the shadcn "background-paths"
 * snippet to be a reusable, brand-tinted BACKGROUND layer (no title/button).
 *
 * Notes for this codebase:
 * - Color comes from `currentColor`, so tint via a text-* class (default brand).
 * - Per-path timing is deterministic (no Math.random) to avoid SSR/hydration
 *   mismatches in Next.js.
 * - Animation pauses when scrolled out of view and freezes under reduced-motion.
 */
function FloatingPaths({
  position,
  animate,
}: {
  position: number;
  animate: boolean;
}) {
  const paths = Array.from({ length: 36 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${
      380 - i * 5 * position
    } -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${
      152 - i * 5 * position
    } ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${
      684 - i * 5 * position
    } ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
    width: 0.5 + i * 0.03,
  }));

  return (
    <svg
      className="h-full w-full"
      viewBox="0 0 696 316"
      fill="none"
      preserveAspectRatio="xMidYMid slice"
    >
      {paths.map((path) => (
        <motion.path
          key={path.id}
          d={path.d}
          stroke="currentColor"
          strokeWidth={path.width}
          strokeOpacity={0.1 + path.id * 0.03}
          initial={{ pathLength: 0.3, opacity: 0.6 }}
          animate={
            animate
              ? {
                  pathLength: 1,
                  opacity: [0.3, 0.6, 0.3],
                  pathOffset: [0, 1, 0],
                }
              : { pathLength: 1, opacity: 0.5 }
          }
          transition={
            animate
              ? {
                  // deterministic per-path duration (no Math.random)
                  duration: 20 + (path.id % 10),
                  repeat: Number.POSITIVE_INFINITY,
                  ease: "linear",
                }
              : { duration: 0 }
          }
        />
      ))}
    </svg>
  );
}

export function BackgroundPaths({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "0px" });
  const reduce = useReducedMotion();
  const animate = inView && !reduce;

  return (
    <div
      ref={ref}
      aria-hidden
      style={style}
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden text-orange-400",
        className
      )}
    >
      <FloatingPaths position={1} animate={animate} />
      <FloatingPaths position={-1} animate={animate} />
    </div>
  );
}
