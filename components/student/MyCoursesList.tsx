"use client";

/**
 * /my-courses — client filter chips (All / In progress / Completed) over the
 * server-fetched my_learning rows, rendered with the shared MyLearningCard
 * (learn tone). Filtering is presentation-only, so it stays client-side; the
 * data never refetches.
 */

import { useState } from "react";
import Link from "next/link";
import { Compass } from "lucide-react";
import { cn } from "@/lib/cn";
import { MyLearningCard, type MyLearningCardData } from "@/components/learn/CourseCards";

type Filter = "all" | "in_progress" | "completed";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "in_progress", label: "In progress" },
  { id: "completed", label: "Completed" },
];

function matches(course: MyLearningCardData, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "completed") return course.enrollment_status === "completed";
  return course.enrollment_status !== "completed";
}

export function MyCoursesList({ courses }: { courses: MyLearningCardData[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = courses.filter((course) => matches(course, filter));

  return (
    <div>
      <div role="group" aria-label="Filter courses" className="flex flex-wrap gap-2">
        {FILTERS.map(({ id, label }) => {
          const count = courses.filter((c) => matches(c, id)).length;
          const active = filter === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-learn-500/40",
                active
                  ? "learn-gradient border-transparent text-white shadow-sm shadow-learn-600/25"
                  : "border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50"
              )}
            >
              {label}
              <span
                className={cn(
                  "rounded-full px-1.5 py-px text-[10px] tabular-nums",
                  active ? "bg-white/20 text-white" : "bg-stone-100 text-stone-500"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-stone-200/80 bg-white px-6 py-14 text-center shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <Compass className="size-7 text-stone-300" aria-hidden />
          <p className="text-sm font-medium text-stone-700">
            {filter === "completed"
              ? "No completed courses yet"
              : "Nothing in progress right now"}
          </p>
          <p className="max-w-sm text-sm text-stone-500">
            {filter === "completed"
              ? "Finish a course and it will land here with a celebration."
              : "Pick something new to learn and it will show up here."}
          </p>
          <Link
            href="/explore"
            className="learn-gradient mt-1 rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-learn-600/25 hover:opacity-95"
          >
            Explore courses
          </Link>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((course) => (
            <MyLearningCard key={course.enrollment_id} course={course} tone="learn" />
          ))}
        </div>
      )}
    </div>
  );
}
