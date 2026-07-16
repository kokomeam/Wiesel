/**
 * Single-post model operations (PRD §9.6) — the shared service behind the
 * editor's AI buttons, the REST routes, and the agent tools (all of which go
 * through executeMarketingTool, so every one of these leaves a gate-ledger
 * row → revert entry → the per-day revision budget can count the ledger).
 *
 * Small-tier calls, Zod-gated with one retry, safety-linted before any write,
 * versioned writes only. Freeform ops (revise/retone/regenerate/rewrite/
 * variants) REQUIRE a model; suggest_hashtags and alt-text keep deterministic
 * fallbacks (mock-first).
 */

import type { ModelClient } from "@/lib/ai/modelClient";
import { z } from "zod";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { withSemaphore } from "@/lib/ai/subagent";
import { socialConfig, type SocialPlatform, type SocialPostPlatform, type SocialTone, PLATFORM_LIMITS, platformLimitsFor } from "./constants";
import { assembleSourceContext } from "./contextAssembly";
import { emitSocialEvent } from "./events";
import {
  SocialGenerationError,
  SocialModelUnavailableError,
  SocialRateLimitError,
} from "./errors";
import { lintGeneratedPost } from "./lint";
import {
  buildRevisionInput,
  PROMPT_VERSION,
  SOCIAL_REVISION_SYSTEM_PROMPT,
} from "./prompt";
import {
  countRevisionActionsSince,
  insertBatchRow,
  insertSocialPost,
  versionedUpdateSocialPost,
  type VoiceProfileRecord,
} from "./repository";
import { budgetWindowStart, ensureSocialVoiceProfile, type SocialPipelineDeps } from "./generate";
import { GoalSchema, type SocialPost } from "./schemas";
import { suggestHashtagsDeterministic } from "./templates";

/** The model-backed tools whose gate-ledger rows count against the per-day
 *  revision budget (SOCIAL_MAX_REVISIONS_PER_DAY). */
export const SOCIAL_MODEL_REVISION_TOOLS = [
  "revise_social_post",
  "change_post_tone",
  "regenerate_social_post",
  "create_social_post_variant",
  "rewrite_for_platform",
] as const;

const HASHTAG_STRIP = /[^\p{L}\p{N}_#]/gu;

const RevisionResultSchema = z.object({
  body: z.string().min(30),
  cta: z.string().max(200).nullable(),
  hashtags: z.array(z.string().min(1).max(80)).max(8),
  suggestedImageIdea: z.string().max(240).nullable(),
});
type RevisionResult = z.infer<typeof RevisionResultSchema>;

const VariantsResultSchema = z.object({
  variants: z.array(RevisionResultSchema).min(1).max(3),
});

async function assertRevisionBudget(deps: SocialPipelineDeps): Promise<void> {
  const cfg = socialConfig();
  const used = await countRevisionActionsSince(
    deps.supabase,
    [...SOCIAL_MODEL_REVISION_TOOLS],
    budgetWindowStart(deps.clock.now())
  );
  if (used >= cfg.maxRevisionsPerDay) throw new SocialRateLimitError("revisions", cfg.maxRevisionsPerDay);
}

function requireModel(deps: SocialPipelineDeps, op: string): ModelClient {
  if (!deps.model) throw new SocialModelUnavailableError(op);
  return withSemaphore(deps.model);
}

async function sourceContextForPost(deps: SocialPipelineDeps, post: SocialPost): Promise<string> {
  const cfg = socialConfig();
  const ctx = await assembleSourceContext(
    deps.supabase,
    {
      sourceType: post.sourceType,
      courseId: post.courseId ?? undefined,
      moduleId: post.moduleId ?? undefined,
      lessonId: post.lessonId ?? undefined,
      sourceText: post.sourceText ?? undefined,
    },
    cfg.contextMaxTokens
  );
  return ctx.text;
}

function cleanHashtags(tags: string[], platform: SocialPostPlatform): string[] {
  const max = platformLimitsFor(platform).hashtagMax;
  return tags
    .map((t) => t.replace(HASHTAG_STRIP, ""))
    .filter((t) => t.replace("#", "").length > 0)
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .slice(0, max);
}

/** Run one small-tier revision call: parse → clean → platform-cap → lint.
 *  Throws SocialGenerationError on double parse failure or a lint violation
 *  (a revision must never smuggle in a fabricated claim). */
async function runRevisionCall(
  model: ModelClient,
  args: {
    voice: VoiceProfileRecord;
    sourceContext: string;
    post: SocialPost;
    instruction: string;
    targetPlatform?: SocialPlatform;
    formatName?: string;
  }
): Promise<RevisionResult> {
  const cfg = socialConfig();
  const platform = args.targetPlatform ?? args.post.platform;
  const schema = toStrictJsonSchema(RevisionResultSchema);
  const input = buildRevisionInput({
    voice: args.voice.profile,
    sourceContext: args.sourceContext,
    post: {
      platform: args.post.platform,
      body: args.post.body,
      cta: args.post.cta,
      hashtags: args.post.hashtags,
      tone: args.post.tone,
    },
    instruction: args.instruction,
    targetPlatform: args.targetPlatform,
  });

  let lastIssues = "invalid response";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await model.runTurn(
      {
        system: SOCIAL_REVISION_SYSTEM_PROMPT,
        input: [{ role: "developer", content: input }],
        tools: [],
        stream: false,
        timeoutMs: cfg.generationTimeoutMs,
        maxRetries: 1,
        model: cfg.reviseModel,
        effort: cfg.reviseEffort,
        responseFormat: { name: args.formatName ?? "social_post_revision", schema },
      },
      () => {}
    );
    if (result.finishReason === "error") {
      throw new SocialGenerationError(
        result.errorKind === "transport_timeout" ? "timeout" : "model",
        "The revision call failed — the post was left untouched. Try again."
      );
    }
    try {
      const parsed = RevisionResultSchema.safeParse(JSON.parse(result.text));
      if (!parsed.success) {
        lastIssues = parsed.error.issues.map((i) => i.message).join("; ");
        continue;
      }
      const revised: RevisionResult = {
        ...parsed.data,
        hashtags: cleanHashtags(parsed.data.hashtags, platform),
      };
      if (revised.body.length > platformLimitsFor(platform).charCap) {
        lastIssues = `body exceeds the ${platformLimitsFor(platform).label} cap`;
        continue;
      }
      const violations = lintGeneratedPost(
        { platform, body: revised.body, cta: revised.cta, hashtags: revised.hashtags },
        `${args.sourceContext}\n${args.post.body}`
      );
      if (violations.length > 0) {
        throw new SocialGenerationError(
          "lint",
          `The revision was rejected: ${violations[0].reason}. The post was left untouched.`
        );
      }
      return revised;
    } catch (err) {
      if (err instanceof SocialGenerationError) throw err;
      lastIssues = "response was not valid JSON";
    }
  }
  throw new SocialGenerationError(
    "repair",
    `The model returned an invalid revision twice (${lastIssues}). The post was left untouched.`
  );
}

/** Free-form instruction revision (reviseSocialPost + the editor AI buttons). */
export async function revisePost(
  deps: SocialPipelineDeps,
  args: {
    post: SocialPost;
    expectedVersion: number;
    instruction: string;
    byAgent: boolean;
    toolName: string;
  }
): Promise<{ post: SocialPost; rationale: string }> {
  await assertRevisionBudget(deps);
  const model = requireModel(deps, "Revising a post");
  const voice = await ensureSocialVoiceProfile(deps);
  const sourceContext = await sourceContextForPost(deps, args.post);
  const revised = await runRevisionCall(model, {
    voice,
    sourceContext,
    post: args.post,
    instruction: args.instruction,
  });
  const updated = await versionedUpdateSocialPost(deps.supabase, args.post.id, args.expectedVersion, {
    body: revised.body,
    cta: revised.cta,
    hashtags: revised.hashtags,
    suggested_image_idea: revised.suggestedImageIdea ?? args.post.suggestedImageIdea,
    ai_metadata: {
      ...args.post.aiMetadata,
      promptVersion: PROMPT_VERSION,
      lastRevision: { instruction: args.instruction, toolName: args.toolName },
    } as never,
  });
  await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_revised_by_agent", {
    postId: updated.id,
    instruction: args.instruction,
    toolName: args.toolName,
    byAgent: args.byAgent,
  });
  return { post: updated, rationale: args.instruction };
}

/** Explicit tone change — rewrites the copy AND updates the stored tone. */
export async function changePostTone(
  deps: SocialPipelineDeps,
  args: { post: SocialPost; expectedVersion: number; targetTone: SocialTone; byAgent: boolean }
): Promise<SocialPost> {
  await assertRevisionBudget(deps);
  const model = requireModel(deps, "Changing a post's tone");
  const voice = await ensureSocialVoiceProfile(deps);
  const sourceContext = await sourceContextForPost(deps, args.post);
  const revised = await runRevisionCall(model, {
    voice,
    sourceContext,
    post: args.post,
    instruction: `Rewrite this post in a ${args.targetTone.replace("_", "-")} tone. Keep the substance, structure it for the same platform, keep every factual claim unchanged.`,
  });
  const updated = await versionedUpdateSocialPost(deps.supabase, args.post.id, args.expectedVersion, {
    body: revised.body,
    cta: revised.cta,
    hashtags: revised.hashtags,
    tone: args.targetTone,
    ai_metadata: {
      ...args.post.aiMetadata,
      promptVersion: PROMPT_VERSION,
      lastRevision: { instruction: `tone → ${args.targetTone}`, toolName: "change_post_tone" },
    } as never,
  });
  await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_revised_by_agent", {
    postId: updated.id,
    instruction: `tone → ${args.targetTone}`,
    toolName: "change_post_tone",
    byAgent: args.byAgent,
  });
  return updated;
}

/** Fresh take on the same slot — re-runs generation with the post's stored
 *  parameters through the full revision gate. */
export async function regeneratePost(
  deps: SocialPipelineDeps,
  args: { post: SocialPost; expectedVersion: number; byAgent: boolean }
): Promise<SocialPost> {
  await assertRevisionBudget(deps);
  const model = requireModel(deps, "Regenerating a post");
  const voice = await ensureSocialVoiceProfile(deps);
  const sourceContext = await sourceContextForPost(deps, args.post);
  const revised = await runRevisionCall(model, {
    voice,
    sourceContext,
    post: args.post,
    instruction: `Write a completely fresh take on this post — same goal (${args.post.goal}), same funnel stage (${args.post.funnelStage}), same tone (${args.post.tone}), same platform — but a different angle, hook, and structure. Do not reuse the existing sentences.`,
  });
  const updated = await versionedUpdateSocialPost(deps.supabase, args.post.id, args.expectedVersion, {
    body: revised.body,
    cta: revised.cta,
    hashtags: revised.hashtags,
    suggested_image_idea: revised.suggestedImageIdea ?? args.post.suggestedImageIdea,
    ai_metadata: {
      ...args.post.aiMetadata,
      promptVersion: PROMPT_VERSION,
      lastRevision: { instruction: "fresh take", toolName: "regenerate_social_post" },
    } as never,
  });
  await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_revised_by_agent", {
    postId: updated.id,
    instruction: "fresh take (regenerate)",
    toolName: "regenerate_social_post",
    byAgent: args.byAgent,
  });
  return updated;
}

/** "Rewrite for X" — a NEW post row on the target platform;
 *  aiMetadata.parentPostId links back and the original is never mutated. */
export async function rewriteForPlatform(
  deps: SocialPipelineDeps,
  args: { post: SocialPost; targetPlatform: SocialPlatform; byAgent: boolean }
): Promise<SocialPost> {
  await assertRevisionBudget(deps);
  const model = requireModel(deps, "Rewriting for another platform");
  const voice = await ensureSocialVoiceProfile(deps);
  const sourceContext = await sourceContextForPost(deps, args.post);
  const revised = await runRevisionCall(model, {
    voice,
    sourceContext,
    post: args.post,
    instruction: `Rewrite this post natively for ${PLATFORM_LIMITS[args.targetPlatform].label}. Follow that platform's register, length, structure, and hashtag rules — never just trim the original.`,
    targetPlatform: args.targetPlatform,
  });
  const created = await insertSocialPost(deps.supabase, deps.ownerId, {
    course_id: args.post.courseId,
    module_id: args.post.moduleId,
    lesson_id: args.post.lessonId,
    campaign_id: args.post.campaignId,
    batch_id: null,
    batch_order: null,
    source_type: args.post.sourceType,
    source_text: args.post.sourceText,
    platform: args.targetPlatform,
    goal: args.post.goal,
    funnel_stage: args.post.funnelStage,
    audience: args.post.audience,
    tone: args.post.tone,
    body: revised.body,
    cta: revised.cta,
    hashtags: revised.hashtags,
    suggested_image_idea: revised.suggestedImageIdea ?? args.post.suggestedImageIdea,
    planned_post_at: null,
    ai_metadata: {
      model: socialConfig().reviseModel ?? "provider-default",
      promptVersion: PROMPT_VERSION,
      parentPostId: args.post.id,
    } as never,
  });
  await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_created", {
    postId: created.id,
    origin: "rewrite_for_platform",
    parentPostId: args.post.id,
    byAgent: args.byAgent,
  });
  return created;
}

/** Up to 3 variants — new rows sharing the original's batch (a grouping
 *  batch is created when the post has none, so the whole set stays
 *  revertable as one unit), aiMetadata.variantOf set. */
export async function createPostVariants(
  deps: SocialPipelineDeps,
  args: { post: SocialPost; n: number; byAgent: boolean }
): Promise<{ posts: SocialPost[]; batchId: string }> {
  await assertRevisionBudget(deps);
  const model = requireModel(deps, "Creating variants");
  const voice = await ensureSocialVoiceProfile(deps);
  const sourceContext = await sourceContextForPost(deps, args.post);
  const cfg = socialConfig();
  const n = Math.max(1, Math.min(3, Math.floor(args.n)));
  const schema = toStrictJsonSchema(VariantsResultSchema);
  const input = buildRevisionInput({
    voice: voice.profile,
    sourceContext,
    post: {
      platform: args.post.platform,
      body: args.post.body,
      cta: args.post.cta,
      hashtags: args.post.hashtags,
      tone: args.post.tone,
    },
    instruction: `Write ${n} distinct variants of this post — different hooks and angles, same goal/stage/tone/platform.`,
  });

  let variants: RevisionResult[] | null = null;
  for (let attempt = 0; attempt < 2 && !variants; attempt++) {
    const result = await model.runTurn(
      {
        system: SOCIAL_REVISION_SYSTEM_PROMPT,
        input: [{ role: "developer", content: input }],
        tools: [],
        stream: false,
        timeoutMs: cfg.generationTimeoutMs,
        maxRetries: 1,
        model: cfg.reviseModel,
        effort: cfg.reviseEffort,
        responseFormat: { name: "social_post_variants", schema },
      },
      () => {}
    );
    if (result.finishReason === "error") {
      throw new SocialGenerationError("model", "The variants call failed — nothing was created.");
    }
    try {
      const parsed = VariantsResultSchema.safeParse(JSON.parse(result.text));
      if (parsed.success) variants = parsed.data.variants;
    } catch {
      /* retry */
    }
  }
  if (!variants) {
    throw new SocialGenerationError("repair", "The model returned invalid variants twice — nothing was created.");
  }

  // Variants always ride a batch so the set stays revertable as one unit.
  let batchId = args.post.batchId;
  if (!batchId) {
    const batch = await insertBatchRow(deps.supabase, deps.ownerId, {
      course_id: args.post.courseId,
      module_id: args.post.moduleId,
      lesson_id: args.post.lessonId,
      source_type: args.post.sourceType,
      source_text: args.post.sourceText,
      platform: args.post.platform,
      requested_count: n,
      funnel_mix: "pinned",
      timing_preset: "none",
      ai_metadata: { origin: "variants", variantOf: args.post.id } as never,
    });
    batchId = batch.id;
  }

  const created: SocialPost[] = [];
  for (const v of variants.slice(0, n)) {
    const hashtags = cleanHashtags(v.hashtags, args.post.platform);
    const violations = lintGeneratedPost(
      { platform: args.post.platform, body: v.body, cta: v.cta, hashtags },
      `${sourceContext}\n${args.post.body}`
    );
    if (violations.length > 0) continue; // a bad variant is skipped, not saved
    const row = await insertSocialPost(deps.supabase, deps.ownerId, {
      course_id: args.post.courseId,
      module_id: args.post.moduleId,
      lesson_id: args.post.lessonId,
      campaign_id: args.post.campaignId,
      source_type: args.post.sourceType,
      source_text: args.post.sourceText,
      platform: args.post.platform,
      goal: args.post.goal,
      funnel_stage: args.post.funnelStage,
      audience: args.post.audience,
      tone: args.post.tone,
      body: v.body,
      cta: v.cta,
      hashtags,
      suggested_image_idea: v.suggestedImageIdea ?? args.post.suggestedImageIdea,
      planned_post_at: null,
      batch_id: batchId,
      batch_order: null,
      ai_metadata: {
        model: cfg.reviseModel ?? "provider-default",
        promptVersion: PROMPT_VERSION,
        variantOf: args.post.id,
      } as never,
    });
    created.push(row);
    await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_created", {
      postId: row.id,
      origin: "variant",
      variantOf: args.post.id,
      byAgent: args.byAgent,
    });
  }
  if (created.length === 0) {
    throw new SocialGenerationError("lint", "Every variant was removed by the safety lint — nothing was created.");
  }
  return { posts: created, batchId };
}

/** Hashtag suggestions — small-tier model, deterministic fallback. Returns a
 *  list; writes nothing (the caller decides). */
export async function suggestHashtags(
  deps: SocialPipelineDeps,
  args: { text: string; platform: SocialPostPlatform }
): Promise<string[]> {
  if (!deps.model) return suggestHashtagsDeterministic(args.text, args.platform);
  const cfg = socialConfig();
  const max = platformLimitsFor(args.platform).hashtagMax;
  const schema = toStrictJsonSchema(z.object({ hashtags: z.array(z.string()).max(8) }));
  try {
    const result = await withSemaphore(deps.model).runTurn(
      {
        system:
          "Suggest relevant, specific, non-spammy hashtags for the given social post. Return JSON matching the schema.",
        input: [
          {
            role: "developer",
            content: `PLATFORM: ${args.platform} (max ${max} hashtags)\nPOST:\n${args.text.slice(0, 4000)}`,
          },
        ],
        tools: [],
        stream: false,
        model: cfg.reviseModel,
        effort: cfg.reviseEffort,
        responseFormat: { name: "social_hashtags", schema },
      },
      () => {}
    );
    const parsed = z.object({ hashtags: z.array(z.string()) }).safeParse(JSON.parse(result.text));
    if (parsed.success) {
      const cleaned = cleanHashtags(parsed.data.hashtags, args.platform);
      if (cleaned.length > 0) return cleaned;
    }
  } catch {
    /* fall through */
  }
  return suggestHashtagsDeterministic(args.text, args.platform);
}

/** Alt-text draft — returned as a SUGGESTION; written only when the creator
 *  asks (then via the versioned patch). Never auto-written (PRD §15). */
export async function draftImageAltText(
  deps: SocialPipelineDeps,
  args: { post: SocialPost }
): Promise<string> {
  const fallback = args.post.suggestedImageIdea
    ? `${args.post.suggestedImageIdea.replace(/^photo of /i, "A photo of ")}`
    : `An image supporting the post: ${args.post.body.split(/(?<=[.!?])\s/)[0].slice(0, 120)}`;
  if (!deps.model) return fallback.slice(0, 300);
  const cfg = socialConfig();
  const schema = toStrictJsonSchema(z.object({ altText: z.string().min(5).max(300) }));
  try {
    const result = await withSemaphore(deps.model).runTurn(
      {
        system:
          "Write concise, descriptive alt text (one sentence, no 'image of' prefix) for the image attached to this social post, based on the post content and the stated image idea.",
        input: [
          {
            role: "developer",
            content: `POST:\n${args.post.body.slice(0, 2000)}\n\nIMAGE IDEA: ${args.post.suggestedImageIdea ?? "(none stated)"}\nEXISTING ALT: ${args.post.imageAltText ?? "(none)"}`,
          },
        ],
        tools: [],
        stream: false,
        model: cfg.reviseModel,
        effort: cfg.reviseEffort,
        responseFormat: { name: "social_alt_text", schema },
      },
      () => {}
    );
    const parsed = z.object({ altText: z.string() }).safeParse(JSON.parse(result.text));
    if (parsed.success && parsed.data.altText.trim().length >= 5) return parsed.data.altText.trim().slice(0, 300);
  } catch {
    /* fall through */
  }
  return fallback.slice(0, 300);
}

/** Re-export for callers that need the goal enum for manual creates. */
export { GoalSchema };
