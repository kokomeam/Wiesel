/**
 * /my-courses — every enrollment (my_learning RPC v2), filterable client-side
 * (All / In progress / Completed). Unpublished courses (is_live === false)
 * render as unlinked "No longer available" cards — the enrollment and
 * progress survive an unpublish, so we show them honestly instead of
 * vanishing them.
 */

import Link from "next/link";
import { Compass } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { MyCoursesList } from "@/components/student/MyCoursesList";

export const dynamic = "force-dynamic";

export default async function MyCoursesPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_learning");
  const courses = data ?? [];

  return (
    <div
      className="paper-glow mx-auto w-full max-w-6xl px-6 py-8"
      style={{ "--glow-color": "rgba(125,211,252,0.25)" } as React.CSSProperties}
    >
      <PageHeader
        eyebrow="Your library"
        tone="learn"
        title="My courses"
        description="Everything you're enrolled in, in one place."
      />

      <div className="mt-8">
        {error ? (
          <Card className="border-amber-200 bg-amber-50/60 p-5">
            <p className="text-sm font-medium text-amber-800">
              Couldn&apos;t load your courses
            </p>
            <p className="mt-1 text-sm text-amber-700">
              Something went wrong on our side. Refresh the page to try again.
            </p>
          </Card>
        ) : courses.length === 0 ? (
          <Card className="flex flex-col items-center gap-4 px-6 py-16 text-center">
            <div className="learn-gradient grid size-12 place-items-center rounded-2xl text-white">
              <Compass className="size-6" aria-hidden />
            </div>
            <h2 className="text-2xl [font-family:var(--font-display)] font-light text-stone-900">
              No courses yet
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-stone-500">
              When you enroll in a course it lives here — with your progress,
              a Continue button, and a celebration when you finish.
            </p>
            <Link
              href="/explore"
              className="learn-gradient mt-1 rounded-full px-6 py-2.5 text-sm font-medium text-white shadow-sm shadow-learn-600/25 hover:opacity-95"
            >
              Explore courses
            </Link>
          </Card>
        ) : (
          <MyCoursesList courses={courses} />
        )}
      </div>
    </div>
  );
}
