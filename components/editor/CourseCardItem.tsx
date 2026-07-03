"use client";

/**
 * One course card in the Creator Studio gallery: a link into the editor plus a
 * hover delete affordance with a final, can't-be-undone confirmation. Delete
 * runs the `deleteCourse` server action (cascades the whole course from the DB)
 * and revalidates the gallery.
 */

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, BarChart3, Trash2 } from "lucide-react";
import { deleteCourse } from "@/app/(app)/studio/actions";
import { Badge, statusTone } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { CourseCard } from "./CourseGallery";

function initials(title: string): string {
  return (
    title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "UC"
  );
}

function statusLabel(status: string): string {
  return status ? status[0].toUpperCase() + status.slice(1) : "Draft";
}

function editedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function CourseCardItem({ course }: { course: CourseCard }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const title = course.title || "Untitled course";

  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) setConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmOpen, isPending]);

  function onConfirm() {
    startTransition(async () => {
      await deleteCourse(course.id);
      setConfirmOpen(false);
    });
  }

  return (
    <>
      <Link href={`/studio?course=${course.id}`} className="group block focus:outline-none">
        <Card className="flex h-full flex-col p-5 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[0_8px_24px_rgba(68,48,28,0.08)] group-focus-visible:ring-2 group-focus-visible:ring-brand-300">
          <div className="flex items-start justify-between gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl brand-gradient text-[11px] font-bold text-white">
              {initials(title)}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={`Analytics for ${title}`}
                title="Learner analytics"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  router.push(`/studio/${course.id}/analytics`);
                }}
                className="grid size-7 place-items-center rounded-lg text-stone-300 opacity-0 transition-all hover:bg-brand-50 hover:text-brand-600 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <BarChart3 className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Delete ${title}`}
                title="Delete course"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmOpen(true);
                }}
                className="grid size-7 place-items-center rounded-lg text-stone-300 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
              <Badge tone={statusTone(statusLabel(course.status))} dot>
                {statusLabel(course.status)}
              </Badge>
            </div>
          </div>

          <h3 className="mt-4 text-base font-medium text-stone-900 [font-family:var(--font-display)]">
            {title}
          </h3>
          {course.description && (
            <p className="mt-1 line-clamp-2 text-sm text-stone-500">{course.description}</p>
          )}

          <div className="mt-auto flex items-center gap-2 pt-4 text-xs text-stone-400">
            {course.level && (
              <>
                <span className="capitalize">{course.level}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span>Edited {editedAt(course.updated_at)}</span>
            <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
              Open <ArrowRight className="size-3.5" />
            </span>
          </div>
        </Card>
      </Link>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`del-${course.id}`}
        >
          <div
            className="absolute inset-0 bg-stone-900/30 backdrop-blur-[1px]"
            onClick={() => !isPending && setConfirmOpen(false)}
          />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-[0_24px_60px_rgba(68,48,28,0.18)]">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600">
                <AlertTriangle className="size-5" />
              </span>
              <div>
                <h2 id={`del-${course.id}`} className="text-base font-semibold text-stone-900">
                  Delete this course?
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-stone-500">
                  This permanently deletes{" "}
                  <span className="font-medium text-stone-700">“{title}”</span> and
                  everything in it — all modules, lessons, slides, quizzes, and AI
                  conversations. This <span className="font-medium text-stone-700">can’t be undone</span>.
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={isPending}
                className="rounded-full px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-60"
              >
                {isPending ? (
                  "Deleting…"
                ) : (
                  <>
                    <Trash2 className="size-4" />
                    Delete course
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
