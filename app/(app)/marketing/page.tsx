/**
 * Marketing hub (creator surface). Server-loads the author's current course,
 * its campaign, landing pages, the approval inbox (pending irreversible
 * actions WITH live previews), the agent's open clarifying questions, the
 * quiet activity log (revertable reversible changes + policy-executed
 * actions), and the autonomy settings — then hands them to the client hub.
 * All mutations flow through the server actions → the shared tool layer →
 * the gate.
 */

import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { parseAutonomyDecision } from "@/lib/marketing/autonomy";
import { loadAutonomySettings } from "@/lib/marketing/autonomyStore";
import { getBlueprint } from "@/lib/marketing/blueprints";
import { listPendingApprovals, listRecentActivity } from "@/lib/marketing/gate";
import {
  listAuthorCourses,
  listLandingPages,
  loadCampaignForCourse,
  loadSequencesOverview,
  selectCourseForAuthor,
} from "@/lib/marketing/persistence";
import { listPendingQuestions } from "@/lib/marketing/questions";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { getMarketingTool, previewMarketingAction } from "@/lib/marketing/tools";
import type { ActivityEntryVM } from "@/components/marketing/ActivityLogEntry";
import type { CampaignVM } from "@/components/marketing/CampaignCard";
import type { PendingActionPayload } from "./actions";
import { MarketingHub, type LandingPageVM, type QuestionVM } from "./MarketingHub";

export const dynamic = "force-dynamic";

function revertLabel(expiresAt: string | null, nowMs: number): { canRevert: boolean; label: string | null } {
  if (!expiresAt) return { canRevert: false, label: null };
  const left = new Date(expiresAt).getTime() - nowMs;
  if (left <= 0) return { canRevert: false, label: null };
  const hours = Math.floor(left / 3_600_000);
  const label = hours >= 1 ? `${hours}h left` : `${Math.max(1, Math.floor(left / 60_000))}m left`;
  return { canRevert: true, label };
}

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

  const services = createMarketingServices();
  const [campaign, pending, questions, activity, autonomy] = await Promise.all([
    loadCampaignForCourse(supabase, course.id),
    listPendingApprovals(supabase, course.id),
    listPendingQuestions(supabase, course.id),
    listRecentActivity(supabase, course.id, { limit: 15 }),
    loadAutonomySettings(supabase, course.id),
  ]);
  const pages = campaign ? await listLandingPages(supabase, campaign.id) : [];

  // Only PENDING approvals gate a page's Publish/Unpublish buttons — a staged
  // reversible row is a quiet, revertable log entry, not an open request.
  const openTargetIds = new Set(
    pending.filter((a) => a.targetRef?.entity === "landing_page").map((a) => a.targetRef!.id)
  );

  // Live, truthful previews for the one-card inbox (never persisted — counts
  // must reflect the CURRENT audience, not the moment of the request).
  const pendingVms: PendingActionPayload[] = await Promise.all(
    pending.map(async (a) => ({
      actionId: a.id,
      toolName: a.toolName,
      summary: a.summary ?? a.actionKind,
      preview: await previewMarketingAction(a, { supabase, ownerId: user!.id, services }),
      editableParams: getMarketingTool(a.toolName)?.editableParams ?? null,
      requestedBy: a.requestedBy,
    }))
  );

  const questionVms: QuestionVM[] = questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options,
  }));

  const nowMs = services.clock.epochMs();
  const activityVms: ActivityEntryVM[] = activity.map((a) => {
    const autoExecuted = a.status === "executed" && a.autonomyDecision != null;
    const { canRevert, label } = autoExecuted
      ? { canRevert: false, label: null }
      : revertLabel(a.revertExpiresAt, nowMs);
    return {
      id: a.id,
      actionKind: a.actionKind,
      summary: a.summary ?? a.actionKind,
      requestedBy: a.requestedBy,
      canRevert,
      revertWindowLabel: label,
      autoExecuted,
      autoReason: autoExecuted ? (parseAutonomyDecision(a.autonomyDecision)?.reason ?? null) : null,
    };
  });

  const pageVms: LandingPageVM[] = pages.map((p) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    sectionCount: p.sections.length,
    hasOpenAction: openTargetIds.has(p.id),
  }));

  // The campaign card: status + delivery at a glance + lifecycle controls.
  let campaignVm: CampaignVM | null = null;
  if (campaign) {
    const sequences = await loadSequencesOverview(supabase, campaign.id);
    const counts = sequences
      .flatMap((s) => s.touches)
      .reduce((acc, t) => ({ queued: acc.queued + (t.queued ?? 0), sent: acc.sent + (t.sent ?? 0) }), {
        queued: 0,
        sent: 0,
      });
    const blueprintKey = (campaign.config as { blueprintKey?: string }).blueprintKey ?? campaign.goal;
    const autoPause = (campaign.config as {
      autoPauseReason?: { metric: string; value: number; threshold: number };
    }).autoPauseReason;
    campaignVm = {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      goalLabel: blueprintKey ? (getBlueprint(blueprintKey)?.label ?? blueprintKey) : null,
      queued: counts.queued,
      sent: counts.sent,
      sequenceCount: sequences.length,
      autoPause: campaign.status === "paused" && autoPause ? autoPause : null,
    };
  }

  return (
    <MarketingHub
      courseId={course.id}
      courseTitle={course.title}
      campaign={campaignVm}
      pages={pageVms}
      pending={pendingVms}
      questions={questionVms}
      activity={activityVms}
      autonomy={autonomy}
      courses={courses}
    />
  );
}
