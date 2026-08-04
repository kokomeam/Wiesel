/**
 * TutorEntryCard — the /home right-rail tutor entry (TUTOR-1 W4.3).
 *
 * SERVER component: pure presentation over the data lib/learn/tutorHome.ts
 * resolves — no client JS, interactions are plain <Link>s whose ?tutor=open
 * (and ?seed=) deep links TutorMount consumes on the /learn pages. Replaces
 * the old offline preview panel: every affordance here opens the REAL
 * tutor, grounded in a course whose creator enabled it. Courses whose tutor
 * is disabled were already filtered out server-side (honest-by-construction:
 * no teaser); with zero entries this exports null so the parent slot
 * collapses entirely.
 */

import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import type { TutorHomeEntry } from "@/lib/learn/tutorHome";

/** The rail shows at most this many courses (newest-activity first upstream). */
const MAX_COURSES = 3;

export function TutorEntryCard({
  entries,
  className,
}: {
  entries: readonly TutorHomeEntry[];
  className?: string;
}) {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, MAX_COURSES);

  return (
    <Card
      data-ai-component="home-tutor-entry"
      className={cn("overflow-hidden", className)}
    >
      {/* Header — portal style: mono eyebrow + serif title. */}
      <div className="flex items-center gap-3 border-b border-stone-100 bg-gradient-to-r from-learn-50/60 to-white px-5 py-4">
        <div className="learn-gradient grid size-9 shrink-0 place-items-center rounded-full text-white">
          <GraduationCap className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="eyebrow text-learn-700">Ask anything</p>
          <h2 className="mt-0.5 text-lg leading-tight [font-family:var(--font-display)] font-light text-stone-900">
            Your tutor
          </h2>
        </div>
      </div>

      <ul className="divide-y divide-stone-100">
        {shown.map((entry) => (
          <li key={entry.courseId} className="px-5 py-4">
            <p className="truncate text-sm font-medium text-stone-800">
              {entry.title}
            </p>
            {entry.lastTurn ? (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-stone-500">
                <span className="font-semibold text-stone-600">
                  {entry.lastTurn.role === "learner" ? "You: " : "Tutor: "}
                </span>
                {entry.lastTurn.content}
              </p>
            ) : (
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                Ask your first question — answers come from this course&apos;s
                own lessons.
              </p>
            )}
            <Link
              href={entry.deepLink}
              data-ai-tool="home-tutor-open"
              className="mt-3 inline-flex h-8 items-center rounded-full border border-learn-200 bg-learn-50 px-4 text-xs font-medium text-learn-800 transition-colors hover:bg-learn-100"
            >
              Open tutor
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
