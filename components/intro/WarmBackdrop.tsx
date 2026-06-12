"use client";

/**
 * The hero's atmosphere: warm paper, a drifting halftone dot field, a
 * sunrise glow under the fold, oversized faint annotation doodles, a
 * cursor-following warm light on fine-pointer devices, and a whisper of
 * grain. (The flowing-paths animation now lives ONLY on the /educators
 * hero — every surface gets its own art; see backgrounds.tsx.)
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "framer-motion";
import { DoodleField, HalftoneDrift, SunriseGlow } from "./backgrounds";

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='7'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

const FINE_POINTER = "(hover: hover) and (pointer: fine)";
function subscribeFine(cb: () => void) {
  const mq = window.matchMedia(FINE_POINTER);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** A soft warm light that lazily follows the cursor (fine pointers only). */
function PointerGlow() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const fine = useSyncExternalStore(
    subscribeFine,
    () => window.matchMedia(FINE_POINTER).matches,
    () => false
  );
  const x = useMotionValue(-9999);
  const y = useMotionValue(-9999);
  const sx = useSpring(x, { stiffness: 45, damping: 18, mass: 0.6 });
  const sy = useSpring(y, { stiffness: 45, damping: 18, mass: 0.6 });

  const enabled = fine && !reduce;

  useEffect(() => {
    if (!enabled) return;
    function onMove(e: PointerEvent) {
      const parent = ref.current?.parentElement;
      if (!parent) return;
      const r = parent.getBoundingClientRect();
      x.set(e.clientX - r.left);
      y.set(e.clientY - r.top);
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [enabled, x, y]);

  if (!enabled) return null;

  return (
    <motion.div
      ref={ref}
      aria-hidden
      className="absolute left-0 top-0 size-[44rem] -translate-x-1/2 -translate-y-1/2 rounded-full will-change-transform"
      style={{
        x: sx,
        y: sy,
        background:
          "radial-gradient(closest-side, rgba(249,115,22,0.10), rgba(251,191,36,0.05) 45%, transparent 70%)",
      }}
    />
  );
}

export function WarmBackdrop({ pointer = true }: { pointer?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <SunriseGlow />
      <HalftoneDrift />
      <DoodleField />
      {pointer && <PointerGlow />}
      <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: NOISE }} />
    </div>
  );
}
