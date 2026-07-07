/**
 * Social Post Generator tools (Marketing Phase 1, PRD §10) — 19 typed tools:
 * 5 read/suggest (execute freely) + 14 reversible writes (auto-commit with a
 * revert-log entry; NO approval cards anywhere — reversible-tier only, per
 * the autonomy redesign). REST routes, the hub UI, and the agent all call
 * these through executeMarketingTool → the gate, which is also what makes
 * the per-day revision budget countable on the marketing_action ledger.
 *
 * The Cursor loop: inspect (list/get) → targeted versioned edit → explain.
 * Every write that touches content requires expectedVersion; a stale version
 * surfaces a conflict message teaching the agent the re-read + re-apply
 * protocol (never force-write).
 */

import { z } from "zod";
import {
  GOAL_STAGE_MAP,
  PLATFORMS,
  PLATFORM_LIMITS,
  POST_STATUSES,
  SOCIAL_GOALS,
  SOCIAL_TONES,
} from "../social/constants";
import { emitSocialEvent } from "../social/events";
import {
  SocialGenerationError,
  SocialModelUnavailableError,
  SocialRateLimitError,
  SocialVersionConflictError,
} from "../social/errors";
import {
  ensureSocialVoiceProfile,
  generateSocialBatch,
  type SocialPipelineDeps,
} from "../social/generate";
import { finalizeImageAttachment, removeImageAttachment, SocialImageError } from "../social/images";
import {
  getSocialPost,
  listSocialPosts,
  insertSocialPost,
  softDeleteSocialPost,
  updatePostStatus,
  upsertPostPerformance,
  versionedUpdateSocialPost,
} from "../social/repository";
import {
  changePostTone,
  createPostVariants,
  draftImageAltText,
  regeneratePost,
  revisePost,
  rewriteForPlatform,
  suggestHashtags,
} from "../social/service";
import {
  FunnelStageSchema,
  GenerateRequestBaseSchema,
  GenerateRequestSchema,
  GoalSchema,
  PlatformSchema,
  PostPerformanceSchema,
  PostStatusSchema,
  SocialPostPatchSchema,
  ToneSchema,
  type SocialPost,
} from "../social/schemas";
import { defineMarketingTool, MarketingToolError, type MarketingToolContext } from "./types";

function depsFrom(ctx: MarketingToolContext): SocialPipelineDeps {
  return {
    supabase: ctx.supabase,
    ownerId: ctx.ownerId,
    model: ctx.model,
    clock: ctx.services.clock,
    courseIdForEvents: ctx.courseId,
  };
}

/** Map pipeline errors onto agent-teachable MarketingToolErrors. */
function rethrow(err: unknown): never {
  if (err instanceof SocialVersionConflictError) {
    throw new MarketingToolError(
      "Version conflict: the post changed since you read it. Call get_social_post to re-read the CURRENT content and version, re-apply the creator's intent on top of it, then retry with the fresh expectedVersion. Never overwrite blindly."
    );
  }
  if (
    err instanceof SocialRateLimitError ||
    err instanceof SocialGenerationError ||
    err instanceof SocialModelUnavailableError ||
    err instanceof SocialImageError
  ) {
    throw new MarketingToolError(err.message);
  }
  throw err;
}

async function requirePost(ctx: MarketingToolContext, postId: string): Promise<SocialPost> {
  const post = await getSocialPost(ctx.supabase, postId);
  if (!post) throw new MarketingToolError(`Social post ${postId} not found`);
  return post;
}

function postSummaryLine(p: SocialPost): string {
  const preview = p.body.replace(/\s+/g, " ").slice(0, 90);
  return `[${p.platform} · ${p.funnelStage} · ${p.status} · v${p.version}] ${preview}…`;
}

function compactPost(p: SocialPost) {
  return {
    id: p.id,
    platform: p.platform,
    goal: p.goal,
    funnelStage: p.funnelStage,
    tone: p.tone,
    status: p.status,
    version: p.version,
    bodyPreview: p.body.slice(0, 160),
    cta: p.cta,
    hashtags: p.hashtags,
    plannedPostAt: p.plannedPostAt,
    batchId: p.batchId,
    hasImage: Boolean(p.imageStoragePath),
  };
}

/* ─────────────────────────── read & suggest ─────────────────────────── */

const listSocialPostsTool = defineMarketingTool({
  name: "list_social_posts",
  description:
    "List the creator's social posts (the content queue) with optional filters: status, platform, funnel stage, batch. Call this to see what exists before editing — the agent's view of the queue.",
  params: z.object({
    status: PostStatusSchema.nullable(),
    platform: PlatformSchema.nullable(),
    funnelStage: FunnelStageSchema.nullable(),
    batchId: z.string().nullable(),
    limit: z.number().int().min(1).max(50).nullable(),
  }),
  reversibility: "read",
  async execute(args, ctx) {
    const { posts } = await listSocialPosts(
      ctx.supabase,
      {
        status: args.status ?? undefined,
        platform: args.platform ?? undefined,
        funnelStage: args.funnelStage ?? undefined,
        batchId: args.batchId ?? undefined,
      },
      { limit: args.limit ?? 25 }
    );
    return {
      summary: `${posts.length} post(s).${posts.length ? ` Latest: ${postSummaryLine(posts[0])}` : ""}`,
      data: { posts: posts.map(compactPost) },
    };
  },
});

const getSocialPostTool = defineMarketingTool({
  name: "get_social_post",
  description:
    "Read one social post in full — body, CTA, hashtags, planned time, status, and the CURRENT version (use it as expectedVersion on any edit). Read before you edit.",
  params: z.object({ postId: z.string().min(1) }),
  reversibility: "read",
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    return {
      summary: `${postSummaryLine(post)} — expectedVersion for edits: ${post.version}.`,
      data: post,
    };
  },
});

const getSocialVoiceProfileTool = defineMarketingTool({
  name: "get_social_voice_profile",
  description:
    "Read the creator's social voice profile (derived style summary, register, signature moves, banned phrases) — the voice every post must sound like. Derives it on first use.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    try {
      const record = await ensureSocialVoiceProfile(depsFrom(ctx));
      return {
        summary: `Voice profile v${record.version} (${record.source}): ${record.profile.summary.slice(0, 140)}`,
        data: record,
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const suggestHashtagsTool = defineMarketingTool({
  name: "suggest_hashtags",
  description:
    "Suggest relevant, non-spammy hashtags for a post (by id) or raw text, respecting the platform's range. Returns a list — writes NOTHING unless the creator asks you to apply them (then use update_social_post).",
  params: z.object({
    postId: z.string().nullable(),
    text: z.string().max(4000).nullable(),
    platform: PlatformSchema.nullable(),
  }),
  reversibility: "read",
  async execute(args, ctx) {
    let text = args.text ?? "";
    let platform = args.platform ?? "linkedin";
    if (args.postId) {
      const post = await requirePost(ctx, args.postId);
      text = post.body;
      platform = post.platform;
    }
    if (!text.trim()) throw new MarketingToolError("Provide postId or text");
    const hashtags = await suggestHashtags(depsFrom(ctx), { text, platform });
    return {
      summary: `Suggested: ${hashtags.join(" ")} (${PLATFORM_LIMITS[platform].label} range ${PLATFORM_LIMITS[platform].hashtagMin}-${PLATFORM_LIMITS[platform].hashtagMax}).`,
      data: { hashtags, platform },
    };
  },
});

const draftImageAltTextTool = defineMarketingTool({
  name: "draft_image_alt_text",
  description:
    "Draft descriptive alt text for a post's image. Returns a SUGGESTION only — never writes it; apply via update_social_post (imageAltText) when the creator confirms.",
  params: z.object({ postId: z.string().min(1) }),
  reversibility: "read",
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    const altText = await draftImageAltText(depsFrom(ctx), { post });
    return { summary: `Alt text suggestion: "${altText}"`, data: { altText } };
  },
});

/* ──────────────────────────── writes (14) ───────────────────────────── */

// Derived from the BASE (unrefined) request object — zod v4 forbids
// .omit()/.extend() on refined schemas; execute() re-parses through the FULL
// GenerateRequestSchema so the source-consistency rules still apply.
const generateToolParams = GenerateRequestBaseSchema.omit({ courseId: true })
  .extend({
    // The agent operates inside the hub's course context; module/lesson
    // sources still narrow within it.
    moduleId: z.string().nullable(),
    lessonId: z.string().nullable(),
    sourceText: z.string().max(8000).nullable(),
    goal: GoalSchema.nullable(),
    customTimes: z.array(z.string()).nullable(),
    timeZone: z.string().max(64).nullable(),
    /** REST Idempotency-Key passthrough — a replay returns the original
     *  batch. The agent passes null. */
    idempotencyKey: z.string().max(200).nullable(),
  });

const generateSocialPostDrafts = defineMarketingTool({
  name: "generate_social_post_drafts",
  description:
    "Generate 1-5 platform-ready social post drafts from the course (or a module/lesson/manual topic), grounded in real course content and the creator's voice. funnelMix 'balanced' distributes tofu/mofu/bofu value-first. Drafts land in the content queue as reversible drafts — the creator posts them manually; WiseSel never publishes to social platforms.",
  params: generateToolParams,
  reversibility: "reversible",
  actionKind: "generate_social_post_drafts",
  async execute(args, ctx) {
    const req = GenerateRequestSchema.parse({
      ...args,
      courseId: args.sourceType === "manual" ? (ctx.courseId ?? undefined) : ctx.courseId,
      moduleId: args.moduleId ?? undefined,
      lessonId: args.lessonId ?? undefined,
      sourceText: args.sourceText ?? undefined,
      goal: args.goal ?? undefined,
      customTimes: args.customTimes ?? undefined,
      timeZone: args.timeZone ?? undefined,
    });
    try {
      const result = await generateSocialBatch(depsFrom(ctx), req, {
        requestedBy: ctx.requestedBy,
        idempotencyKey: args.idempotencyKey,
        onDraft: (post) => ctx.progress?.({ type: "draft", data: compactPost(post) }),
        onPhase: (phase) => ctx.progress?.({ type: "phase", data: { phase } }),
      });
      const mix = result.posts.map((p) => p.funnelStage).join("/");
      const droppedNote = result.dropped.length
        ? ` ${result.dropped.length} draft(s) removed by the safety lint (${result.dropped.map((d) => d.reason).join("; ")}).`
        : "";
      const thinNote = result.thinContext
        ? " Note: this course has little content — posts will be more generic; adding a course description improves them."
        : "";
      return {
        summary: `Generated ${result.posts.length} ${PLATFORM_LIMITS[req.platform].label} draft(s) (${mix}), value-first ordering.${droppedNote}${thinNote} They are drafts in the content queue — the creator reviews, copies, and posts them manually.`,
        data: {
          batchId: result.batch.id,
          posts: result.posts.map(compactPost),
          dropped: result.dropped,
          replayed: result.replayed,
        },
        target: { entity: "social_post_batch", id: result.batch.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const reviseSocialPost = defineMarketingTool({
  name: "revise_social_post",
  description:
    "Revise one post per a free-form instruction (punchier hook, shorter, stronger CTA…). Requires expectedVersion from get_social_post; a stale version returns a conflict you resolve by re-reading and re-applying.",
  params: z.object({
    postId: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    instruction: z.string().min(3).max(1000),
  }),
  reversibility: "reversible",
  actionKind: "revise_social_post",
  editableParams: ["instruction"],
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    try {
      const { post: updated } = await revisePost(depsFrom(ctx), {
        post,
        expectedVersion: args.expectedVersion,
        instruction: args.instruction,
        byAgent: ctx.requestedBy === "agent",
        toolName: "revise_social_post",
      });
      return {
        summary: `Revised the post (v${args.expectedVersion} → v${updated.version}) per: "${args.instruction}".`,
        data: compactPost(updated),
        target: { entity: "social_post", id: updated.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const changePostToneTool = defineMarketingTool({
  name: "change_post_tone",
  description:
    "Rewrite one post in a different tone (professional/friendly/founder_led/educational/casual) and update its stored tone — one versioned write. Requires expectedVersion.",
  params: z.object({
    postId: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    targetTone: ToneSchema,
  }),
  reversibility: "reversible",
  actionKind: "change_post_tone",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    try {
      const updated = await changePostTone(depsFrom(ctx), {
        post,
        expectedVersion: args.expectedVersion,
        targetTone: args.targetTone,
        byAgent: ctx.requestedBy === "agent",
      });
      return {
        summary: `Retoned the post to ${args.targetTone} (now v${updated.version}).`,
        data: compactPost(updated),
        target: { entity: "social_post", id: updated.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const regenerateSocialPost = defineMarketingTool({
  name: "regenerate_social_post",
  description:
    "Fresh take: regenerate one post with its stored parameters (same goal/stage/tone/platform, different angle and hook) through the full pipeline. Requires expectedVersion.",
  params: z.object({
    postId: z.string().min(1),
    expectedVersion: z.number().int().min(1),
  }),
  reversibility: "reversible",
  actionKind: "regenerate_social_post",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    try {
      const updated = await regeneratePost(depsFrom(ctx), {
        post,
        expectedVersion: args.expectedVersion,
        byAgent: ctx.requestedBy === "agent",
      });
      return {
        summary: `Regenerated the post with a fresh angle (now v${updated.version}).`,
        data: compactPost(updated),
        target: { entity: "social_post", id: updated.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const createSocialPostVariant = defineMarketingTool({
  name: "create_social_post_variant",
  description:
    "Create up to 3 variants of a post (different hooks/angles, same goal/stage/tone/platform) as NEW rows — the original is untouched. Counts against the daily generation budget.",
  params: z.object({
    postId: z.string().min(1),
    n: z.number().int().min(1).max(3),
  }),
  reversibility: "reversible",
  actionKind: "create_social_post_variant",
  async existingTarget(args, ctx) {
    // Variants grow the post's batch — snapshot it so Reject prunes exactly
    // the added rows. A batch-less post creates a grouping batch (a create:
    // Reject archives its posts).
    const post = await getSocialPost(ctx.supabase, args.postId);
    return post?.batchId ? { entity: "social_post_batch", id: post.batchId } : null;
  },
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    try {
      const { posts, batchId } = await createPostVariants(depsFrom(ctx), {
        post,
        n: args.n,
        byAgent: ctx.requestedBy === "agent",
      });
      return {
        summary: `Created ${posts.length} variant(s) of the post — new drafts in the queue, the original untouched.`,
        data: { posts: posts.map(compactPost) },
        target: { entity: "social_post_batch", id: batchId },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const createSocialPost = defineMarketingTool({
  name: "create_social_post",
  description:
    "Create one post directly from provided fields (no model call) — for when the creator dictates the copy. funnelStage defaults from the goal.",
  params: z.object({
    platform: PlatformSchema,
    goal: GoalSchema,
    funnelStage: FunnelStageSchema.nullable(),
    tone: ToneSchema,
    body: z.string().min(1).max(5000),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(80)).max(8).nullable(),
    plannedPostAt: z.string().nullable(),
    audience: z.string().max(300).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "create_social_post",
  async execute(args, ctx) {
    if (args.body.length > PLATFORM_LIMITS[args.platform].charCap) {
      throw new MarketingToolError(
        `body exceeds the ${PLATFORM_LIMITS[args.platform].label} cap of ${PLATFORM_LIMITS[args.platform].charCap} characters`
      );
    }
    const post = await insertSocialPost(ctx.supabase, ctx.ownerId, {
      course_id: ctx.courseId,
      source_type: "manual",
      source_text: null,
      platform: args.platform,
      goal: args.goal,
      funnel_stage: args.funnelStage ?? GOAL_STAGE_MAP[args.goal],
      audience: args.audience,
      tone: args.tone,
      body: args.body,
      cta: args.cta,
      hashtags: (args.hashtags ?? []).slice(0, PLATFORM_LIMITS[args.platform].hashtagMax),
      planned_post_at: args.plannedPostAt,
    });
    await emitSocialEvent(ctx.supabase, ctx.courseId, "social_post_created", {
      postId: post.id,
      origin: "manual_create",
      byAgent: ctx.requestedBy === "agent",
    });
    return {
      summary: `Created a ${PLATFORM_LIMITS[args.platform].label} draft from the provided copy.`,
      data: compactPost(post),
      target: { entity: "social_post", id: post.id },
    };
  },
});

const updateSocialPost = defineMarketingTool({
  name: "update_social_post",
  description:
    "Apply a direct field patch to a post (body, cta, hashtags, imageAltText, audience, funnelStage, goal, tone, suggestedImageIdea, plannedPostAt) — a versioned write. Requires expectedVersion.",
  params: z.object({
    postId: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    body: z.string().min(1).nullable(),
    cta: z.string().max(200).nullable(),
    hashtags: z.array(z.string().max(80)).max(8).nullable(),
    imageAltText: z.string().max(500).nullable(),
    audience: z.string().max(300).nullable(),
    funnelStage: FunnelStageSchema.nullable(),
    goal: GoalSchema.nullable(),
    tone: ToneSchema.nullable(),
    suggestedImageIdea: z.string().max(240).nullable(),
    plannedPostAt: z.string().nullable(),
    /** Set true to explicitly CLEAR cta/plannedPostAt/imageAltText passed as null. */
    clearNulls: z.boolean().nullable(),
  }),
  reversibility: "reversible",
  actionKind: "update_social_post",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    const patch = SocialPostPatchSchema.parse(
      Object.fromEntries(
        Object.entries({
          body: args.body,
          cta: args.cta,
          hashtags: args.hashtags,
          imageAltText: args.imageAltText,
          audience: args.audience,
          funnelStage: args.funnelStage,
          goal: args.goal,
          tone: args.tone,
          suggestedImageIdea: args.suggestedImageIdea,
          plannedPostAt: args.plannedPostAt,
        }).filter(([k, v]) =>
          v !== null
            ? true
            : Boolean(args.clearNulls) && ["cta", "plannedPostAt", "imageAltText", "audience"].includes(k)
        )
      )
    );
    if (patch.body && patch.body.length > PLATFORM_LIMITS[post.platform].charCap) {
      throw new MarketingToolError(
        `body exceeds the ${PLATFORM_LIMITS[post.platform].label} cap of ${PLATFORM_LIMITS[post.platform].charCap} characters`
      );
    }
    try {
      const updated = await versionedUpdateSocialPost(ctx.supabase, post.id, args.expectedVersion, {
        ...(patch.body !== undefined && { body: patch.body }),
        ...(patch.cta !== undefined && { cta: patch.cta }),
        ...(patch.hashtags !== undefined && { hashtags: patch.hashtags }),
        ...(patch.imageAltText !== undefined && { image_alt_text: patch.imageAltText }),
        ...(patch.audience !== undefined && { audience: patch.audience }),
        ...(patch.funnelStage !== undefined && { funnel_stage: patch.funnelStage }),
        ...(patch.goal !== undefined && { goal: patch.goal }),
        ...(patch.tone !== undefined && { tone: patch.tone }),
        ...(patch.suggestedImageIdea !== undefined && { suggested_image_idea: patch.suggestedImageIdea }),
        ...(patch.plannedPostAt !== undefined && { planned_post_at: patch.plannedPostAt }),
      });
      await emitSocialEvent(ctx.supabase, ctx.courseId, "social_post_updated", {
        postId: updated.id,
        fieldsChanged: Object.keys(patch),
        byAgent: ctx.requestedBy === "agent",
      });
      return {
        summary: `Updated ${Object.keys(patch).join(", ")} (now v${updated.version}).`,
        data: compactPost(updated),
        target: { entity: "social_post", id: updated.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const deleteSocialPost = defineMarketingTool({
  name: "delete_social_post",
  description:
    "Soft-delete a post (archived + recoverable — hard purge is a later retention job). Reversal: unarchive via the revert log.",
  params: z.object({ postId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "delete_social_post",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    await requirePost(ctx, args.postId);
    const post = await softDeleteSocialPost(ctx.supabase, args.postId, ctx.services.clock.now());
    await emitSocialEvent(ctx.supabase, ctx.courseId, "social_post_status_changed", {
      postId: post.id,
      to: "archived",
      softDeleted: true,
    });
    return {
      summary: "Archived the post (soft delete — revert restores it).",
      data: compactPost(post),
      target: { entity: "social_post", id: post.id },
    };
  },
});

const markSocialPostStatus = defineMarketingTool({
  name: "mark_social_post_status",
  description:
    "Move a post through its lifecycle: draft → ready → planned → posted_manual → archived. posted_manual stamps the posted-manually timestamp (the creator posted it themselves on the platform).",
  params: z.object({
    postId: z.string().min(1),
    status: PostStatusSchema,
  }),
  reversibility: "reversible",
  actionKind: "mark_social_post_status",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    const before = await requirePost(ctx, args.postId);
    const post = await updatePostStatus(ctx.supabase, args.postId, args.status, ctx.services.clock.now());
    await emitSocialEvent(ctx.supabase, ctx.courseId, "social_post_status_changed", {
      postId: post.id,
      from: before.status,
      to: args.status,
    });
    return {
      summary:
        args.status === "posted_manual"
          ? "Marked posted manually — timestamp stamped; performance logging is now available."
          : `Status: ${before.status} → ${args.status}.`,
      data: compactPost(post),
      target: { entity: "social_post", id: post.id },
    };
  },
});

const attachSocialPostImage = defineMarketingTool({
  name: "attach_social_post_image",
  description:
    "Attach an ALREADY-UPLOADED image (its storage path under the creator's social folder) to a post, with server-side type/size/dimension validation. WiseSel never generates images — uploads only.",
  params: z.object({
    postId: z.string().min(1),
    storagePath: z.string().min(1),
    altText: z.string().max(500).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "attach_social_post_image",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    try {
      const result = await finalizeImageAttachment(
        { supabase: ctx.supabase, ownerId: ctx.ownerId, courseIdForEvents: ctx.courseId },
        { post, storagePath: args.storagePath, altText: args.altText }
      );
      return {
        summary: `Attached the image (${result.meta.width}×${result.meta.height}).${result.warning ? ` ${result.warning}` : ""}`,
        data: { post: compactPost(result.post), warning: result.warning },
        target: { entity: "social_post", id: post.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const removeSocialPostImage = defineMarketingTool({
  name: "remove_social_post_image",
  description:
    "Detach a post's image reference (the uploaded file is retained, so revert re-attaches it).",
  params: z.object({ postId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "remove_social_post_image",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    await requirePost(ctx, args.postId);
    const post = await removeImageAttachment(
      { supabase: ctx.supabase, ownerId: ctx.ownerId, courseIdForEvents: ctx.courseId },
      args.postId
    );
    return {
      summary: "Removed the image from the post (the file is retained).",
      data: compactPost(post),
      target: { entity: "social_post", id: post.id },
    };
  },
});

const rewriteForPlatformTool = defineMarketingTool({
  name: "rewrite_for_platform",
  description:
    "Rewrite a post natively for the other platform as a NEW draft (parentPostId links back; the original is never mutated).",
  params: z.object({
    postId: z.string().min(1),
    targetPlatform: PlatformSchema,
  }),
  reversibility: "reversible",
  actionKind: "rewrite_for_platform",
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    if (post.platform === args.targetPlatform) {
      throw new MarketingToolError(
        `The post is already a ${PLATFORM_LIMITS[args.targetPlatform].label} post — use revise_social_post or create_social_post_variant instead.`
      );
    }
    try {
      const created = await rewriteForPlatform(depsFrom(ctx), {
        post,
        targetPlatform: args.targetPlatform,
        byAgent: ctx.requestedBy === "agent",
      });
      return {
        summary: `Created a native ${PLATFORM_LIMITS[args.targetPlatform].label} version as a new draft (the original is untouched).`,
        data: compactPost(created),
        target: { entity: "social_post", id: created.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const updatePlannedPostTime = defineMarketingTool({
  name: "update_planned_post_time",
  description:
    "Set or clear a post's planned post time — a PLANNING LABEL for the creator's manual posting plan. Nothing fires from it; WiseSel never schedules or posts. Requires expectedVersion.",
  params: z.object({
    postId: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    plannedPostAt: z.string().nullable(),
  }),
  reversibility: "reversible",
  actionKind: "update_planned_post_time",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    await requirePost(ctx, args.postId);
    try {
      const updated = await versionedUpdateSocialPost(ctx.supabase, args.postId, args.expectedVersion, {
        planned_post_at: args.plannedPostAt,
      });
      await emitSocialEvent(ctx.supabase, ctx.courseId, "social_post_updated", {
        postId: updated.id,
        fieldsChanged: ["plannedPostAt"],
        byAgent: ctx.requestedBy === "agent",
      });
      return {
        summary: args.plannedPostAt
          ? `Planned post time set to ${args.plannedPostAt} (a label for the creator's manual plan — nothing is scheduled).`
          : "Cleared the planned post time.",
        data: compactPost(updated),
        target: { entity: "social_post", id: updated.id },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const logSocialPostPerformance = defineMarketingTool({
  name: "log_social_post_performance",
  description:
    "Log manual performance on a posted_manual post — metrics (impressions/likes/comments/shares/clicks) and/or a one-tap qualitative rating (flop/ok/good/viral). Feeds later closed-loop learning; changes nothing else.",
  params: z.object({
    postId: z.string().min(1),
    impressions: z.number().int().nonnegative().nullable(),
    likes: z.number().int().nonnegative().nullable(),
    comments: z.number().int().nonnegative().nullable(),
    shares: z.number().int().nonnegative().nullable(),
    clicks: z.number().int().nonnegative().nullable(),
    qualitative: z.enum(["flop", "ok", "good", "viral"]).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "log_social_post_performance",
  async existingTarget(args) {
    return { entity: "social_post", id: args.postId };
  },
  async execute(args, ctx) {
    const post = await requirePost(ctx, args.postId);
    if (post.status !== "posted_manual") {
      throw new MarketingToolError(
        "Performance can only be logged on a posted_manual post — mark it posted first (mark_social_post_status)."
      );
    }
    const performance = PostPerformanceSchema.parse({
      ...(args.impressions !== null && { impressions: args.impressions }),
      ...(args.likes !== null && { likes: args.likes }),
      ...(args.comments !== null && { comments: args.comments }),
      ...(args.shares !== null && { shares: args.shares }),
      ...(args.clicks !== null && { clicks: args.clicks }),
      ...(args.qualitative !== null && { qualitative: args.qualitative }),
      loggedAt: ctx.services.clock.now(),
      source: "manual" as const,
    });
    const updated = await upsertPostPerformance(ctx.supabase, post.id, performance);
    await emitSocialEvent(ctx.supabase, ctx.courseId, "social_post_performance_logged", {
      postId: post.id,
      qualitative: performance.qualitative ?? null,
      hasMetrics: performance.impressions !== undefined || performance.likes !== undefined,
    });
    return {
      summary: `Logged performance${performance.qualitative ? ` (${performance.qualitative})` : ""} on the post.`,
      data: compactPost(updated),
      target: { entity: "social_post", id: post.id },
    };
  },
});

export const socialPostTools = [
  // read & suggest (5)
  listSocialPostsTool,
  getSocialPostTool,
  getSocialVoiceProfileTool,
  suggestHashtagsTool,
  draftImageAltTextTool,
  // reversible writes (14)
  generateSocialPostDrafts,
  reviseSocialPost,
  changePostToneTool,
  regenerateSocialPost,
  createSocialPostVariant,
  createSocialPost,
  updateSocialPost,
  deleteSocialPost,
  markSocialPostStatus,
  attachSocialPostImage,
  removeSocialPostImage,
  rewriteForPlatformTool,
  updatePlannedPostTime,
  logSocialPostPerformance,
];

/** Platform enum re-export for the registry snapshot test. */
export { PLATFORMS as SOCIAL_TOOL_PLATFORMS, SOCIAL_GOALS, SOCIAL_TONES, POST_STATUSES };
