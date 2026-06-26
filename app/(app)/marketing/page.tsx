/**
 * Marketing hub (creator surface). Server-loads the author's current course, its
 * campaign, landing pages, and any staged/pending gate actions, then hands them
 * to the client hub. All mutations flow through the server actions → the shared
 * tool layer → the gate.
 */

import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { listPendingApprovals, listStagedActions } from "@/lib/marketing/gate";
import {
  listAuthorCourses,
  listLandingPages,
  loadCampaignForCourse,
  selectCourseForAuthor,
} from "@/lib/marketing/persistence";
import { MarketingHub, type ActionVM, type LandingPageVM } from "./MarketingHub";

export const dynamic = "force-dynamic";

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { course: preferCourse } = await searchParams;
  const course = await selectCourseForAuthor(supabase, user!.id, preferCourse);
  const courses = await listAuthorCourses(supabase, user!.id);

  if (!course) {
    return (
      <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
        <PageHeader
          title="Marketing Assistant"
          description="Creating the course is half the battle — let AI help you sell it."
        />
        <div className="rounded-2xl border border-stone-200/80 bg-white p-10 text-center shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <p className="text-stone-600">You don’t have a course yet.</p>
          <Link
            href="/studio"
            className="brand-gradient mt-4 inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-white"
          >
            Go to the Studio
          </Link>
        </div>
      </div>
    );
  }

  const campaign = await loadCampaignForCourse(supabase, course.id);
  const pages = campaign ? await listLandingPages(supabase, campaign.id) : [];
  const staged = await listStagedActions(supabase, course.id);
  const pending = await listPendingApprovals(supabase, course.id);

  const openTargetIds = new Set(
    [...staged, ...pending].filter((a) => a.targetRef?.entity === "landing_page").map((a) => a.targetRef!.id)
  );

  const toVM = (a: (typeof staged)[number]): ActionVM => ({
    id: a.id,
    actionKind: a.actionKind,
    summary: a.summary ?? a.actionKind,
    requestedBy: a.requestedBy,
  });

  const pageVms: LandingPageVM[] = pages.map((p) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    sectionCount: p.sections.length,
    hasOpenAction: openTargetIds.has(p.id),
  }));

  return (
    <MarketingHub
      courseId={course.id}
      courseTitle={course.title}
      campaignName={campaign?.name ?? null}
      campaignStatus={campaign?.status ?? null}
      pages={pageVms}
      staged={staged.map(toVM)}
      pending={pending.map(toVM)}
      courses={courses}
    />
  );
}
