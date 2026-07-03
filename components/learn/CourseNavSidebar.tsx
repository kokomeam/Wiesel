"use client";

/**
 * Course contents sidebar for the lesson player: collapsible modules → lessons,
 * the current lesson highlighted, per-lesson progress, and click-to-navigate so a
 * learner always knows where they are and can peek at what's coming. Read-only —
 * it just links into the player. Desktop = a sticky panel (collapsible to a rail);
 * mobile = a "Contents" button that opens a slide-over drawer.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";

export type NavLessonStatus = "not_started" | "in_progress" | "completed";

export interface NavLesson {
  id: string;
  title: string;
  estimatedMinutes: number | null;
  status: NavLessonStatus;
  pct: number;
}
export interface NavModule {
  id: string;
  title: string;
  lessons: NavLesson[];
}

interface Props {
  slug: string;
  courseTitle: string;
  modules: NavModule[];
  currentLessonId: string;
  completedCount: number;
  totalCount: number;
  pct: number;
  /** Author preview → progress is meaningless; show a lighter framing. */
  authorPreview?: boolean;
}

export function CourseNavSidebar(props: Props) {
  const { modules, currentLessonId } = props;
  const currentModuleId =
    modules.find((m) => m.lessons.some((l) => l.id === currentLessonId))?.id ?? modules[0]?.id;

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openModules, setOpenModules] = useState<Set<string>>(
    () => new Set(currentModuleId ? [currentModuleId] : [])
  );

  // Close the mobile drawer on Escape (listener only — no setState-in-render).
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const toggleModule = (id: string) =>
    setOpenModules((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      {/* ── Mobile trigger (in flow) ── */}
      <div className="lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="inline-flex items-center gap-2 rounded-full border border-stone-200/80 bg-white px-3.5 py-2 text-sm font-medium text-stone-700 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-colors hover:border-stone-300"
        >
          <ListTree className="size-4 text-brand-500" aria-hidden />
          Contents
          <span className="tabular-nums text-stone-400">
            {props.completedCount}/{props.totalCount}
          </span>
        </button>
      </div>

      {/* ── Desktop: collapsed rail ── */}
      {collapsed ? (
        <div className="hidden shrink-0 lg:block">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title="Show course contents"
            aria-label="Show course contents"
            className="sticky top-20 grid size-9 place-items-center rounded-xl border border-stone-200/80 bg-white text-stone-500 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-colors hover:text-stone-800"
          >
            <PanelLeftOpen className="size-4" aria-hidden />
          </button>
        </div>
      ) : (
        <aside className="hidden w-72 shrink-0 lg:block">
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <NavContent
              {...props}
              openModules={openModules}
              toggleModule={toggleModule}
              onCollapse={() => setCollapsed(true)}
            />
          </div>
        </aside>
      )}

      {/* ── Mobile drawer ── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label="Course contents">
          <div className="absolute inset-0 bg-stone-950/40 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[86%] max-w-sm flex-col overflow-y-auto bg-[#faf7f1] shadow-2xl">
            <NavContent
              {...props}
              openModules={openModules}
              toggleModule={toggleModule}
              onClose={() => setMobileOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}

function NavContent({
  slug,
  courseTitle,
  modules,
  currentLessonId,
  completedCount,
  totalCount,
  pct,
  authorPreview,
  openModules,
  toggleModule,
  onCollapse,
  onClose,
}: Props & {
  openModules: Set<string>;
  toggleModule: (id: string) => void;
  onCollapse?: () => void;
  onClose?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className="flex items-start justify-between gap-2 border-b border-stone-100 px-3.5 py-3">
        <Link
          href={`/learn/${slug}`}
          className="min-w-0 text-sm font-semibold leading-snug tracking-tight text-stone-800 transition-colors hover:text-brand-700"
        >
          {courseTitle}
        </Link>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Hide contents"
            aria-label="Hide contents"
            className="-mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <PanelLeftClose className="size-4" aria-hidden />
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close contents"
            className="-mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* progress */}
      <div className="border-b border-stone-100 px-3.5 py-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-medium text-stone-600">
            {authorPreview ? "Course outline" : "Your progress"}
          </span>
          {!authorPreview && (
            <span className="tabular-nums text-stone-400">
              {completedCount}/{totalCount}
            </span>
          )}
        </div>
        {!authorPreview && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
            <div className="brand-gradient h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {/* modules */}
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {modules.map((mod, mi) => {
          const open = openModules.has(mod.id);
          const done = mod.lessons.filter((l) => l.status === "completed").length;
          const hasCurrent = mod.lessons.some((l) => l.id === currentLessonId);
          return (
            <div key={mod.id}>
              <button
                type="button"
                onClick={() => toggleModule(mod.id)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-stone-50"
              >
                <ChevronRight
                  className={cn("size-3.5 shrink-0 text-stone-400 transition-transform", open && "rotate-90")}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[10px] uppercase tracking-[0.15em] text-stone-400">
                    Module {mi + 1}
                    {hasCurrent && !open ? " · current" : ""}
                  </span>
                  <span className="block truncate text-[13px] font-medium text-stone-800">{mod.title}</span>
                </span>
                {!authorPreview && (
                  <span className="shrink-0 text-[11px] tabular-nums text-stone-400">
                    {done}/{mod.lessons.length}
                  </span>
                )}
              </button>

              {open && (
                <ul className="mb-1 ml-3.5 space-y-0.5 border-l border-stone-100 pl-2">
                  {mod.lessons.map((lesson) => {
                    const active = lesson.id === currentLessonId;
                    return (
                      <li key={lesson.id}>
                        <Link
                          href={`/learn/${slug}/${lesson.id}`}
                          aria-current={active ? "page" : undefined}
                          onClick={onClose}
                          className={cn(
                            "relative flex items-center gap-2.5 rounded-lg py-1.5 pl-3 pr-2 text-[13px] transition-colors",
                            active
                              ? "bg-brand-50 font-medium text-stone-900"
                              : "text-stone-600 hover:bg-stone-50 hover:text-stone-900"
                          )}
                        >
                          {active && (
                            <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand-500" />
                          )}
                          <StatusDot status={lesson.status} />
                          <span className="min-w-0 flex-1 truncate">{lesson.title}</span>
                          {lesson.status === "in_progress" && lesson.pct > 0 ? (
                            <span className="shrink-0 text-[10px] font-medium tabular-nums text-brand-600">
                              {lesson.pct}%
                            </span>
                          ) : lesson.estimatedMinutes ? (
                            <span className="shrink-0 text-[10px] tabular-nums text-stone-400">
                              {lesson.estimatedMinutes}m
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function StatusDot({ status }: { status: NavLessonStatus }) {
  if (status === "completed") {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-label="Completed" />;
  }
  return (
    <Circle
      className={cn("size-4 shrink-0", status === "in_progress" ? "text-brand-500" : "text-stone-300")}
      aria-label={status === "in_progress" ? "In progress" : "Not started"}
    />
  );
}
