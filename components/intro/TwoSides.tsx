"use client";

/**
 * The fork in the road: one card per side of the desk. The educator card is
 * the doorway to the original landing page (now the educator deep-dive at
 * /educators). All visuals are composed from UI primitives — no stock art.
 */

import Link from "next/link";
import { Reveal, Stagger, StaggerItem } from "@/components/marketing/motion";
import { UnderlineScribble } from "./Annotate";

function Asterisk() {
  return (
    <span aria-hidden className="mr-2.5 font-mono text-[15px] leading-none text-orange-500">
      *
    </span>
  );
}

function LearnerVisual() {
  return (
    <div
      role="img"
      aria-label="A lesson list with progress"
      className="flex items-center gap-5 rounded-2xl bg-stone-100/70 p-5"
    >
      {/* Progress ring (static, drawn once) */}
      <svg viewBox="0 0 64 64" className="size-16 shrink-0 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r="26" stroke="#e7e5e4" strokeWidth="7" fill="none" />
        <circle
          cx="32"
          cy="32"
          r="26"
          stroke="#f97316"
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={2 * Math.PI * 26}
          strokeDashoffset={2 * Math.PI * 26 * 0.28}
        />
      </svg>
      <div className="min-w-0 flex-1 space-y-2">
        {[
          { label: "Prefix Sums", done: true },
          { label: "Two Pointers Basics", done: true },
          { label: "Sliding Windows", done: false },
        ].map((lesson) => (
          <div key={lesson.label} className="flex items-center gap-2.5">
            <span
              className={
                lesson.done
                  ? "grid size-4 place-items-center rounded-full bg-orange-500 text-[8px] font-bold text-white"
                  : "size-4 rounded-full ring-1 ring-inset ring-stone-300"
              }
            >
              {lesson.done ? "✓" : ""}
            </span>
            <span className="truncate text-[12.5px] font-medium text-stone-700">
              {lesson.label}
            </span>
            {!lesson.done && (
              <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider text-stone-400">
                up next
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EducatorVisual() {
  return (
    <div
      role="img"
      aria-label="A miniature of the slide studio"
      className="rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10"
    >
      <div className="flex gap-3">
        <div className="flex w-16 shrink-0 flex-col gap-1.5">
          {[28, 20, 24].map((w, i) => (
            <div
              key={i}
              className={i === 1 ? "rounded bg-orange-300/30 py-1" : "rounded bg-white/[0.08] py-1"}
            >
              <div className="mx-1.5 h-1 rounded-full bg-white/20" style={{ width: w }} />
            </div>
          ))}
        </div>
        <div className="aspect-video min-w-0 flex-1 rounded-lg bg-stone-50 p-2.5">
          <div className="h-2 w-2/5 rounded-sm bg-stone-800" />
          <div className="mt-2 flex gap-2">
            <div className="flex-1 space-y-1">
              <div className="h-1.5 w-full rounded-full bg-stone-200" />
              <div className="h-1.5 w-4/5 rounded-full bg-stone-200" />
              <div className="h-1.5 w-3/5 rounded-full bg-stone-200" />
            </div>
            <div className="h-10 w-12 rounded-md bg-amber-100 ring-1 ring-amber-200" />
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-stone-950/60 px-2.5 py-1.5">
        <span className="size-1 rounded-full bg-orange-400" />
        <span className="font-mono text-[9px] text-stone-400">
          add a checkpoint quiz after this slide
        </span>
      </div>
    </div>
  );
}

export function TwoSides() {
  return (
    <section id="learners" className="bg-stone-100 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-stone-500">
            Two sides, one studio
          </p>
          <h2 className="mt-4 max-w-2xl text-4xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-5xl">
            Choose your side{" "}
            <span className="relative inline-block whitespace-nowrap">
              of the desk
              <UnderlineScribble
                className="absolute -bottom-2 left-0 h-3 w-full"
                color="#f97316"
                delay={0.5}
              />
            </span>
            .
          </h2>
        </Reveal>

        <Stagger className="mt-14 grid gap-6 lg:grid-cols-2" stagger={0.12}>
          {/* ── Learners ── */}
          <StaggerItem className="group flex flex-col rounded-[2rem] bg-white p-8 ring-1 ring-stone-200 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_24px_60px_rgba(28,25,23,0.10)] sm:p-10">
            <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-stone-400">
              For learners
            </p>
            <h3 className="mt-3 text-2xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
              Courses you&rsquo;ll actually finish.
            </h3>
            <p className="mt-3 text-[14.5px] leading-relaxed text-stone-500">
              No two-hour video dumps. Structured lessons, worked examples, and
              checkpoints that explain <em>why</em> — built by educators with a
              studio that holds them to it.
            </p>
            <ul className="mt-6 space-y-2.5 text-[13.5px] text-stone-600">
              <li className="flex"><Asterisk />Slides, examples, and practice in every lesson</li>
              <li className="flex"><Asterisk />Quizzes that teach instead of just grading</li>
              <li className="flex"><Asterisk />Progress and streaks that pull you back</li>
            </ul>
            <div className="mt-8">
              <LearnerVisual />
            </div>
            <Link
              href="/marketplace"
              className="group/cta mt-8 inline-flex h-12 items-center justify-center gap-2 rounded-full bg-stone-900 px-6 text-[14.5px] font-semibold text-stone-50 transition-transform hover:-translate-y-0.5"
            >
              Browse the marketplace
              <span aria-hidden className="transition-transform group-hover/cta:translate-x-0.5">→</span>
            </Link>
          </StaggerItem>

          {/* ── Educators (routes to the original landing) ── */}
          <StaggerItem className="group flex flex-col rounded-[2rem] bg-stone-950 p-8 ring-1 ring-stone-900 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_24px_60px_rgba(28,25,23,0.35)] sm:p-10">
            <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-orange-300">
              For educators
            </p>
            <h3 className="mt-3 text-2xl font-light tracking-tight text-stone-50 [font-family:var(--font-display)]">
              A studio, not a form builder.
            </h3>
            <p className="mt-3 text-[14.5px] leading-relaxed text-stone-400">
              Design slides on a real canvas, generate assessments in minutes,
              and ship with a co-author that flags what students will trip on —
              before they do.
            </p>
            <ul className="mt-6 space-y-2.5 text-[13.5px] text-stone-300">
              <li className="flex"><Asterisk />A slide canvas that feels like a design tool</li>
              <li className="flex"><Asterisk />Quizzes, homework, and rubrics on tap</li>
              <li className="flex"><Asterisk />Quality feedback while you write</li>
            </ul>
            <div className="mt-8">
              <EducatorVisual />
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                href="/educators"
                className="group/cta inline-flex h-12 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-orange-600 px-6 text-[14.5px] font-semibold text-white shadow-md shadow-orange-950/40 transition-transform hover:-translate-y-0.5"
              >
                Take the educator tour
                <span aria-hidden className="transition-transform group-hover/cta:translate-x-0.5">→</span>
              </Link>
              <Link
                href="/studio"
                className="text-[13px] font-medium text-stone-400 underline-offset-4 transition-colors hover:text-stone-200 hover:underline"
              >
                or jump straight into the studio
              </Link>
            </div>
          </StaggerItem>
        </Stagger>
      </div>
    </section>
  );
}
