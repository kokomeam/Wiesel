"use client";

/**
 * Background art library — each marketing surface gets its OWN treatment so
 * no animation repeats across the site:
 *
 *   HalftoneDrift — an editorial print-dot field that drifts diagonally,
 *                   one tile period per loop (seamless).
 *   SunriseGlow   — a wide warm light rising from below the fold.
 *   DoodleField   — oversized, ultra-faint annotation marks (the brand
 *                   motif at architectural scale).
 *   RippleArcs    — concentric rings breathing out from the bottom edge,
 *                   for the gradient close.
 *
 * All deterministic; loops run only on screen and freeze under reduced
 * motion (drift/ripples render their static frame).
 */

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { ArrowScribble, CircleScribble, UnderlineScribble } from "./Annotate";

/* ─────────────────────────── HalftoneDrift ────────────────────────────── */

const TILE = 24;

export function HalftoneDrift({
  className,
  maskImage = "radial-gradient(ellipse 75% 65% at 60% 30%, black 25%, transparent 72%)",
}: {
  className?: string;
  maskImage?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.1 });
  const reduce = useReducedMotion();
  const drift = inView && !reduce;

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("absolute inset-0 overflow-hidden", className)}
      style={{ maskImage, WebkitMaskImage: maskImage }}
    >
      <motion.div
        className="absolute -inset-12 will-change-transform"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(124,45,18,0.13) 1px, transparent 0)",
          backgroundSize: `${TILE}px ${TILE}px`,
        }}
        animate={drift ? { x: [0, TILE], y: [0, TILE] } : undefined}
        transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
      />
    </div>
  );
}

/* ──────────────────────────── SunriseGlow ─────────────────────────────── */

export function SunriseGlow({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.1 });
  const reduce = useReducedMotion();
  const breathe = inView && !reduce;

  return (
    <div ref={ref} aria-hidden className={cn("absolute inset-0 overflow-hidden", className)}>
      <motion.div
        className="absolute left-1/2 top-full h-[44rem] w-[120rem] -translate-x-1/2 -translate-y-[34%] rounded-[100%] will-change-transform"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(249,115,22,0.16) 0%, rgba(251,191,36,0.08) 42%, transparent 68%)",
        }}
        animate={breathe ? { scale: [1, 1.06, 1] } : undefined}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -left-32 top-[-14%] h-[30rem] w-[30rem] rounded-full bg-amber-300/20 blur-3xl will-change-transform"
        animate={breathe ? { scale: [1, 1.12, 1], x: [0, 30, 0] } : undefined}
        transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

/* ──────────────────────────── DoodleField ─────────────────────────────── */

export function DoodleField() {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      {/* a giant circled "something" off the right edge, behind the demo */}
      <CircleScribble
        className="absolute -right-44 top-16 h-56 w-[34rem] opacity-[0.16] sm:-right-24"
        color="#f97316"
        delay={1.2}
      />
      {/* a long underline swoosh crossing the lower-left */}
      <UnderlineScribble
        className="absolute -left-16 bottom-28 h-6 w-96 -rotate-6 opacity-[0.2]"
        color="#fb923c"
        delay={1.6}
      />
      {/* an arrow wandering toward the content */}
      <ArrowScribble
        className="absolute left-[12%] top-24 h-24 w-28 -scale-x-100 opacity-[0.22]"
        color="#d6c9b6"
        delay={2.0}
      />
      {/* the brand asterisk as a watermark */}
      <span
        className="absolute -bottom-24 right-[6%] select-none text-[22rem] font-light leading-none text-orange-900 opacity-[0.04] [font-family:var(--font-display)]"
        style={{ transform: "rotate(12deg)" }}
      >
        *
      </span>
    </div>
  );
}

/* ──────────────────────────── RippleArcs ──────────────────────────────── */

const RING_SIZES = [22, 38, 54, 70, 86];

export function RippleArcs() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2 });
  const reduce = useReducedMotion();
  const ripple = inView && !reduce;

  return (
    <div ref={ref} aria-hidden className="absolute inset-0 overflow-hidden">
      {/* static concentric rings rising from the bottom edge */}
      {RING_SIZES.map((size, i) => (
        <div
          key={size}
          className="absolute bottom-0 left-1/2 rounded-full border border-white/[0.14]"
          style={{
            width: `${size}rem`,
            height: `${size}rem`,
            transform: "translate(-50%, 52%)",
            opacity: 1 - i * 0.16,
          }}
        />
      ))}
      {/* expanding ripples, staggered */}
      {[0, 2.6, 5.2].map((delay) => (
        <motion.div
          key={delay}
          className="absolute bottom-0 left-1/2 h-[88rem] w-[88rem] rounded-full border-2 border-white/35 will-change-transform"
          style={{ x: "-50%", y: "52%" }}
          animate={ripple ? { scale: [0.18, 1.04], opacity: [0.5, 0] } : { opacity: 0 }}
          transition={
            ripple
              ? { duration: 7.8, repeat: Infinity, ease: "easeOut", delay }
              : { duration: 0 }
          }
        />
      ))}
      {/* warm bloom behind the rings */}
      <div
        className="absolute bottom-0 left-1/2 h-[30rem] w-[70rem] -translate-x-1/2 translate-y-1/2 rounded-[100%]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(255,237,213,0.35) 0%, transparent 65%)",
        }}
      />
    </div>
  );
}
