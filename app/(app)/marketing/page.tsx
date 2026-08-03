/**
 * Marketing hub (creator surface). Server-loads the author's current course,
 * its campaign, landing pages, the approval inbox (pending irreversible
 * actions), the agent's open clarifying questions, the quiet activity log
 * (revertable reversible changes + policy-executed actions), and the autonomy
 * settings — then hands them to the client hub. All mutations flow through
 * the server actions → the shared tool layer → the gate.
 *
 * PERF-1 C1: everything above rides ONE SECURITY DEFINER bundle RPC
 * (lib/marketing/hubLoader.ts → public.marketing_hub_bundle) after a course
 * resolution that's request-shared with the marketing layout (react cache()),
 * replacing the old 6 sequential waves (~24 round trips). The per-approval
 * LIVE previews — the slow tail, each one re-executes its tool so counts stay
 * truthful to CURRENT state — are built WITHOUT awaiting and stream into the
 * already-rendered cards (each ApprovalCard preview slot resolves the shared promise with use()).
 */

import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { parseAutonomyDecision } from "@/lib/marketing/autonomy";
import { getBlueprint } from "@/lib/marketing/blueprints";
import { loadMarketingHub } from "@/lib/marketing/hubLoader";
import { selectCourseForAuthorCached } from "@/lib/marketing/persistence";
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

function NoCourseYet() {
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

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const supabase = await createClient();
  const user = await getSessionUser();

  const { course: preferCourse } = await searchParams;
  // Shared with the marketing layout's AgentDock resolution: with no ?course=
  // both calls collapse to one query (react cache() keys on the exact args,
  // hence the ?? null normalization).
  const course = await selectCourseForAuthorCached(supabase, user!.id, preferCourse ?? null);
  if (!course) return <NoCourseYet />;

  // Round trip 2 of 2: the whole hub shell in one author-gated bundle RPC.
  const hub = await loadMarketingHub(supabase, course.id);
  if (!hub) return <NoCourseYet />;

  const services = createMarketingServices();
  const pending = hub.pendingApprovals;

  // Only PENDING approvals gate a page's Publish/Unpublish buttons — a staged
  // reversible row is a quiet, revertable log entry, not an open request.
  const openTargetIds = new Set(
    pending.filter((a) => a.targetRef?.entity === "landing_page").map((a) => a.targetRef!.id)
  );

  const pendingVms: PendingActionPayload[] = pending.map((a) => ({
    actionId: a.id,
    toolName: a.toolName,
    summary: a.summary ?? a.actionKind,
    preview: null,
    editableParams: getMarketingTool(a.toolName)?.editableParams ?? null,
    requestedBy: a.requestedBy,
  }));

  // Live, truthful previews for the one-card inbox (never persisted — counts
  // must reflect the CURRENT audience, not the moment of the request). Built
  // WITHOUT awaiting: the promise streams into the rendered cards; deny /
  // approve never wait on it (previewMarketingAction never rejects — a failed
  // preview resolves null and the card degrades to its stored summary).
  const previews: Promise<(Record<string, unknown> | null)[]> = Promise.all(
    pending.map((a) =>
      previewMarketingAction(
        { toolName: a.toolName, params: a.params, courseId: course.id, campaignId: a.campaignId },
        { supabase, ownerId: user!.id, services }
      )
    )
  );

  const questionVms: QuestionVM[] = hub.pendingQuestions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options,
  }));

  const nowMs = services.clock.epochMs();
  const activityVms: ActivityEntryVM[] = hub.activity.map((a) => {
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

  const pageVms: LandingPageVM[] = hub.landingPages.map((p) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    sectionCount: p.sectionCount,
    hasOpenAction: openTargetIds.has(p.id),
  }));

  // The campaign card: status + delivery at a glance + lifecycle controls.
  let campaignVm: CampaignVM | null = null;
  if (hub.campaign) {
    const blueprintKey = hub.campaign.blueprintKey ?? hub.campaign.goal;
    campaignVm = {
      id: hub.campaign.id,
      name: hub.campaign.name,
      status: hub.campaign.status,
      goalLabel: blueprintKey ? (getBlueprint(blueprintKey)?.label ?? blueprintKey) : null,
      queued: hub.sequencesOverview.queued,
      sent: hub.sequencesOverview.sent,
      sequenceCount: hub.sequencesOverview.sequenceCount,
      autoPause:
        hub.campaign.status === "paused" && hub.campaign.autoPauseReason
          ? hub.campaign.autoPauseReason
          : null,
    };
  }

  return (
    <MarketingHub
      courseId={course.id}
      courseTitle={course.title}
      campaign={campaignVm}
      pages={pageVms}
      pending={pendingVms}
      previews={previews}
      questions={questionVms}
      activity={activityVms}
      autonomy={hub.autonomy}
      courses={hub.courses}
    />
  );
}
