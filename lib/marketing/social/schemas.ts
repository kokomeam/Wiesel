/**
 * Social Post Generator — Zod single source of truth (PRD §12.2).
 *
 * Every shape is defined ONCE here and inferred everywhere: the REST routes,
 * the agent tools, the generation gate, and the UI all import these. Types are
 * never hand-written. Platform caps come from PLATFORM_LIMITS via superRefine
 * (constants module — imported, not copied).
 */

import { z } from "zod";
import {
  FUNNEL_STAGES,
  PLATFORMS,
  platformLimitsFor,
  POST_PLATFORMS,
  POST_STATUSES,
  SOCIAL_GOALS,
  SOCIAL_TONES,
  TIMING_PRESETS,
  type SocialPlatform,
} from "./constants";

export const PlatformSchema = z.enum(PLATFORMS);
/** The ROW platform union — text platforms ∪ clip-post platforms. The domain
 *  post schema uses THIS: since M-C, clip posts (post_type='clip') legally
 *  carry instagram/tiktok/youtube_shorts, and the old 2-value enum made every
 *  clip row fail parse / lie under a cast. */
export const PostPlatformSchema = z.enum(POST_PLATFORMS);
export const GoalSchema = z.enum(SOCIAL_GOALS);
export const FunnelStageSchema = z.enum(FUNNEL_STAGES);
export const ToneSchema = z.enum(SOCIAL_TONES);
export const PostStatusSchema = z.enum(POST_STATUSES);
export const TimingPresetSchema = z.enum(TIMING_PRESETS);

/** `#hashtag` or `hashtag` — unicode letters/digits/underscore only. */
export const HASHTAG_RE = /^#?[\p{L}\p{N}_]+$/u;
const HashtagSchema = z.string().min(1).max(80).regex(HASHTAG_RE, "not a valid hashtag");

function checkPlatformLimits(
  post: { platform: SocialPlatform; body: string; hashtags: string[] },
  ctx: z.RefinementCtx
) {
  const limits = platformLimitsFor(post.platform);
  if (post.body.length > limits.charCap) {
    ctx.addIssue({
      code: "custom",
      path: ["body"],
      message: `body exceeds the ${limits.label} cap of ${limits.charCap} characters`,
    });
  }
  if (post.hashtags.length > limits.hashtagMax) {
    ctx.addIssue({
      code: "custom",
      path: ["hashtags"],
      message: `${limits.label} allows at most ${limits.hashtagMax} hashtags`,
    });
  }
}

/**
 * One generated draft as it crosses the pipeline (model output + planning
 * fields the CODE assigns). `plannedPostAt` is never model-authored — the
 * timing plan zips it in (see ModelPostSchema below for the model-facing
 * shape).
 */
export const GeneratedPostSchema = z
  .object({
    platform: PlatformSchema,
    goal: GoalSchema,
    funnelStage: FunnelStageSchema,
    tone: ToneSchema,
    body: z.string().min(30),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(HashtagSchema).max(8),
    suggestedImageIdea: z.string().max(240),
    plannedPostAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine(checkPlatformLimits);
export type GeneratedPost = z.infer<typeof GeneratedPostSchema>;

export const GeneratedPostBatchSchema = z.object({
  posts: z.array(GeneratedPostSchema).min(1).max(5),
});
export type GeneratedPostBatch = z.infer<typeof GeneratedPostBatchSchema>;

/**
 * MODEL-facing draft shape: what the structured-output call must return.
 * Excludes plannedPostAt (code assigns times from the timing plan — the model
 * cannot know the posting calendar) and platform (fixed per batch). Slot
 * metadata (goal/stage/tone) is echoed so the pipeline can verify the mix
 * contract; on mismatch the PLAN wins (code overrides, never a hard failure).
 */
export const ModelPostSchema = z.object({
  goal: GoalSchema,
  funnelStage: FunnelStageSchema,
  tone: ToneSchema,
  body: z.string().min(30),
  cta: z.string().max(200).nullable(),
  hashtags: z.array(HashtagSchema).max(8),
  suggestedImageIdea: z.string().max(240),
});
export const ModelBatchSchema = z.object({ posts: z.array(ModelPostSchema).min(1).max(5) });
export type ModelPost = z.infer<typeof ModelPostSchema>;

/** POST /generate request (PRD §12.2). `timeZone` grounds the timing presets
 *  (IANA name, defaults to UTC when the caller doesn't know it). The BASE
 *  object is exported separately because zod v4 forbids .omit()/.extend() on
 *  refined schemas — the tool layer derives its params from the base and
 *  re-parses through the refined schema. */
export const GenerateRequestBaseSchema = z.object({
  sourceType: z.enum(["course", "module", "lesson", "manual"]),
  courseId: z.uuid().optional(),
  moduleId: z.uuid().optional(),
  lessonId: z.uuid().optional(),
  sourceText: z.string().max(8000).optional(),
  platform: PlatformSchema,
  goal: GoalSchema.optional(), // required when funnelMix='pinned'
  funnelMix: z.enum(["balanced", "pinned"]).default("pinned"),
  tone: ToneSchema,
  count: z.number().int().min(1).max(5),
  timingPreset: TimingPresetSchema.default("none"),
  customTimes: z.array(z.iso.datetime({ offset: true })).max(5).optional(),
  timeZone: z.string().max(64).optional(),
});

export const GenerateRequestSchema = GenerateRequestBaseSchema.superRefine((req, ctx) => {
    // source-id consistency
    if (req.sourceType === "course" && !req.courseId)
      ctx.addIssue({ code: "custom", path: ["courseId"], message: "courseId required for a course source" });
    if (req.sourceType === "module" && !(req.courseId && req.moduleId))
      ctx.addIssue({ code: "custom", path: ["moduleId"], message: "courseId + moduleId required for a module source" });
    if (req.sourceType === "lesson" && !(req.courseId && req.lessonId))
      ctx.addIssue({ code: "custom", path: ["lessonId"], message: "courseId + lessonId required for a lesson source" });
    if (req.sourceType === "manual" && !req.sourceText?.trim())
      ctx.addIssue({ code: "custom", path: ["sourceText"], message: "sourceText required for a manual source" });
    if (req.funnelMix === "pinned" && !req.goal)
      ctx.addIssue({ code: "custom", path: ["goal"], message: "goal required when funnelMix is 'pinned'" });
    if (req.timingPreset === "custom" && (req.customTimes?.length ?? 0) !== req.count)
      ctx.addIssue({ code: "custom", path: ["customTimes"], message: "custom timing needs one time per post" });
  });
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

/** Manual performance log (PRD §12.3). At least one signal required. */
export const PostPerformanceSchema = z
  .object({
    impressions: z.number().int().nonnegative().optional(),
    likes: z.number().int().nonnegative().optional(),
    comments: z.number().int().nonnegative().optional(),
    shares: z.number().int().nonnegative().optional(),
    clicks: z.number().int().nonnegative().optional(),
    qualitative: z.enum(["flop", "ok", "good", "viral"]).optional(),
    loggedAt: z.iso.datetime({ offset: true }),
    source: z.literal("manual"), // [FWD] Phase 4 adds 'api'
  })
  .refine(
    (p) =>
      p.qualitative !== undefined ||
      p.impressions !== undefined ||
      p.likes !== undefined ||
      p.comments !== undefined ||
      p.shares !== undefined ||
      p.clicks !== undefined,
    { message: "log at least one signal (a metric or the one-tap rating)" }
  );
export type PostPerformance = z.infer<typeof PostPerformanceSchema>;

/** The derived, versioned creator voice profile payload (PRD §9.5). */
export const SocialVoiceProfileSchema = z.object({
  summary: z.string().min(1).max(600),
  register: z.string().min(1).max(120),
  sentenceLength: z.enum(["short", "medium", "long", "varied"]),
  emojiTolerance: z.enum(["none", "low", "medium", "high"]),
  signatureMoves: z.array(z.string().min(1).max(160)).max(8),
  bannedPhrases: z.array(z.string().min(1).max(80)).max(20),
  sampleExcerpts: z.array(z.string().min(1).max(1200)).max(3),
});
export type SocialVoiceProfile = z.infer<typeof SocialVoiceProfileSchema>;

/** Domain shape of a social_post row (camelCase mirror, PRD §12.1). */
export const SocialPostSchema = z.object({
  id: z.uuid(),
  creatorId: z.uuid(),
  courseId: z.uuid().nullable(),
  moduleId: z.uuid().nullable(),
  lessonId: z.uuid().nullable(),
  campaignId: z.uuid().nullable(),
  batchId: z.uuid().nullable(),
  batchOrder: z.number().int().min(1).max(5).nullable(),
  sourceType: z.enum(["course", "module", "lesson", "manual"]),
  sourceText: z.string().nullable(),
  platform: PostPlatformSchema,
  postType: z.string(), // 'text' (Phase 1) or 'clip' (Phase 1.5 ingest)
  goal: GoalSchema,
  funnelStage: FunnelStageSchema,
  audience: z.string().nullable(),
  tone: ToneSchema,
  body: z.string(),
  cta: z.string().nullable(),
  hashtags: z.array(z.string()),
  imageUrl: z.string().nullable(),
  imageStoragePath: z.string().nullable(),
  imageAltText: z.string().nullable(),
  suggestedImageIdea: z.string().nullable(),
  plannedPostAt: z.string().nullable(),
  status: PostStatusSchema,
  postedManuallyAt: z.string().nullable(),
  performance: PostPerformanceSchema.nullable(),
  externalRef: z.unknown().nullable(), // [FWD] Phase 3
  version: z.number().int().min(1),
  aiMetadata: z.record(z.string(), z.unknown()),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SocialPost = z.infer<typeof SocialPostSchema>;

/** Content fields a versioned PATCH may touch (everything else is lifecycle-
 *  or system-owned and has its own path). */
export const SocialPostPatchSchema = z
  .object({
    body: z.string().min(1),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(HashtagSchema).max(8),
    imageAltText: z.string().max(500).nullable(),
    audience: z.string().max(300).nullable(),
    funnelStage: FunnelStageSchema,
    goal: GoalSchema,
    tone: ToneSchema,
    suggestedImageIdea: z.string().max(240).nullable(),
    plannedPostAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });
export type SocialPostPatch = z.infer<typeof SocialPostPatchSchema>;
