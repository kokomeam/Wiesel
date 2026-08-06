/**
 * /studio/[courseId]/tutor — the Creator Tutor Console (TUTOR-1 Wave 5).
 * Server component, author-gated via ONE definer bundle RPC per tab (the
 * analytics-page recipe). Four tabs (?tab= keeps each server-rendered +
 * deep-linkable): Overview / Enablement & charter / Concept graph / Analytics.
 *
 * P5.1 owns this shell and wires all four tab components. Overview + charter load
 * through loadTutorConsole (tutor_console_bundle); graph + analytics tabs ship as
 * placeholders (their own components own their data — P5.2/P5.3 fill their bodies
 * without touching this file). A null bundle (non-author / missing course) → 404.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { GraduationCap, PencilLine } from "lucide-react";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { loadTutorConsole, type TutorConsoleTab } from "@/lib/studio/tutorConsole";
import { PageHeader } from "@/components/ui/PageHeader";
import { OverviewTutorTab } from "@/components/studio/tutor/OverviewTutorTab";
import { CharterTab } from "@/components/studio/tutor/CharterTab";
import { GraphTab } from "@/components/studio/tutor/GraphTab";
import { AnalyticsTutorTab } from "@/components/studio/tutor/AnalyticsTutorTab";
import { EscalationQueueTab } from "@/components/studio/tutor/EscalationQueueTab";
import { escalationsUiEnabled } from "@/lib/tutor/flags";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";

/** All possible tab ids. `escalations` is FLAG-GATED — it only appears in the nav
 *  (and only routes) when escalationsUiEnabled() (the OverviewTab badge-gating
 *  match); with the flag off the tab is absent everywhere and its ?tab= falls back
 *  to overview. */
type TabId = "overview" | "charter" | "graph" | "analytics" | "escalations";

const ALL_TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "charter", label: "Enablement & charter" },
  { id: "graph", label: "Concept graph" },
  { id: "analytics", label: "Analytics" },
  // Escalations is appended LAST, and only when the flag is on (see visibleTabs).
  { id: "escalations", label: "Escalations" },
];

/** Overview + charter load through the bundle RPC; graph + analytics + escalations
 *  own their own author-gated RPCs (BUNDLE_TABS[x] = null → the charter bundle
 *  loads just to author-gate the render). */
const BUNDLE_TABS: Record<TabId, TutorConsoleTab | null> = {
  overview: "overview",
  charter: "charter",
  graph: null,
  analytics: null,
  escalations: null,
};

export default async function TutorConsolePage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { courseId } = await params;
  const { tab: rawTab } = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect(`/login?redirectTo=/studio/${courseId}/tutor`);

  // The visible tab set — escalations is appended only when the flag is on.
  const escalationsOn = escalationsUiEnabled();
  const visibleTabs = escalationsOn
    ? ALL_TABS
    : ALL_TABS.filter((t) => t.id !== "escalations");

  const tab: TabId = visibleTabs.some((t) => t.id === rawTab)
    ? (rawTab as TabId)
    : "overview";

  // ONE round trip: the bundle RPC authorizes internally (null → 404). Graph +
  // analytics tabs still need the author gate, so they load the enablement-only
  // bundle (via the charter tab shape) to 404 a non-author before rendering.
  const bundleTab = BUNDLE_TABS[tab] ?? "charter";
  const supabase = await createClient();
  const bundle = await loadTutorConsole(supabase, courseId, bundleTab);
  if (!bundle) notFound();

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      <PageHeader
        eyebrow="Tutor console"
        title="AI tutor"
        description={`Enable, tune, and monitor the course-grounded tutor learners use in ${
          bundle.course.title || "this course"
        }.`}
        actions={
          <>
            <span className="hidden items-center gap-2 rounded-full border border-stone-200 bg-white px-3.5 py-2 text-sm text-stone-600 sm:inline-flex">
              <GraduationCap className="size-4 text-brand-500" aria-hidden />
              <span className="max-w-[16rem] truncate font-medium text-stone-800">
                {bundle.course.title || "Untitled course"}
              </span>
            </span>
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
      <nav className="flex flex-wrap gap-1 border-b border-stone-200/80" aria-label="Tutor sections">
        {visibleTabs.map((t) => (
          <Link
            key={t.id}
            href={`/studio/${courseId}/tutor${t.id === "overview" ? "" : `?tab=${t.id}`}`}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              tab === t.id
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-stone-600 hover:border-stone-300 hover:text-stone-900"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        <OverviewTutorTab courseId={courseId} bundle={bundle} />
      ) : tab === "charter" ? (
        <CharterTab
          courseId={courseId}
          charter={bundle.enablement.charter}
          versions={bundle.enablement.charterVersions}
        />
      ) : tab === "graph" ? (
        <GraphTab courseId={courseId} />
      ) : tab === "analytics" ? (
        <AnalyticsTutorTab courseId={courseId} />
      ) : (
        <EscalationQueueTab courseId={courseId} />
      )}
    </div>
  );
}
