/**
 * PERF-1 C1 loaders for /studio/[courseId]/analytics (+ learner detail).
 *
 * Each view is ONE data round trip: the pages call these with their
 * RLS-scoped client and the SECURITY DEFINER bundle RPCs
 * (20260717100700_analytics_bundle_rpcs.sql) return exactly what the
 * requested tab renders — authorization lives INSIDE the functions (author
 * check → null → the page 404s). Payloads are Zod-validated (zod-first: the
 * row types below are INFERRED from the schemas; the rollup-row schemas are
 * pinned against the generated table Row types so the tab components'
 * existing prop contracts hold). Snapshot maps are NOT loaded here — pages
 * take them from the immutable-publication cache (`getCachedSnapshot`), the
 * one sanctioned extra (cached) read.
 *
 * The supabase client is a parameter so tests can inject a counting client
 * (AC-PERF-07).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";
import {
  OverviewSchema,
  type ContentFeedbackRow,
  type CourseAnalytics,
  type FunnelRow,
  type LearnerFlagRow,
  type OverviewData,
  type QuestionStatsRow,
  type RosterRow,
  type SlideDwellRow,
  type VideoRetentionRow,
} from "@/lib/analytics/dashboard";

type DB = SupabaseClient<Database>;

export type DashboardTab = "overview" | "content" | "learners" | "stuck";

/** How many timeline events one learner-detail page shows (51st row = probe). */
export const TIMELINE_PAGE_SIZE = 50;
/** How many recent reviews one Overview page shows (11th row = probe). */
export const REVIEWS_PAGE_SIZE = 10;

/* ───────────────────────── Row schemas ──────────────────────────────────
 * Mirrors of the rollup table rows as `to_jsonb(row)` emits them, pinned
 * against the generated Row types so a drifted column trips tsc, and a
 * malformed payload trips the parse (loud 500, never a silent wrong chart).
 */

const JsonSchema = z.custom<Json>((v) => v !== undefined);

const FunnelRowSchema = z.object({
  completed_count: z.number(),
  computed_at: z.string(),
  course_id: z.string(),
  dropoff_pct: z.number().nullable(),
  lesson_id: z.string(),
  lesson_order: z.number(),
  publication_id: z.string(),
  started_count: z.number(),
  version: z.number(),
}) satisfies z.ZodType<FunnelRow>;

const QuestionStatsRowSchema = z.object({
  answer_distribution: JsonSchema,
  block_id: z.string(),
  computed_at: z.string(),
  course_id: z.string(),
  discrimination: z.number().nullable(),
  key_value: z.string().nullable(),
  lesson_id: z.string(),
  n: z.number(),
  pct_correct: z.number().nullable(),
  publication_id: z.string(),
  question_id: z.string(),
  version: z.number(),
}) satisfies z.ZodType<QuestionStatsRow>;

const SlideDwellRowSchema = z.object({
  block_id: z.string(),
  computed_at: z.string(),
  course_id: z.string(),
  lesson_id: z.string(),
  median_dwell_ms: z.number().nullable(),
  n: z.number(),
  p90_dwell_ms: z.number().nullable(),
  publication_id: z.string(),
  slide_id: z.string(),
  version: z.number(),
}) satisfies z.ZodType<SlideDwellRow>;

const VideoRetentionRowSchema = z.object({
  block_id: z.string(),
  completed_count: z.number(),
  computed_at: z.string(),
  course_id: z.string(),
  lesson_id: z.string(),
  publication_id: z.string(),
  q1_count: z.number(),
  q2_count: z.number(),
  q3_count: z.number(),
  q4_count: z.number(),
  version: z.number(),
  viewers: z.number(),
}) satisfies z.ZodType<VideoRetentionRow>;

const ContentFeedbackRowSchema = z.object({
  block_id: z.string().nullable(),
  computed_at: z.string(),
  confusing_count: z.number(),
  confusing_pct: z.number().nullable(),
  course_id: z.string(),
  helpful_count: z.number(),
  id: z.string(),
  lesson_id: z.string(),
  publication_id: z.string(),
  recent_comments: JsonSchema,
  slide_id: z.string().nullable(),
  version: z.number(),
}) satisfies z.ZodType<ContentFeedbackRow>;

const LearnerFlagRowSchema = z.object({
  computed_at: z.string(),
  course_id: z.string(),
  detail: JsonSchema,
  flag_type: z.string(),
  user_id: z.string(),
}) satisfies z.ZodType<LearnerFlagRow>;

/** course_roster's row as jsonb. Runtime truth: last_activity_at is null for
 *  a learner with no progress rows (the generated RPC type claims `string`;
 *  the UI's timeAgo already tolerates null — cast at the boundary below). */
const RosterRowSchema = z.object({
  user_id: z.string(),
  display_name: z.string(),
  email: z.string(),
  enrolled_at: z.string(),
  enrollment_status: z.string(),
  progress_pct: z.number(),
  completed_lessons: z.number(),
  total_lessons: z.number(),
  last_activity_at: z.string().nullable(),
  flags: JsonSchema,
});

const CourseRefSchema = z.object({ id: z.string(), title: z.string() });
const PublicationRefSchema = z.object({
  id: z.string(),
  version: z.number(),
  slug: z.string(),
});
export type PublicationRef = z.infer<typeof PublicationRefSchema>;

const ReviewsRollupSchema = z.object({
  review_count: z.number(),
  avg_rating: z.number(),
  rating_distribution: z.record(z.string(), z.number()),
});
export type ReviewsRollupData = z.infer<typeof ReviewsRollupSchema>;

const ReviewPageRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  rating: z.number(),
  review_text: z.string().nullable(),
  updated_at: z.string(),
  /** Joined in-RPC so the card labels reviewers without the roster. */
  display_name: z.string(),
});
export type ReviewPageRow = z.infer<typeof ReviewPageRowSchema>;

const LastMessageRowSchema = z.object({
  user_id: z.string(),
  status: z.string(),
  delivery_status: z.string().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
});

/* ───────────────────── course_analytics_bundle ─────────────────────────── */

const AnalyticsBundleSchema = z.object({
  course: CourseRefSchema,
  publication: PublicationRefSchema.nullable(),
  stuck_count: z.number(),
  computed_at: z.string().nullable(),
  // overview tab
  overview: OverviewSchema.optional(),
  reviews_rollup: ReviewsRollupSchema.nullable().optional(),
  reviews: z
    .object({ rows: z.array(ReviewPageRowSchema), has_more: z.boolean() })
    .optional(),
  // overview + content tabs
  funnel: z.array(FunnelRowSchema).optional(),
  // content tab
  questions: z.array(QuestionStatsRowSchema).optional(),
  dwell: z.array(SlideDwellRowSchema).optional(),
  video: z.array(VideoRetentionRowSchema).optional(),
  feedback: z.array(ContentFeedbackRowSchema).optional(),
  // learners + stuck tabs
  roster: z.array(RosterRowSchema).optional(),
  // stuck tab
  flags: z.array(LearnerFlagRowSchema).optional(),
  opt_outs: z
    .array(z.object({ user_id: z.string(), comms_opt_out: z.boolean() }))
    .optional(),
  last_messages: z.array(LastMessageRowSchema).optional(),
  suppressions: z
    .array(z.object({ user_id: z.string(), reason: z.string() }))
    .optional(),
});

const EMPTY_OVERVIEW: OverviewData = {
  totalEnrollments: 0,
  activeEnrollments: 0,
  completedEnrollments: 0,
  active7d: 0,
  enrollmentsByDay: [],
};

export interface AnalyticsDashboardData {
  course: { id: string; title: string };
  publication: PublicationRef | null;
  /** Distinct flagged learners — the tab-nav badge (rendered on every tab). */
  stuckCount: number;
  /** Only the requested tab's slices are populated; the rest stay empty. */
  analytics: CourseAnalytics;
  /** Overview tab only. */
  reviews: {
    rollup: ReviewsRollupData | null;
    rows: ReviewPageRow[];
    hasMore: boolean;
    /** userId → display name for the rows above (was roster-derived). */
    learnerNames: Record<string, string>;
  } | null;
  /** Stuck tab only (empty objects elsewhere). */
  optOutByUser: Record<string, boolean>;
  lastNudgeByUser: Record<
    string,
    { status: string; delivery_status: string | null; sent_at: string | null; created_at: string }
  >;
  suppressedByUser: Record<string, string>;
}

/**
 * One round trip for a dashboard tab. Returns null when the course doesn't
 * exist or the caller isn't its author (the RPC authorizes internally) — the
 * page turns that into a 404. `publication: null` = no live version (the
 * page's empty state).
 */
export async function loadAnalyticsDashboard(
  supabase: DB,
  courseId: string,
  tab: DashboardTab,
  reviewsFrom = 0
): Promise<AnalyticsDashboardData | null> {
  const data = await rpcJson(
    supabase,
    "course_analytics_bundle",
    { p_course_id: courseId, p_tab: tab, p_reviews_from: reviewsFrom },
    AnalyticsBundleSchema.nullable()
  );
  if (!data) return null;

  const analytics: CourseAnalytics = {
    overview: data.overview ?? EMPTY_OVERVIEW,
    funnel: data.funnel ?? [],
    questionStats: data.questions ?? [],
    slideDwell: data.dwell ?? [],
    videoRetention: data.video ?? [],
    contentFeedback: data.feedback ?? [],
    flags: data.flags ?? [],
    // See RosterRowSchema: runtime-truthful (nullable last_activity_at); the
    // generated RPC return type is the optimistic mirror the UI already uses.
    roster: (data.roster ?? []) as RosterRow[],
    computedAt: data.computed_at,
  };

  const optOutByUser: Record<string, boolean> = {};
  for (const row of data.opt_outs ?? []) optOutByUser[row.user_id] = row.comms_opt_out;
  const lastNudgeByUser: AnalyticsDashboardData["lastNudgeByUser"] = {};
  for (const row of data.last_messages ?? []) {
    const { user_id, ...nudge } = row;
    lastNudgeByUser[user_id] = nudge;
  }
  const suppressedByUser: Record<string, string> = {};
  for (const row of data.suppressions ?? []) suppressedByUser[row.user_id] = row.reason;

  return {
    course: data.course,
    publication: data.publication,
    stuckCount: data.stuck_count,
    analytics,
    reviews: data.reviews
      ? {
          rollup: data.reviews_rollup ?? null,
          rows: data.reviews.rows,
          hasMore: data.reviews.has_more,
          learnerNames: Object.fromEntries(
            data.reviews.rows.map((r) => [r.user_id, r.display_name])
          ),
        }
      : null,
    optOutByUser,
    lastNudgeByUser,
    suppressedByUser,
  };
}

/* ───────────────────── learner_detail_bundle ───────────────────────────── */

const ProgressRowSchema = z.object({
  lesson_id: z.string(),
  status: z.string(),
  pct: z.number(),
  last_activity_at: z.string(),
});

const QuestionResponseRowSchema = z.object({
  attempt_id: z.string(),
  correct: z.boolean(),
  id: z.string(),
  question_id: z.string(),
  response: JsonSchema,
  time_ms: z.number().nullable(),
});

const AttemptRowSchema = z.object({
  attempt_number: z.number(),
  block_id: z.string(),
  course_id: z.string(),
  id: z.string(),
  max_score: z.number(),
  publication_id: z.string(),
  score: z.number(),
  started_at: z.string(),
  submitted_at: z.string(),
  user_id: z.string(),
  version: z.number(),
  question_responses: z.array(QuestionResponseRowSchema),
});
export type LearnerAttempt = z.infer<typeof AttemptRowSchema>;

/** The trimmed timeline event — exactly the columns the timeline renders. */
const TimelineEventSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  lesson_id: z.string().nullable(),
  block_id: z.string().nullable(),
  dwell_ms: z.number().nullable(),
  quartile: z.number().nullable(),
  server_ts: z.string(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

const LearnerMessageRowSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.string(),
  delivery_status: z.string().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
});
export type LearnerMessageRow = z.infer<typeof LearnerMessageRowSchema>;

const LearnerDetailBundleSchema = z.object({
  course: CourseRefSchema,
  publication: PublicationRefSchema.nullable(),
  roster_row: RosterRowSchema.nullable(),
  progress: z.array(ProgressRowSchema),
  attempts: z.array(AttemptRowSchema),
  attempt_count: z.number(),
  events: z.array(TimelineEventSchema),
  heartbeat_count: z.number(),
  flags: z.array(LearnerFlagRowSchema),
  messages: z.array(LearnerMessageRowSchema),
});

export interface LearnerDetailData {
  course: { id: string; title: string };
  publication: PublicationRef | null;
  /** Null = not enrolled in this course (page 404s). */
  learner: RosterRow | null;
  progress: z.infer<typeof ProgressRowSchema>[];
  /** Newest 25; `attemptCount` is the true total for the Stat. */
  attempts: LearnerAttempt[];
  attemptCount: number;
  /** One keyset page, newest first (≤ TIMELINE_PAGE_SIZE after the probe). */
  events: TimelineEvent[];
  hasMoreEvents: boolean;
  heartbeatCount: number;
  flags: LearnerFlagRow[];
  messages: LearnerMessageRow[];
}

/**
 * One round trip for the learner-detail page. `before` is the keyset cursor
 * (an event server_ts; events strictly older are returned). Null = not the
 * author / unknown course.
 */
export async function loadLearnerDetail(
  supabase: DB,
  courseId: string,
  learnerId: string,
  before?: string
): Promise<LearnerDetailData | null> {
  const data = await rpcJson(
    supabase,
    "learner_detail_bundle",
    { p_course_id: courseId, p_user_id: learnerId, p_before: before ?? null },
    LearnerDetailBundleSchema.nullable()
  );
  if (!data) return null;

  const hasMoreEvents = data.events.length > TIMELINE_PAGE_SIZE;
  return {
    course: data.course,
    publication: data.publication,
    learner: (data.roster_row as RosterRow | null) ?? null,
    progress: data.progress,
    attempts: data.attempts,
    attemptCount: data.attempt_count,
    events: hasMoreEvents ? data.events.slice(0, TIMELINE_PAGE_SIZE) : data.events,
    hasMoreEvents,
    heartbeatCount: data.heartbeat_count,
    flags: data.flags,
    messages: data.messages,
  };
}
