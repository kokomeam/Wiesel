/**
 * /studio/[courseId]/analytics — the creator analytics dashboard (Milestone 4).
 * Server component: author-gated, reads ROLLUPS + the two definer RPCs (never
 * raw event scans), renders four tabs (?tab= keeps each server-rendered and
 * deep-linkable). A course with no live publication gets a first-class empty
 * state — analytics only exist for published versions.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BarChart3, PencilLine } from "lucide-react";
import { loadCourseAnalytics, buildSnapshotMaps } from "@/lib/analytics/dashboard";
import { getLivePublicationByCourse, parsePublicationSnapshot } from "@/lib/learn/resolve";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { ContentHealthTab } from "@/components/studio/analytics/ContentHealthTab";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { LearnersTab } from "@/components/studio/analytics/LearnersTab";
import { OverviewTab } from "@/components/studio/analytics/OverviewTab";
import { RefreshButton } from "@/components/studio/analytics/RefreshButton";
import { StuckQueueTab } from "@/components/studio/analytics/StuckQueueTab";
import { timeAgo } from "@/components/studio/analytics/format";
import { cn } from "@/lib/cn";
import { refreshCourseAnalytics } from "./actions";

export const dynamic = "force-dynamic";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "content", label: "Content health" },
  { id: "learners", label: "Learners" },
  { id: "stuck", label: "Stuck queue" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default async function CourseAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { courseId } = await params;
  const { tab: rawTab } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirectTo=/studio/${courseId}/analytics`);

  // Author gate (RLS on every table backs this up; the explicit check gives a
  // clean 404 instead of an empty dashboard for non-authors).
  const course = await supabase
    .from("courses")
    .select("id, title, author_id")
    .eq("id", courseId)
    .maybeSingle();
  if (course.error) throw course.error;
  if (!course.data || course.data.author_id !== user.id) notFound();

  const publication = await getLivePublicationByCourse(supabase, courseId);

  if (!publication) {
    return (
      <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
        <PageHeader
          title={`${course.data.title} — Analytics`}
          description="Learner analytics for the live version of this course."
        />
        <EmptyState
          icon={BarChart3}
          title="Publish to start collecting analytics"
          hint="Analytics track the LIVE version learners actually see. Publish this course and data starts flowing the moment your first student opens a lesson."
          action={
            <Link
              href={`/studio?course=${courseId}`}
              className="brand-gradient mt-1 rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
            >
              Open in the studio
            </Link>
          }
        />
      </div>
    );
  }

  const snapshot = parsePublicationSnapshot(publication);
  const maps = buildSnapshotMaps(snapshot);
  const [analytics, optOutRows, creatorProfile] = await Promise.all([
    loadCourseAnalytics(supabase, courseId, publication.id),
    // Opt-out flags for the Stuck queue's Draft follow-up (the send seam
    // re-checks these server-side at send time regardless).
    supabase.from("enrollments").select("user_id, comms_opt_out").eq("course_id", courseId),
    supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
  ]);
  const optOutByUser: Record<string, boolean> = {};
  for (const row of optOutRows.data ?? []) optOutByUser[row.user_id] = row.comms_opt_out;

  const tab: TabId = TABS.some((t) => t.id === rawTab) ? (rawTab as TabId) : "overview";
  const stuckCount = new Set(analytics.flags.map((f) => f.user_id)).size;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      <PageHeader
        title={`${course.data.title} — Analytics`}
        description={`Live version v${publication.version} · rollups ${
          analytics.computedAt ? `refreshed ${timeAgo(analytics.computedAt)}` : "not computed yet"
        }`}
        actions={
          <>
            <RefreshButton action={refreshCourseAnalytics.bind(null, courseId)} />
            <Link
              href={`/studio?course=${courseId}`}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-200 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
            >
              <PencilLine className="size-4 text-stone-400" aria-hidden />
              Edit course
            </Link>
          </>
        }
      />

      {/* ── Tab nav (?tab= — server-rendered, deep-linkable) ── */}
      <nav className="flex flex-wrap gap-1 border-b border-stone-200/80" aria-label="Analytics sections">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/studio/${courseId}/analytics${t.id === "overview" ? "" : `?tab=${t.id}`}`}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              tab === t.id
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800"
            )}
          >
            {t.label}
            {t.id === "stuck" && stuckCount > 0 ? (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                {stuckCount}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        <OverviewTab
          analytics={analytics}
          slug={publication.slug}
          lessonTitles={maps.lessonTitles}
        />
      ) : tab === "content" ? (
        <ContentHealthTab analytics={analytics} maps={maps} courseId={courseId} />
      ) : tab === "learners" ? (
        <LearnersTab roster={analytics.roster} courseId={courseId} slug={publication.slug} />
      ) : (
        <StuckQueueTab
          analytics={analytics}
          maps={maps}
          courseId={courseId}
          slug={publication.slug}
          courseTitle={course.data.title || "your course"}
          creatorName={creatorProfile.data?.display_name ?? "Your course creator"}
          optOutByUser={optOutByUser}
        />
      )}
    </div>
  );
}
