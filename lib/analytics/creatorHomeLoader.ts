/**
 * /dashboard bundle loader (PERF-1 C1). ONE `creator_dashboard()` definer RPC
 * (migration 20260717100400) replaces the old 3-wave, 10-query PostgREST
 * fan-out (diagnosis §A2); the only other read is the spotlight publication's
 * IMMUTABLE snapshot via the forever-cache (lib/learn/publicationCache.ts) —
 * lesson titles only, cold-cache only. Total: ≤2 data round trips per view.
 *
 * Zod-first: the payload types are INFERRED from the schemas below, which are
 * the consumer source of truth for the RPC's jsonb contract (the SQL comments
 * point back here). The supabase client is a PARAMETER so tests can inject a
 * counting client (AC-PERF-07); the snapshot loader is injectable for the
 * same reason.
 *
 * ALL math stays in lib/analytics/creatorHome.ts (pure, verified by
 * scripts/verify-creator-home.ts) — this module only fetches, validates, and
 * maps rows into the shapes those helpers consume.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  lessonTitlesFromSnapshot,
  type CourseHealth,
  type OpenFindingRow,
} from "@/lib/analytics/creatorHome";
import { getCachedSnapshot } from "@/lib/learn/publicationCache";
import { rpcJson } from "@/lib/supabase/rpcJson";

/* ────────────────────────── Payload schema (Zod-first) ───────────────────── */

/** The identity band's slice of the full profiles row the RPC returns
 *  (to_jsonb — extra columns are stripped here, missing optional columns in
 *  an exotic environment degrade to null, never throw). */
const DashboardProfileSchema = z.object({
  display_name: z.string().nullable().catch(null),
  headline: z.string().nullable().catch(null),
  bio: z.string().nullable().catch(null),
  avatar_url: z.string().nullable().catch(null),
});

const DashboardCourseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: z.string(),
  updated_at: z.string(),
  cover_image_url: z.string().nullable().catch(null),
  live_publication: z
    .object({ id: z.uuid(), version: z.number().int(), visibility: z.string() })
    .nullable(),
  /** ALL enrollment rows regardless of status — the "Total learners" count
   *  (dropped learners included, exactly like the old JS row count). */
  enrollments_total: z.number().int(),
  enrollments_active: z.number().int(),
  enrollments_completed: z.number().int(),
  avg_rating: z.number().nullable(),
  review_count: z.number().int(),
  open_findings: z.number().int(),
  draft_messages: z.number().int(),
});
export type DashboardCourse = z.infer<typeof DashboardCourseSchema>;

/** Shape-compatible with OpenFindingRow; `finding` stays raw jsonb — the
 *  defensive parse belongs to parseAttentionFindings, not the transport. */
const AttentionFindingRowSchema = z.object({
  id: z.uuid(),
  course_id: z.uuid(),
  finding: z.unknown(),
  created_at: z.string(),
});

const FunnelRowSchema = z.object({
  lesson_id: z.uuid(),
  lesson_order: z.number().int(),
  started_count: z.number().int(),
  completed_count: z.number().int(),
  dropoff_pct: z.number().nullable(),
});

export const CreatorDashboardPayloadSchema = z.object({
  profile: DashboardProfileSchema.nullable(),
  courses: z.array(DashboardCourseSchema),
  attention_findings: z.array(AttentionFindingRowSchema),
  open_findings_total: z.number().int(),
  spotlight: z
    .object({
      publication_id: z.uuid(),
      course_id: z.uuid(),
      funnel: z.array(FunnelRowSchema),
    })
    .nullable(),
});
export type CreatorDashboardPayload = z.infer<typeof CreatorDashboardPayloadSchema>;

/* ─────────────────────────── Payload → CourseHealth ──────────────────────── */

/** Map the RPC's pre-aggregated course rows into the CourseHealth shape every
 *  dashboard card + pure helper (portfolioTotals, pickSpotlightCourse)
 *  consumes — the same field-for-field rules as buildCourseHealth over raw
 *  rows (lib/analytics/creatorHome.ts). */
export function healthFromDashboardCourses(courses: DashboardCourse[]): CourseHealth[] {
  return courses.map((c) => ({
    id: c.id,
    title: c.title || "Untitled course",
    isLive: c.live_publication !== null,
    version: c.live_publication?.version ?? null,
    publicationId: c.live_publication?.id ?? null,
    learners: c.enrollments_total,
    completedLearners: c.enrollments_completed,
    // Same defensive guard as buildCourseHealth: a 0-count review rollup row
    // must never render a 0.00-star rating.
    avgRating: c.review_count > 0 ? c.avg_rating : null,
    reviewCount: c.review_count,
    openFindings: c.open_findings,
    draftMessages: c.draft_messages,
    updatedAt: c.updated_at,
    coverImageUrl: c.cover_image_url,
  }));
}

/* ────────────────────────────────── Loader ───────────────────────────────── */

export interface CreatorDashboardData {
  profile: CreatorDashboardPayload["profile"];
  courses: DashboardCourse[];
  /** Pre-ranked top 5 (SQL mirrors parseAttentionFindings' order); the page
   *  still runs parseAttentionFindings over them for the defensive parse. */
  attentionFindings: OpenFindingRow[];
  openFindingsTotal: number;
  spotlight: CreatorDashboardPayload["spotlight"];
  /** lessonId → title for the spotlight funnel labels; {} when there is no
   *  funnel or the snapshot degrades (the funnel then shows bare ids —
   *  exactly the old rowsOrEmpty behavior, never a 500). */
  lessonTitles: Record<string, string>;
}

type SnapshotLoader = (publicationId: string) => Promise<{ snapshot: unknown }>;

/**
 * getSessionUser → loadCreatorDashboard → render. One RPC round trip; the
 * spotlight snapshot (titles only) rides the immutable publication cache and
 * is skipped entirely when the funnel has no rows to label.
 */
export async function loadCreatorDashboard(
  supabase: SupabaseClient<Database>,
  loadSnapshot: SnapshotLoader = getCachedSnapshot
): Promise<CreatorDashboardData> {
  const payload = await rpcJson(
    supabase,
    "creator_dashboard",
    {},
    CreatorDashboardPayloadSchema
  );

  let lessonTitles: Record<string, string> = {};
  if (payload.spotlight && payload.spotlight.funnel.length > 0) {
    try {
      const { snapshot } = await loadSnapshot(payload.spotlight.publication_id);
      lessonTitles = Object.fromEntries(lessonTitlesFromSnapshot(snapshot));
    } catch (err) {
      // A malformed/missing snapshot degrades to id-less funnel labels — the
      // dashboard must never 500 over a label lookup (old-page semantics).
      console.warn(
        `[dashboard] spotlight snapshot degraded to empty titles: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    profile: payload.profile,
    courses: payload.courses,
    attentionFindings: payload.attention_findings.map((row) => ({
      id: row.id,
      course_id: row.course_id,
      finding: row.finding as Json,
      created_at: row.created_at,
    })),
    openFindingsTotal: payload.open_findings_total,
    spotlight: payload.spotlight,
    lessonTitles,
  };
}
