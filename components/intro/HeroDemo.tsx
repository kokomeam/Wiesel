"use client";

/**
 * The hero's living product demo. Two looping storyboards built entirely from
 * UI primitives (no stock imagery):
 *
 *   teaching — a miniature of the real slide studio: elements assemble, a
 *              plain-language command lands, the slide tightens itself up.
 *   learning — a lesson player: a quiz answers, explains why, progress moves.
 *
 * Deterministic step timelines; they tick only while on screen and hold a
 * finished frame under reduced motion.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/ease";

export type Audience = "learning" | "teaching";

const STEP_MS = 1500;
const STEPS = 6;

function useSceneTick(enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => (t + 1) % STEPS), STEP_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return tick;
}

const pop = {
  initial: { opacity: 0, y: 10, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, scale: 0.97 },
  transition: { duration: 0.45, ease: EASE },
};

/* ─────────────────────────── Teaching scene ───────────────────────────── */

function TeachingScene({ step }: { step: number }) {
  const tightened = step >= 4;
  return (
    <div className="flex h-full gap-3">
      {/* Outline rail */}
      <div className="hidden w-24 shrink-0 flex-col gap-1.5 rounded-xl bg-stone-100 p-2 sm:flex">
        <p className="px-1 font-mono text-[8px] uppercase tracking-widest text-stone-400">
          Outline
        </p>
        {["Intro", "Two Pointers", "Quiz"].map((label, i) => (
          <div
            key={label}
            className={cn(
              "rounded-md px-2 py-1.5 text-[9px] font-medium",
              i === 1 ? "bg-orange-100 text-orange-800" : "text-stone-500"
            )}
          >
            {label}
          </div>
        ))}
      </div>

      {/* Slide canvas */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative flex-1 overflow-hidden rounded-xl bg-white p-4 shadow-[0_10px_30px_rgba(120,72,20,0.10)] ring-1 ring-stone-200/70">
          <AnimatePresence>
            {step >= 1 && (
              <motion.div key="title" {...pop} className="mb-3">
                <div className="text-[15px] font-semibold tracking-tight text-stone-900">
                  When does two pointers apply?
                </div>
                <div className="mt-1 h-[3px] w-10 rounded-full bg-orange-500" />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <AnimatePresence>
                {step >= 2 &&
                  [
                    "The array is sorted (or sortable)",
                    "You need a pair or window",
                    !tightened && "Each end moves predictably",
                    !tightened && "Brute force is too slow",
                  ]
                    .filter((b): b is string => Boolean(b))
                    .map((bullet, i) => (
                      <motion.div
                        key={bullet}
                        {...pop}
                        transition={{ ...pop.transition, delay: i * 0.12 }}
                        className="flex items-start gap-1.5"
                      >
                        <span className="mt-[5px] size-1 shrink-0 rounded-full bg-orange-500" />
                        <span className="text-[10.5px] leading-snug text-stone-600">
                          {bullet}
                        </span>
                      </motion.div>
                    ))}
              </AnimatePresence>
            </div>

            {/* Diagram block appears when the AI tightens the slide */}
            <AnimatePresence>
              {tightened && (
                <motion.div
                  key="diagram"
                  {...pop}
                  className="flex w-24 shrink-0 flex-col items-center gap-1.5 rounded-lg bg-amber-50 p-2 ring-1 ring-amber-200"
                >
                  <div className="flex w-full items-center justify-between">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <span
                        key={i}
                        className={cn(
                          "size-2.5 rounded-sm",
                          i === 0 || i === 4 ? "bg-orange-500" : "bg-amber-200"
                        )}
                      />
                    ))}
                  </div>
                  <span className="font-mono text-[7px] uppercase tracking-wider text-orange-700">
                    L → · ← R
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Command line */}
        <div className="mt-2.5 h-9">
          <AnimatePresence mode="wait">
            {step >= 3 && step < 4 && (
              <motion.div
                key="cmd"
                {...pop}
                className="flex h-9 items-center gap-2 rounded-lg bg-stone-100 px-3 ring-1 ring-stone-200"
              >
                <span className="size-1.5 rounded-full bg-orange-500" />
                <span className="font-mono text-[10px] text-stone-600">
                  tighten this slide up
                </span>
                <motion.span
                  className="h-3 w-px bg-orange-500"
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 0.9, repeat: Infinity }}
                />
              </motion.div>
            )}
            {tightened && (
              <motion.div
                key="done"
                {...pop}
                className="flex h-9 items-center gap-2 rounded-lg bg-emerald-50 px-3 ring-1 ring-emerald-200"
              >
                <svg viewBox="0 0 12 12" className="size-3" fill="none" aria-hidden>
                  <path
                    d="M2 6.5 L4.8 9 L10 3.5"
                    stroke="#059669"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="font-mono text-[10px] text-emerald-700">
                  done — 2 bullets → speaker notes, visual added
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Learning scene ───────────────────────────── */

function LearningScene({ step }: { step: number }) {
  const reduce = useReducedMotion();
  const answered = step >= 3;
  const progress = step >= 4 ? 0.72 : 0.64;

  return (
    <div className="flex h-full flex-col">
      {/* Lesson header */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="font-mono text-[8px] uppercase tracking-widest text-stone-400">
            Week 4 · Lesson 2
          </p>
          <p className="text-[13px] font-semibold text-stone-900">Two Pointers Basics</p>
        </div>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 font-mono text-[9px] text-stone-600 ring-1 ring-stone-200">
          {Math.round(progress * 100)}% complete
        </span>
      </div>
      <div className="mb-4 h-1 overflow-hidden rounded-full bg-stone-200">
        <motion.div
          className="h-full origin-left rounded-full bg-gradient-to-r from-amber-500 to-orange-600"
          initial={false}
          animate={{ scaleX: progress }}
          style={{ width: "100%" }}
          transition={{ duration: reduce ? 0 : 0.8, ease: EASE }}
        />
      </div>

      {/* Quiz card */}
      <div className="flex-1 rounded-xl bg-white p-4 shadow-[0_10px_30px_rgba(120,72,20,0.10)] ring-1 ring-stone-200/70">
        <p className="font-mono text-[8px] uppercase tracking-widest text-stone-400">
          Checkpoint · 2 of 3
        </p>
        <p className="mt-1.5 text-[12px] font-semibold leading-snug text-stone-900">
          A pointer sometimes needs to move backwards to recheck an element.
        </p>
        <div className="mt-3 space-y-1.5">
          {[
            { label: "True", correct: false },
            { label: "False — each step retires one element", correct: true },
          ].map((choice) => {
            const picked = answered && choice.correct;
            const dimmed = answered && !choice.correct;
            return (
              <motion.div
                key={choice.label}
                initial={false}
                animate={{ opacity: dimmed ? 0.45 : 1 }}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 ring-1 transition-colors",
                  picked ? "bg-emerald-50 ring-emerald-400" : "bg-stone-50 ring-stone-200"
                )}
              >
                <span
                  className={cn(
                    "grid size-3.5 shrink-0 place-items-center rounded-full ring-1",
                    picked ? "bg-emerald-500 ring-emerald-600" : "ring-stone-300"
                  )}
                >
                  {picked && (
                    <svg viewBox="0 0 10 10" className="size-2.5" fill="none" aria-hidden>
                      <motion.path
                        d="M2 5.4 L4.2 7.5 L8 2.8"
                        stroke="#ffffff"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={{ pathLength: reduce ? 1 : 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: reduce ? 0 : 0.4, ease: EASE }}
                      />
                    </svg>
                  )}
                </span>
                <span className="text-[10.5px] font-medium text-stone-700">
                  {choice.label}
                </span>
              </motion.div>
            );
          })}
        </div>
        <div className="mt-3 h-8">
          <AnimatePresence>
            {answered && (
              <motion.p
                key="why"
                {...pop}
                className="rounded-lg bg-stone-100 px-3 py-1.5 text-[9.5px] leading-snug text-stone-500"
              >
                Monotonic movement is the whole proof — it&rsquo;s what makes the scan O(n).
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Streak chip */}
      <div className="mt-2.5 h-9">
        <AnimatePresence>
          {step >= 4 && (
            <motion.div
              key="streak"
              {...pop}
              className="flex h-9 items-center justify-between rounded-lg bg-amber-50 px-3 ring-1 ring-amber-200"
            >
              <span className="font-mono text-[10px] text-amber-800">
                +10 xp · 12-day streak
              </span>
              <span className="font-mono text-[10px] text-stone-400">
                next: Sliding Windows
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ──────────────────────────────── Shell ───────────────────────────────── */

export function HeroDemo({ audience }: { audience: Audience }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const tick = useSceneTick(inView && !reduce);
  // Reduced motion: hold the storyboard's finished frame.
  const step = reduce ? STEPS - 1 : tick;

  return (
    <div
      ref={ref}
      role="img"
      aria-label={
        audience === "teaching"
          ? "Animated preview of the course studio assembling and tidying a slide"
          : "Animated preview of a lesson player answering a quiz question"
      }
      className="relative rounded-3xl bg-white/60 p-1.5 shadow-[0_30px_70px_-20px_rgba(120,72,20,0.25)] ring-1 ring-stone-200/80 backdrop-blur"
    >
      <div className="rounded-[1.25rem] bg-[#FDFBF7] p-4 ring-1 ring-stone-200/60">
        {/* Window chrome */}
        <div className="mb-3 flex items-center gap-2">
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-2 rounded-full bg-stone-300" />
            ))}
          </div>
          <span className="ml-2 font-mono text-[9px] tracking-wide text-stone-400">
            {audience === "teaching" ? "studio — two-pointers.course" : "learning — week-4"}
          </span>
          <span className="ml-auto rounded-full bg-amber-50 px-2 py-0.5 font-mono text-[8px] uppercase tracking-widest text-amber-700 ring-1 ring-amber-200/70">
            live demo
          </span>
        </div>

        <div className="h-[19rem]">
          <AnimatePresence mode="wait">
            <motion.div
              key={audience}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="h-full"
            >
              {audience === "teaching" ? (
                <TeachingScene step={step} />
              ) : (
                <LearningScene step={step} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
