/**
 * /analytics — the analytics COURSE PICKER (real since Milestone 4; this page
 * was a mock until then). Lists the author's courses with live-version +
 * learner counts; each card opens that course's dashboard at
 * /studio/[courseId]/analytics. The dashboard itself reads rollups — this
 * picker reads only small indexed tables.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, BarChart3, BookOpen, Users } from "lucide-react";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AnalyticsPickerPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirectTo=/analytics");

  const { data: courses, error } = await supabase
    .from("courses")
    .select("id, title, description, status, updated_at")
    .eq("author_id", user.id)
    .order("updated_at", { ascending: false });
  if (error) throw error;

  const courseIds = (courses ?? []).map((c) => c.id);
  const [pubs, enrollments] =
    courseIds.length > 0
      ? await Promise.all([
          supabase
            .from("course_publications")
            .select("course_id, version")
            .in("course_id", courseIds)
            .eq("status", "live"),
          supabase
            .from("enrollments")
            .select("course_id")
            .in("course_id", courseIds),
        ])
      : [{ data: [] }, { data: [] }];

  const liveVersion = new Map(
    (pubs.data ?? []).map((p) => [p.course_id, p.version])
  );
  const learnerCounts = new Map<string, number>();
  for (const row of enrollments.data ?? []) {
    learnerCounts.set(row.course_id, (learnerCounts.get(row.course_id) ?? 0) + 1);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title="Analytics"
        description="Pick a course to see its learner funnel, content health, roster, and stuck queue."
      />

      {(courses ?? []).length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No courses yet"
          hint="Create a course in the studio, publish it, and learner analytics appear here."
          action={
            <Link
              href="/studio"
              className="brand-gradient mt-1 rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
            >
              Open Creator Studio
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {(courses ?? []).map((course) => {
            const version = liveVersion.get(course.id);
            const learners = learnerCounts.get(course.id) ?? 0;
            const title = course.title || "Untitled course";
            return (
              <Link
                key={course.id}
                href={`/studio/${course.id}/analytics`}
                className="group block focus:outline-none"
              >
                <Card className="flex h-full flex-col p-5 transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[0_8px_24px_rgba(68,48,28,0.08)] group-focus-visible:ring-2 group-focus-visible:ring-brand-300">
                  <div className="flex items-start justify-between gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                      <BarChart3 className="size-5" aria-hidden />
                    </span>
                    {version !== undefined ? (
                      <Badge tone="green" dot>
                        Live v{version}
                      </Badge>
                    ) : (
                      <Badge tone="amber" dot>
                        Draft
                      </Badge>
                    )}
                  </div>

                  <h3 className="mt-4 text-base font-medium text-stone-900 [font-family:var(--font-display)]">
                    {title}
                  </h3>
                  {course.description ? (
                    <p className="mt-1 line-clamp-2 text-sm text-stone-500">
                      {course.description}
                    </p>
                  ) : null}

                  <div className="mt-auto flex items-center gap-2 pt-4 text-xs text-stone-400">
                    <Users className="size-3.5" aria-hidden />
                    <span>
                      {learners} learner{learners === 1 ? "" : "s"}
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100">
                      View analytics <ArrowRight className="size-3.5" aria-hidden />
                    </span>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
