"use client";

/**
 * Course-landing module outline: collapsible accordions (WAI-ARIA heading >
 * button pattern) with per-module progress for enrolled learners. The lesson
 * rows keep the exact semantics of the original server-rendered outline —
 * link only when the caller may open lessons (href != null), minutes, and the
 * in-progress pct chip — with a per-lesson TYPE icon chip (video/slides/quiz/
 * homework/reading, computed by the page from the snapshot blocks) replacing
 * the old status-only column; completion/lock still override the icon.
 *
 * Default open: the module containing the continue target, else the first
 * module with an incomplete lesson, else the first. Collapse uses the CSS
 * grid-rows 0fr/1fr technique (content stays mounted; the global
 * prefers-reduced-motion guard kills the transition).
 */

import { useId, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChevronDown,
  FileText,
  HelpCircle,
  Layers,
  Lock,
  PenLine,
  PlayCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ProgressBar } from "@/components/ui/ProgressBar";

export type OutlineLessonStatus = "not_started" | "in_progress" | "completed";

export interface OutlineLesson {
  id: string;
  title: string;
  estimatedMinutes: number | null;
  status: OutlineLessonStatus;
  pct: number;
  /** Null = locked (not enrolled / signed out) — the row renders unlinked. */
  href: string | null;
  /** Dominant content type ("video" | "slides" | "quiz" | "homework" | "text")
   *  — drives the row's icon chip. Optional/additive; unknown values fall back
   *  to the reading icon. */
  primaryType?: string;
}

export interface OutlineModule {
  id: string;
  title: string;
  description: string | null;
  lessons: OutlineLesson[];
}

const TYPE_ICONS: Record<string, typeof PlayCircle> = {
  video: PlayCircle,
  slides: Layers,
  quiz: HelpCircle,
  homework: PenLine,
  text: FileText,
};

function defaultOpenModuleId(
  modules: OutlineModule[],
  continueLessonId: string | null
): string | null {
  if (continueLessonId) {
    const target = modules.find((m) => m.lessons.some((l) => l.id === continueLessonId));
    if (target) return target.id;
  }
  const incomplete = modules.find((m) => m.lessons.some((l) => l.status !== "completed"));
  return incomplete?.id ?? modules[0]?.id ?? null;
}

export function CourseOutline({
  modules,
  enrolled,
  continueLessonId,
}: {
  modules: OutlineModule[];
  /** Enrolled learners get the per-module "3/5" count + progress bar. */
  enrolled: boolean;
  continueLessonId: string | null;
}) {
  const idBase = useId();
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    const id = defaultOpenModuleId(modules, continueLessonId);
    return new Set(id ? [id] : []);
  });

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOpen = modules.length > 0 && modules.every((m) => openIds.has(m.id));

  return (
    <div>
      {modules.length > 1 ? (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={() =>
              setOpenIds(allOpen ? new Set() : new Set(modules.map((m) => m.id)))
            }
            className="rounded-full px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-800"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      ) : null}

      <div className="space-y-4">
        {modules.map((mod, mi) => {
          const open = openIds.has(mod.id);
          const total = mod.lessons.length;
          const done = mod.lessons.filter((l) => l.status === "completed").length;
          const inProgress =
            enrolled && (done > 0 || mod.lessons.some((l) => l.status === "in_progress"));
          const moduleComplete = enrolled && total > 0 && done === total;
          const modPct =
            total === 0 ? 0 : Math.round(mod.lessons.reduce((sum, l) => sum + l.pct, 0) / total);
          const modMinutes = mod.lessons.reduce(
            (sum, l) => sum + (l.estimatedMinutes ?? 0),
            0
          );
          const contentId = `${idBase}-module-${mi}`;

          return (
            <section
              key={mod.id}
              className={cn(
                "rounded-2xl border border-stone-200/80 bg-white transition-shadow",
                open
                  ? "shadow-[0_1px_2px_rgba(68,48,28,0.05),0_8px_24px_-12px_rgba(68,48,28,0.12)] ring-1 ring-brand-200/70"
                  : "shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
              )}
            >
              <h2>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={contentId}
                  onClick={() => toggle(mod.id)}
                  className="flex w-full items-center gap-4 rounded-2xl px-5 py-4 text-left transition-colors hover:bg-stone-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 sm:px-6"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-xl font-mono text-sm",
                      moduleComplete
                        ? "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100"
                        : open || inProgress
                          ? "brand-gradient text-white"
                          : "bg-stone-100 text-stone-500"
                    )}
                  >
                    {mi + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium text-stone-900">
                      {mod.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-stone-500">
                      {total} {total === 1 ? "lesson" : "lessons"}
                      {modMinutes > 0 ? ` · ${modMinutes} min` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {enrolled ? (
                      <>
                        <span className="text-xs font-normal tabular-nums tracking-normal text-stone-400">
                          {done}/{total}
                        </span>
                        <span className="hidden w-16 sm:block">
                          <ProgressBar
                            pct={modPct}
                            tone={moduleComplete ? "emerald" : "learn"}
                          />
                        </span>
                      </>
                    ) : null}
                    <ChevronDown
                      className={cn(
                        "size-4 text-stone-400 transition-transform duration-200",
                        !open && "-rotate-90"
                      )}
                      aria-hidden
                    />
                  </span>
                </button>
              </h2>

              <div
                id={contentId}
                inert={!open}
                className={cn(
                  "grid transition-[grid-template-rows] duration-300 ease-out",
                  open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="border-t border-stone-100">
                    {mod.description ? (
                      <p className="px-5 pb-1 pt-3 text-sm text-stone-500 sm:px-6">
                        {mod.description}
                      </p>
                    ) : null}
                    <ul className="divide-y divide-stone-100">
                      {mod.lessons.map((lesson) => {
                        const TypeIcon =
                          lesson.status === "completed"
                            ? CheckCircle2
                            : !lesson.href
                              ? Lock
                              : (TYPE_ICONS[lesson.primaryType ?? "text"] ?? FileText);
                        const row = (
                          <div className="flex items-center gap-3 px-5 py-3 sm:px-6">
                            <span
                              aria-hidden
                              className={cn(
                                "grid size-7 shrink-0 place-items-center rounded-lg",
                                lesson.status === "completed"
                                  ? "bg-emerald-50 text-emerald-500"
                                  : lesson.status === "in_progress"
                                    ? "bg-learn-50 text-learn-600"
                                    : "bg-stone-50 text-stone-400"
                              )}
                            >
                              <TypeIcon className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm text-stone-700">
                              {lesson.title}
                            </span>
                            {lesson.estimatedMinutes ? (
                              <span className="shrink-0 text-xs tabular-nums text-stone-400">
                                {lesson.estimatedMinutes} min
                              </span>
                            ) : null}
                            {lesson.status === "in_progress" ? (
                              <span className="shrink-0 rounded-full bg-learn-50 px-2 py-0.5 text-xs font-medium text-learn-700">
                                {lesson.pct}%
                              </span>
                            ) : null}
                          </div>
                        );
                        return (
                          <li key={lesson.id}>
                            {lesson.href ? (
                              <Link
                                href={lesson.href}
                                className="block transition-colors hover:bg-brand-50/40"
                              >
                                {row}
                              </Link>
                            ) : (
                              row
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
