/**
 * PERF-1 C1 — /marketing (hub) bundle loader.
 *
 * ONE SECURITY DEFINER round trip (`public.marketing_hub_bundle`, migration
 * 20260717100800) replaces the hub page's former 6 sequential waves: course
 * picker courses → Promise.all(campaign / pending approvals / questions /
 * activity / autonomy) → landing pages → the fetch-to-count sequences
 * overview. The per-pending-approval LIVE previews stay OUT of the bundle by
 * design (they re-execute the tool so counts reflect CURRENT state) — the
 * page builds them as an un-awaited promise that streams into the rendered
 * cards.
 *
 * Zod-first: the payload contract lives in the schemas below and the wire
 * types are INFERRED from them; the exported bundle is the camelCase mapping
 * the page's view-model code consumes (the same shapes it built from the old
 * per-table loaders). Lenient exactly where the old code was lenient
 * (unchecked casts on config keys / question options → `.catch` fallbacks).
 *
 * Authorization lives INSIDE the RPC (author-only; auth.uid() pinned there).
 * A missing/forbidden course returns null → the page renders its no-course
 * state. Testable per AC-PERF-07: the supabase client is a parameter, so a
 * counting client can assert the single round trip.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";
import {
  DEFAULT_AUTONOMY_SETTINGS,
  DEFAULT_REVERT_WINDOW_HOURS,
  parseMode,
  parsePolicy,
  type AutonomySettings,
} from "@/lib/marketing/autonomy";
import type { QuestionOption } from "@/lib/marketing/questions";
import type { CampaignStatus, LandingPageStatus } from "@/lib/marketing/types";

type DB = SupabaseClient<Database>;

/* ─────────────────────────── wire contract ───────────────────────────── */

const CourseRefSchema = z.object({ id: z.string(), title: z.string() });

const AutoPauseSchema = z
  .object({ metric: z.string(), value: z.number(), threshold: z.number() })
  .nullable()
  .catch(null);

const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  goal: z.string().nullable(),
  // ONLY the config keys the hub reads — never the whole brief/config jsonb.
  config: z.object({
    blueprintKey: z.string().nullable().catch(null),
    autoPauseReason: AutoPauseSchema,
  }),
});

const PendingApprovalSchema = z.object({
  id: z.string(),
  tool_name: z.string(),
  action_kind: z.string(),
  summary: z.string().nullable(),
  // Kept: ApprovalCard's editableParams + the streamed preview re-run need it.
  params: z.record(z.string(), z.unknown()).nullable().catch(null),
  target_ref: z.object({ entity: z.string(), id: z.string() }).nullable().catch(null),
  requested_by: z.enum(["user", "agent"]).catch("user"),
  campaign_id: z.string().nullable(),
  created_at: z.string(),
});

const QuestionRowSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        description: z.string().nullable().catch(null),
      })
    )
    .catch([]),
});

const ActivityRowSchema = z.object({
  id: z.string(),
  action_kind: z.string(),
  summary: z.string().nullable(),
  status: z.string(),
  requested_by: z.enum(["user", "agent"]).catch("user"),
  autonomy_decision: z.unknown(),
  revert_expires_at: z.string().nullable(),
  created_at: z.string(),
});

const LandingPageRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  status: z.enum(["draft", "published", "unpublished"]).catch("draft"),
  section_count: z.number().int(),
});

const SequencesOverviewSchema = z.object({
  sequence_count: z.number().int(),
  queued: z.number().int(),
  sent: z.number().int(),
});

const HubBundleSchema = z
  .object({
    courses: z.array(CourseRefSchema),
    campaign: CampaignSchema.nullable(),
    pending_approvals: z.array(PendingApprovalSchema),
    pending_questions: z.array(QuestionRowSchema),
    activity: z.array(ActivityRowSchema),
    autonomy: z
      .object({
        mode: z.unknown(),
        policy: z.unknown(),
        revert_window_hours: z.unknown(),
      })
      .nullable(),
    landing_pages: z.array(LandingPageRowSchema),
    sequences_overview: SequencesOverviewSchema,
  })
  .nullable();

/* ─────────────────────────── mapped bundle ───────────────────────────── */

export interface HubCampaign {
  id: string;
  name: string;
  status: CampaignStatus;
  goal: string | null;
  blueprintKey: string | null;
  autoPauseReason: { metric: string; value: number; threshold: number } | null;
}

export interface HubPendingApproval {
  id: string;
  toolName: string;
  actionKind: string;
  summary: string | null;
  params: Record<string, unknown>;
  targetRef: { entity: string; id: string } | null;
  requestedBy: "user" | "agent";
  campaignId: string | null;
}

export interface HubQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
}

export interface HubActivityEntry {
  id: string;
  actionKind: string;
  summary: string | null;
  status: string;
  requestedBy: "user" | "agent";
  autonomyDecision: unknown;
  revertExpiresAt: string | null;
}

export interface HubLandingPage {
  id: string;
  title: string;
  slug: string;
  status: LandingPageStatus;
  sectionCount: number;
}

export interface MarketingHubBundle {
  courses: { id: string; title: string }[];
  campaign: HubCampaign | null;
  pendingApprovals: HubPendingApproval[];
  pendingQuestions: HubQuestion[];
  activity: HubActivityEntry[];
  autonomy: AutonomySettings;
  landingPages: HubLandingPage[];
  sequencesOverview: { sequenceCount: number; queued: number; sent: number };
}

/**
 * Load everything the hub shell needs in one round trip. Returns null when
 * the course is missing or the caller isn't its author.
 */
export async function loadMarketingHub(
  supabase: DB,
  courseId: string
): Promise<MarketingHubBundle | null> {
  const raw = await rpcJson(
    supabase,
    "marketing_hub_bundle",
    { p_course_id: courseId },
    HubBundleSchema
  );
  if (raw === null) return null;

  return {
    courses: raw.courses,
    campaign: raw.campaign
      ? {
          id: raw.campaign.id,
          name: raw.campaign.name,
          status: raw.campaign.status as CampaignStatus,
          goal: raw.campaign.goal,
          blueprintKey: raw.campaign.config.blueprintKey,
          autoPauseReason: raw.campaign.config.autoPauseReason,
        }
      : null,
    pendingApprovals: raw.pending_approvals.map((a) => ({
      id: a.id,
      toolName: a.tool_name,
      actionKind: a.action_kind,
      summary: a.summary,
      params: a.params ?? {},
      targetRef: a.target_ref,
      requestedBy: a.requested_by,
      campaignId: a.campaign_id,
    })),
    pendingQuestions: raw.pending_questions.map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options,
    })),
    activity: raw.activity.map((a) => ({
      id: a.id,
      actionKind: a.action_kind,
      summary: a.summary,
      status: a.status,
      requestedBy: a.requested_by,
      autonomyDecision: a.autonomy_decision ?? null,
      revertExpiresAt: a.revert_expires_at,
    })),
    // NO settings row means the defaults — exactly loadAutonomySettings' parse.
    autonomy: raw.autonomy
      ? {
          mode: parseMode(raw.autonomy.mode),
          policy: parsePolicy(raw.autonomy.policy),
          revertWindowHours:
            typeof raw.autonomy.revert_window_hours === "number" &&
            raw.autonomy.revert_window_hours >= 1
              ? raw.autonomy.revert_window_hours
              : DEFAULT_REVERT_WINDOW_HOURS,
        }
      : { ...DEFAULT_AUTONOMY_SETTINGS },
    landingPages: raw.landing_pages.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      status: p.status,
      sectionCount: p.section_count,
    })),
    sequencesOverview: {
      sequenceCount: raw.sequences_overview.sequence_count,
      queued: raw.sequences_overview.queued,
      sent: raw.sequences_overview.sent,
    },
  };
}
