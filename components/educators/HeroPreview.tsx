"use client";

import { useSyncExternalStore } from "react";
import {
  motion,
  useReducedMotion,
  useMotionValue,
  useSpring,
  useTransform,
  type MotionProps,
  type TargetAndTransition,
} from "framer-motion";
import { EASE } from "@/lib/ease";
import {
  Presentation,
  Code2,
  ListChecks,
  BookOpen,
  ArrowUpRight,
  Play,
} from "lucide-react";
import { curriculum, type LessonType } from "@/lib/data";

const lessonIcon: Record<LessonType, typeof Presentation> = {
  Slides: Presentation,
  Practice: Code2,
  Quiz: ListChecks,
  Reading: BookOpen,
};

const statusDot: Record<string, string> = {
  Published: "bg-emerald-400",
  Generating: "bg-orange-400 animate-pulse",
  Draft: "bg-amber-400",
};

// Real curriculum rows from Week 2 (includes a "Generating" row for life).
const rows = curriculum[1].lessons;

const steps = ["Curriculum Architect", "Content Producer", "Magic Wand"];

const FINE_POINTER = "(hover: hover) and (pointer: fine)";
function subscribeFine(cb: () => void) {
  const mq = window.matchMedia(FINE_POINTER);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function HeroPreview() {
  const reduce = useReducedMotion();
  // Only enable cursor-tilt on real fine-pointer + hover devices (SSR-safe).
  const fine = useSyncExternalStore(
    subscribeFine,
    () => window.matchMedia(FINE_POINTER).matches,
    () => false
  );

  // Cursor-reactive tilt (pointer-only, reduced-motion safe).
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rotateX = useSpring(useTransform(my, [-0.5, 0.5], [5, -5]), {
    stiffness: 150,
    damping: 18,
  });
  const rotateY = useSpring(useTransform(mx, [-0.5, 0.5], [-5, 5]), {
    stiffness: 150,
    damping: 18,
  });
  const tiltOff = reduce || !fine;

  // Entrance plays on mount (the cluster is above the fold).

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (tiltOff) return;
    const r = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width - 0.5);
    my.set((e.clientY - r.top) / r.height - 0.5);
  }
  function onLeave() {
    mx.set(0);
    my.set(0);
  }

  // Per-element entrance helper — collapses to final state under reduced motion.
  const enter = (
    from: TargetAndTransition,
    delay = 0,
    duration = 0.5
  ): MotionProps =>
    reduce
      ? { initial: false, animate: { opacity: 1, x: 0, y: 0, scale: 1 } }
      : {
          initial: from,
          animate: { opacity: 1, x: 0, y: 0, scale: 1 },
          transition: { duration, delay, ease: EASE },
        };

  const bar = (target: number, delay: number): MotionProps =>
    reduce
      ? { initial: false, animate: { scaleX: target } }
      : {
          initial: { scaleX: 0 },
          animate: { scaleX: target },
          transition: { duration: 0.9, delay, ease: EASE },
        };

  return (
    <div
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className="relative mx-auto w-full max-w-md px-1 pb-24 pt-2 sm:pb-28 lg:max-w-none lg:pb-24"
      style={{ perspective: 1200 }}
      role="img"
      aria-label="Preview of the WiseSel course studio and learner dashboard"
    >
      <motion.div
        style={{ rotateX: tiltOff ? 0 : rotateX, rotateY: tiltOff ? 0 : rotateY }}
        className="relative [transform-style:preserve-3d]"
      >
        {/* ───────── Back: Creator Studio card ───────── */}
        <motion.div
          {...enter({ opacity: 0, y: 16 })}
          className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_24px_60px_-24px_rgba(154,52,18,0.30)]"
          style={{ transform: "rotate(1.5deg)" }}
        >
          {/* header */}
          <div className="flex items-center gap-2.5">
            <div className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-[11px] font-bold text-white">
              SI
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-stone-900">
                  USACO Silver Bootcamp
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-medium text-orange-700 ring-1 ring-inset ring-orange-100">
                  <span className="size-1 rounded-full bg-orange-500" />
                  In Progress
                </span>
              </div>
              <p className="text-[11px] text-stone-400">Silver · Updated May 19</p>
            </div>
          </div>

          {/* agent stepper */}
          <div className="mt-3 flex items-center gap-1 rounded-xl border border-stone-200 bg-stone-50 p-1">
            {steps.map((s, i) => {
              const active = i === 1;
              return (
                <motion.div
                  key={s}
                  {...enter({ opacity: 0, scale: 0.96 }, 0.35 + i * 0.08)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[10px] font-medium ${
                    active
                      ? "bg-white text-stone-900 shadow-sm ring-1 ring-stone-200"
                      : "text-stone-500"
                  }`}
                >
                  <span
                    className={`grid size-4 place-items-center rounded-full text-[9px] font-bold ${
                      active ? "bg-gradient-to-br from-amber-500 to-orange-600 text-white" : "bg-stone-200 text-stone-500"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className="hidden truncate sm:inline">{s}</span>
                </motion.div>
              );
            })}
          </div>

          {/* curriculum rows */}
          <div className="mt-3 space-y-1">
            {rows.map((lesson, i) => {
              const Icon = lessonIcon[lesson.type];
              const generating = lesson.status === "Generating";
              return (
                <motion.div
                  key={lesson.id}
                  {...enter({ opacity: 0, y: 8 }, 0.6 + i * 0.09)}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 ${
                    generating ? "bg-orange-50/60 ring-1 ring-orange-100" : "hover:bg-stone-50"
                  }`}
                >
                  <Icon
                    className={`size-3.5 shrink-0 ${generating ? "text-orange-600" : "text-stone-400"}`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-medium text-stone-700">
                      {lesson.title}
                    </p>
                    {generating ? (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-orange-100">
                        <motion.div
                          {...bar(0.7, 0.9)}
                          className="h-full origin-left rounded-full bg-gradient-to-br from-amber-500 to-orange-600"
                        />
                      </div>
                    ) : (
                      <p className="text-[10px] text-stone-400">
                        {lesson.type} · {lesson.duration}
                      </p>
                    )}
                  </div>
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${statusDot[lesson.status] ?? "bg-stone-300"}`}
                  />
                </motion.div>
              );
            })}
          </div>
        </motion.div>

        {/* ───────── Front: learner dashboard card ───────── */}
        <motion.div
          {...enter({ opacity: 0, y: 24 }, 0.95, 0.6)}
          className="absolute -bottom-10 -right-2 w-[68%] rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_24px_50px_-20px_rgba(16,24,40,0.35)] sm:-bottom-12 sm:-right-6"
          style={{ transform: "rotate(-3deg)" }}
        >
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-full bg-stone-900 text-[10px] font-semibold text-white">
              AM
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-stone-900">
                Welcome back, Arjun 👋
              </p>
              <p className="truncate text-[10px] text-stone-400">
                Keep the momentum going
              </p>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-stone-200 bg-stone-50/60 p-2.5">
            <div className="flex items-center gap-2">
              <div className="grid size-7 place-items-center rounded-md bg-gradient-to-br from-amber-500 to-orange-600 text-[8px] font-bold text-white">
                SI
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-semibold text-stone-800">
                  USACO Silver Bootcamp
                </p>
                <p className="truncate text-[9px] text-stone-400">
                  Next: 1.3 Problem-Solving Mindset
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-200">
                <motion.div
                  {...bar(0.62, 1.2)}
                  className="h-full origin-left rounded-full bg-gradient-to-br from-amber-500 to-orange-600"
                />
              </div>
              <span className="text-[9px] font-medium text-stone-500">62%</span>
            </div>
          </div>

          <div
            className="mt-2.5 flex w-full items-center justify-center gap-1 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 py-1.5 text-[10px] font-semibold text-white"
            aria-hidden
          >
            <Play className="size-2.5 fill-current" />
            Resume course
          </div>
        </motion.div>

        {/* ───────── Magic Wand hint pill ───────── */}
        <motion.div
          {...enter({ opacity: 0, y: 6, scale: 0.96 }, 1.3)}
          className="group absolute -left-3 bottom-6 flex items-center gap-1.5 rounded-full border border-orange-100 bg-white py-1.5 pl-2 pr-3 shadow-lg shadow-orange-600/10 sm:-left-6"
        >
          <span className="grid size-5 place-items-center rounded-full bg-gradient-to-br from-amber-500 to-orange-600 text-white">
            <span aria-hidden className="text-[11px] font-bold leading-none">*</span>
          </span>
          <span className="text-[11px] font-medium text-stone-700">
            Rewrite this lesson
          </span>
          <ArrowUpRight
            className="size-3 text-orange-500 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </motion.div>
      </motion.div>
    </div>
  );
}
