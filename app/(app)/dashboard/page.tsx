/**
 * /dashboard — the creator command center (rebuilt on REAL data 2026-07-08;
 * the old page rendered lib/data.ts mocks).
 *
 * Server component. Data transport is ONE `creator_dashboard()` definer RPC
 * (PERF-1 C1 — replaces the old 3-wave, 10-query PostgREST fan-out) plus at
 * most one cached-snapshot read for the spotlight funnel's lesson titles; see
 * lib/analytics/creatorHomeLoader.ts. All math lives in
 * lib/analytics/creatorHome.ts (pure, verified by
 * scripts/verify-creator-home.ts).
 *
 * Honesty rules: no lib/data.ts, no fake deltas (no history data exists), no
 * revenue numbers (Stripe unbuilt — RevenueCard says so), em-dashes where
 * data hasn't arrived yet.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, CheckCircle2, Plus, Users } from "lucide-react";
import { createNewCourse } from "@/app/(app)/studio/actions";
import { AttentionRail, type DraftGroup } from "@/components/dashboard/AttentionRail";
import { CourseHealthCard } from "@/components/dashboard/CourseHealthCard";
import { CreatorIdentityHeader } from "@/components/dashboard/CreatorIdentityHeader";
import {
  FunnelEmptyCard,
  FunnelSnapshotCard,
} from "@/components/dashboard/FunnelSnapshotCard";
import { OnboardingHero } from "@/components/dashboard/OnboardingHero";
import { RatingStat } from "@/components/dashboard/RatingStat";
import { RevenueCard } from "@/components/dashboard/RevenueCard";
import { Button } from "@/components/ui/Button";
import { Stat } from "@/components/ui/Stat";
import {
  funnelSummary,
  parseAttentionFindings,
  portfolioTotals,
  type FunnelSummary,
} from "@/lib/analytics/creatorHome";
import {
  healthFromDashboardCourses,
  loadCreatorDashboard,
} from "@/lib/analytics/creatorHomeLoader";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?redirectTo=/dashboard");
  const supabase = await createClient();

  const dash = await loadCreatorDashboard(supabase);

  // DISPLAY fallback only (h1/initial) — the band edits the RAW value, so an
  // email prefix is never silently persisted into world-readable
  // profiles.display_name (an empty editor field forces an explicit name).
  const displayNameFallback =
    dash.profile?.display_name?.trim() || user.email?.split("@")[0] || "there";

  // The identity band edits these in place (a row missing headline/bio reads
  // as "", which renders the ghost prompts).
  const identityInitial = {
    displayName: dash.profile?.display_name?.trim() ?? "",
    headline: dash.profile?.headline ?? "",
    bio: dash.profile?.bio ?? "",
    avatarUrl: dash.profile?.avatar_url ?? null,
  };

  const headerActions = (
    <>
      <Link
        href="/studio"
        className="inline-flex h-9 items-center rounded-full border border-stone-300/80 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        Open studio
      </Link>
      <form action={createNewCourse}>
        <Button type="submit">
          <Plus className="size-4" aria-hidden />
          New Course
        </Button>
      </form>
    </>
  );

  if (dash.courses.length === 0) {
    return (
      <div className="paper-glow mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
        <CreatorIdentityHeader
          userId={user.id}
          initial={identityInitial}
          displayNameFallback={displayNameFallback}
          actions={headerActions}
        />
        <OnboardingHero />
      </div>
    );
  }

  const health = healthFromDashboardCourses(dash.courses);
  const totals = portfolioTotals(health);
  const attention = parseAttentionFindings(dash.attentionFindings, 5);
  const courseTitles = Object.fromEntries(health.map((h) => [h.id, h.title]));
  const draftGroups: DraftGroup[] = health
    .filter((h) => h.draftMessages > 0)
    .map((h) => ({ courseId: h.id, courseTitle: h.title, count: h.draftMessages }));

  // Spotlight (SQL mirror of pickSpotlightCourse — see the RPC migration):
  // the funnel card renders only when its rollup actually has rows.
  const spot = dash.spotlight;
  const spotlightHealth = spot ? (health.find((h) => h.id === spot.course_id) ?? null) : null;
  const funnel: FunnelSummary | null =
    spot && spot.funnel.length > 0 ? funnelSummary(spot.funnel) : null;
  const lessonTitles = dash.lessonTitles;

  const plural = (n: number) => (n === 1 ? "" : "s");

  return (
    <div className="paper-glow mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <CreatorIdentityHeader
        userId={user.id}
        initial={identityInitial}
        displayNameFallback={displayNameFallback}
        actions={headerActions}
      />

      {/* Portfolio stats — no fake deltas: there's no history data yet. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={Users}
          tone="brand"
          label="Total learners"
          value={totals.learners.toLocaleString("en-US")}
          sub={
            totals.learners > 0
              ? `Enrolled across ${totals.courses} course${plural(totals.courses)}`
              : "Enrollments appear once a course is live"
          }
        />
        <Stat
          icon={CheckCircle2}
          tone="emerald"
          label="Completion rate"
          value={
            totals.completionRatePct !== null ? `${totals.completionRatePct}%` : "—"
          }
          sub={
            totals.completionRatePct !== null
              ? `${totals.completedLearners} of ${totals.learners} enrolled learners finished`
              : "No enrollments yet"
          }
        />
        <RatingStat avgRating={totals.avgRating} reviewCount={totals.reviewCount} />
        <Stat
          icon={AlertTriangle}
          tone="amber"
          label="Open AI findings"
          value={String(totals.openFindings)}
          sub={
            totals.openFindings > 0
              ? `Across ${totals.coursesWithFindings} course${plural(totals.coursesWithFindings)}`
              : "Nothing flagged right now"
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section aria-labelledby="your-courses-heading" className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-brand-700">
                  Your courses
                </p>
                <h2
                  id="your-courses-heading"
                  className="mt-1 text-lg font-light text-stone-900 [font-family:var(--font-display)]"
                >
                  Course health
                </h2>
              </div>
              <span className="text-xs text-stone-400">
                {totals.liveCourses} live · {totals.courses} total
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {health.map((course) => (
                <CourseHealthCard key={course.id} course={course} />
              ))}
            </div>
          </section>

          {spotlightHealth && funnel ? (
            <FunnelSnapshotCard
              course={spotlightHealth}
              summary={funnel}
              lessonTitles={lessonTitles}
            />
          ) : (
            <FunnelEmptyCard />
          )}
        </div>

        <div className="space-y-6">
          <AttentionRail
            findings={attention}
            drafts={draftGroups}
            courseTitles={courseTitles}
          />
          <RevenueCard />
        </div>
      </div>
    </div>
  );
}
