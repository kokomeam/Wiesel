/**
 * The batch generation pipeline (PRD §9.1) — ONE server-side path behind the
 * REST route, the hub button, and the agent tool:
 *
 *   1 resolve source context (token budget)   2 load-or-derive voice profile
 *   3 assemble prompt (cache-stable prefix)   4 ONE structured batch call
 *   5 Zod gate (+ exactly one repair call)    6 deterministic safety lint
 *   7 transactional persist + events          8 stream drafts via onDraft
 *
 * Quality over speed: no latency target — the model call runs under the hard
 * SOCIAL_GENERATION_TIMEOUT_MS ceiling (timeout ⇒ typed error, NOTHING
 * persisted, parameters kept for retry). The model call counts once against
 * the platform-wide two-concurrent-call semaphore. With no model configured
 * the deterministic template fallback keeps the engine whole (mock-first).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { withSemaphore } from "@/lib/ai/subagent";
import type { Clock } from "../services/types";
import {
  buildBatchPlan,
  socialConfig,
  type BatchPlanSlot,
  type SocialPlatform,
} from "./constants";
import { assembleSourceContext, type AssembledContext } from "./contextAssembly";
import { emitSocialEvent } from "./events";
import { SocialGenerationError, SocialRateLimitError } from "./errors";
import { lintGeneratedPost, lintRepairInstruction, type LintViolation } from "./lint";
import {
  buildGenerationInput,
  buildRepairInput,
  PROMPT_VERSION,
  SOCIAL_SYSTEM_PROMPT,
} from "./prompt";
import {
  countBatchesSince,
  createBatchWithPosts,
  findBatchByIdempotencyKey,
  getBatch,
  listPostsForBatch,
  loadSocialVoiceProfile,
  upsertSocialVoiceProfile,
  type PostPersistInput,
  type SocialBatch,
  type VoiceProfileRecord,
} from "./repository";
import {
  GeneratedPostSchema,
  ModelBatchSchema,
  type GenerateRequest,
  type ModelPost,
  type SocialPost,
} from "./schemas";
import { computePlannedTimes } from "./timing";
import { buildTemplatePosts } from "./templates";
import { collectVoiceDerivationInput, deriveVoiceProfile } from "./voice";

type DB = SupabaseClient<Database>;

export interface SocialPipelineDeps {
  supabase: DB;
  ownerId: string;
  /** Provider-agnostic model — absent ⇒ deterministic template fallback. */
  model?: ModelClient;
  clock: Clock;
  /** Injected randomness (timing jitter) — deterministic in tests. */
  rand?: () => number;
  /** The hub's course context — every analytics event rides on it. */
  courseIdForEvents: string;
}

export interface DroppedDraft {
  slot: number;
  rule: string;
  reason: string;
  excerpt: string;
}

export interface GenerateBatchResult {
  batch: SocialBatch;
  posts: SocialPost[];
  dropped: DroppedDraft[];
  replayed: boolean;
  /** Little real course content — surface the "more generic" warning. */
  thinContext: boolean;
  via: "model" | "template-fallback";
  repairUsed: boolean;
}

/** Midnight UTC of the clock's current day — the daily-budget window start. */
export function budgetWindowStart(nowIso: string): string {
  return `${nowIso.slice(0, 10)}T00:00:00.000Z`;
}

/** Load the creator's voice profile, deriving + persisting it on first use. */
export async function ensureSocialVoiceProfile(
  deps: Pick<SocialPipelineDeps, "supabase" | "ownerId" | "model" | "courseIdForEvents">
): Promise<VoiceProfileRecord> {
  const existing = await loadSocialVoiceProfile(deps.supabase, deps.ownerId);
  if (existing) return existing;
  const input = await collectVoiceDerivationInput(deps.supabase, deps.ownerId);
  const { profile, via } = await deriveVoiceProfile(deps.model, input);
  const record = await upsertSocialVoiceProfile(deps.supabase, deps.ownerId, profile, "derived");
  await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_voice_profile_derived", {
    via,
    version: record.version,
  });
  return record;
}

interface ModelCallOutcome {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

async function runBatchModelCall(
  model: ModelClient,
  args: { system: string; input: string; formatName: string; schema: ReturnType<typeof toStrictJsonSchema> }
): Promise<ModelCallOutcome> {
  const cfg = socialConfig();
  const result = await model.runTurn(
    {
      system: args.system,
      input: [{ role: "developer", content: args.input }],
      tools: [],
      stream: false,
      timeoutMs: cfg.generationTimeoutMs,
      maxRetries: 1,
      model: cfg.generateModel,
      effort: cfg.generateEffort,
      responseFormat: { name: args.formatName, schema: args.schema },
    },
    () => {}
  );
  if (result.finishReason === "error") {
    const stage = result.errorKind === "transport_timeout" ? "timeout" : "model";
    throw new SocialGenerationError(
      stage,
      stage === "timeout"
        ? "Generation hit the 3-minute ceiling. Nothing was saved — your setup is kept, try again."
        : "The model call failed. Nothing was saved — your setup is kept, try again."
    );
  }
  return { text: result.text, usage: result.usage };
}

function parseModelBatch(text: string): { posts: ModelPost[] } | { issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { issues: ["response was not valid JSON"] };
  }
  const parsed = ModelBatchSchema.safeParse(raw);
  if (!parsed.success) {
    return { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { posts: parsed.data.posts };
}

interface Candidate {
  slot: number;
  post: ModelPost;
  plannedPostAt: string | null;
  violations: LintViolation[];
}

/** Slot-zip + per-post validation: the PLAN wins on goal/stage/tone, hashtags
 *  clamp to the platform max (clamp-not-reject), platform caps + safety lint
 *  flag the rest. */
function buildCandidates(
  posts: ModelPost[],
  slots: BatchPlanSlot[],
  platform: SocialPlatform,
  tone: GenerateRequest["tone"],
  times: (string | null)[],
  sourceContext: string,
  hashtagMax: number
): Candidate[] {
  return posts.slice(0, slots.length).map((raw, i) => {
    const slot = slots[i];
    const post: ModelPost = {
      ...raw,
      goal: slot.goal,
      funnelStage: slot.funnelStage,
      tone,
      hashtags: raw.hashtags.slice(0, hashtagMax),
    };
    const violations: LintViolation[] = [];
    const shapeCheck = GeneratedPostSchema.safeParse({
      ...post,
      platform,
      plannedPostAt: times[i] ?? null,
    });
    if (!shapeCheck.success) {
      for (const issue of shapeCheck.error.issues) {
        violations.push({
          rule: "platform_limits",
          reason: issue.message,
          excerpt: post.body.slice(0, 80),
        });
      }
    }
    violations.push(...lintGeneratedPost({ platform, body: post.body, cta: post.cta, hashtags: post.hashtags }, sourceContext));
    return { slot: i + 1, post, plannedPostAt: times[i] ?? null, violations };
  });
}

/**
 * Generate a batch of drafts (PRD §9.1). Throws:
 *   SocialRateLimitError   — daily batch budget exhausted (HTTP 429)
 *   SocialGenerationError  — model/zod/repair/lint/timeout failure; NOTHING
 *                            persisted, parameters kept for retry
 */
export async function generateSocialBatch(
  deps: SocialPipelineDeps,
  req: GenerateRequest,
  opts: {
    idempotencyKey?: string | null;
    requestedBy?: "user" | "agent";
    onDraft?: (post: SocialPost) => void;
    onPhase?: (phase: "context" | "voice" | "model" | "validate" | "persist") => void;
  } = {}
): Promise<GenerateBatchResult> {
  const cfg = socialConfig();
  const rand = deps.rand ?? Math.random;
  const nowIso = deps.clock.now();
  const startedAt = deps.clock.epochMs();

  // Idempotency replay — before any budget or model spend.
  if (opts.idempotencyKey) {
    const existing = await findBatchByIdempotencyKey(deps.supabase, opts.idempotencyKey);
    if (existing) {
      const posts = await listPostsForBatch(deps.supabase, existing.id);
      for (const p of posts) opts.onDraft?.(p);
      return {
        batch: existing,
        posts,
        dropped: [],
        replayed: true,
        thinContext: false,
        via: (existing.aiMetadata.model as string) === "template-fallback" ? "template-fallback" : "model",
        repairUsed: Boolean(existing.aiMetadata.repairUsed),
      };
    }
  }

  // Daily batch budget (config, not constant).
  const batchesToday = await countBatchesSince(deps.supabase, budgetWindowStart(nowIso));
  if (batchesToday >= cfg.maxBatchesPerDay) {
    throw new SocialRateLimitError("batches", cfg.maxBatchesPerDay);
  }

  try {
    opts.onPhase?.("context");
    const context: AssembledContext = await assembleSourceContext(
      deps.supabase,
      req,
      cfg.contextMaxTokens
    );

    opts.onPhase?.("voice");
    const voice = await ensureSocialVoiceProfile(deps);

    const slots = buildBatchPlan(req.count, req.funnelMix, req.goal ?? "value");
    const times = computePlannedTimes({
      preset: req.timingPreset,
      count: slots.length,
      nowIso,
      timeZone: req.timeZone,
      rand,
      customTimes: req.customTimes,
    });
    const hashtagMax = req.platform === "linkedin" ? 5 : 3;

    opts.onPhase?.("model");
    const model = deps.model ? withSemaphore(deps.model) : undefined;
    let repairUsed = false;
    let via: "model" | "template-fallback" = "model";
    let usage: ModelCallOutcome["usage"];
    let modelPosts: ModelPost[];

    if (!model) {
      via = "template-fallback";
      modelPosts = buildTemplatePosts(slots, req.platform, req.tone, context.template);
    } else {
      const schema = toStrictJsonSchema(ModelBatchSchema);
      const generationInput = buildGenerationInput({
        voice: voice.profile,
        sourceContext: context.text,
        request: { platform: req.platform, slots, tone: req.tone },
      });
      const first = await runBatchModelCall(model, {
        system: SOCIAL_SYSTEM_PROMPT,
        input: generationInput,
        formatName: "social_post_batch",
        schema,
      });
      usage = first.usage;
      let parsed = parseModelBatch(first.text);
      let issues = "issues" in parsed ? parsed.issues : [];
      if (!("posts" in parsed) || parsed.posts.length < slots.length) {
        if ("posts" in parsed) {
          issues = [`expected exactly ${slots.length} posts, got ${parsed.posts.length}`];
        }
        // The ONE repair call (small tier semantics ride the same ceiling).
        repairUsed = true;
        const repaired = await runBatchModelCall(model, {
          system: SOCIAL_SYSTEM_PROMPT,
          input: buildRepairInput({
            originalInput: generationInput,
            invalidJson: first.text,
            issues,
          }),
          formatName: "social_post_batch_repair",
          schema,
        });
        parsed = parseModelBatch(repaired.text);
        if (!("posts" in parsed) || parsed.posts.length === 0) {
          throw new SocialGenerationError(
            "repair",
            "The model returned an invalid batch twice. Nothing was saved — your setup is kept, try again."
          );
        }
      }
      modelPosts = parsed.posts;
    }

    opts.onPhase?.("validate");
    let candidates = buildCandidates(
      modelPosts,
      slots,
      req.platform,
      req.tone,
      times,
      `${context.text}\n${req.sourceText ?? ""}`,
      hashtagMax
    );

    // Flagged posts get the single repair pass (if unused), else drop.
    const flagged = candidates.filter((c) => c.violations.length > 0);
    if (flagged.length > 0 && model && !repairUsed) {
      repairUsed = true;
      const schema = toStrictJsonSchema(ModelBatchSchema);
      const issues = flagged.flatMap((c) =>
        c.violations.map((v) => `post ${c.slot}: ${lintRepairInstruction([v]).split("\n")[1] ?? v.reason}`)
      );
      const generationInput = buildGenerationInput({
        voice: voice.profile,
        sourceContext: context.text,
        request: { platform: req.platform, slots, tone: req.tone },
      });
      try {
        const repaired = await runBatchModelCall(model, {
          system: SOCIAL_SYSTEM_PROMPT,
          input: buildRepairInput({
            originalInput: generationInput,
            invalidJson: JSON.stringify({ posts: candidates.map((c) => c.post) }),
            issues,
          }),
          formatName: "social_post_batch_repair",
          schema,
        });
        const reparsed = parseModelBatch(repaired.text);
        if ("posts" in reparsed && reparsed.posts.length > 0) {
          candidates = buildCandidates(
            reparsed.posts,
            slots,
            req.platform,
            req.tone,
            times,
            `${context.text}\n${req.sourceText ?? ""}`,
            hashtagMax
          );
        }
      } catch {
        // Repair failure here is non-fatal: clean originals still ship, the
        // flagged ones drop below.
      }
    }

    const surviving = candidates.filter((c) => c.violations.length === 0);
    const dropped: DroppedDraft[] = candidates
      .filter((c) => c.violations.length > 0)
      .map((c) => ({
        slot: c.slot,
        rule: c.violations[0].rule,
        reason: c.violations[0].reason,
        excerpt: c.violations[0].excerpt,
      }));

    if (surviving.length === 0) {
      throw new SocialGenerationError(
        "lint",
        `Every draft was removed by the safety lint (${dropped[0]?.reason ?? "policy violation"}). Nothing was saved — adjust the goal or add real context, then try again.`
      );
    }

    opts.onPhase?.("persist");
    const latencyMs = deps.clock.epochMs() - startedAt;
    const batchMeta = {
      model: via === "template-fallback" ? "template-fallback" : (socialConfig().generateModel ?? "provider-default"),
      promptVersion: PROMPT_VERSION,
      latencyMs,
      repairUsed,
      usage: usage ?? null,
      dropped: dropped.map((d) => ({ slot: d.slot, rule: d.rule })),
      thinContext: context.thin,
    };
    const postInputs: PostPersistInput[] = surviving.map((c) => ({
      goal: c.post.goal,
      funnelStage: c.post.funnelStage,
      audience: context.course?.audience ?? null,
      tone: c.post.tone,
      body: c.post.body,
      cta: c.post.cta,
      hashtags: c.post.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)),
      suggestedImageIdea: c.post.suggestedImageIdea,
      plannedPostAt: c.plannedPostAt,
      aiMetadata: {
        model: batchMeta.model,
        promptVersion: PROMPT_VERSION,
        voiceProfileVersion: voice.version,
      },
    }));

    const { batchId, replayed } = await createBatchWithPosts(
      deps.supabase,
      {
        courseId: req.courseId ?? null,
        moduleId: req.moduleId ?? null,
        lessonId: req.lessonId ?? null,
        sourceType: req.sourceType,
        sourceText: req.sourceText ?? null,
        platform: req.platform,
        requestedCount: req.count,
        funnelMix: req.funnelMix,
        timingPreset: req.timingPreset,
        idempotencyKey: opts.idempotencyKey ?? null,
        aiMetadata: batchMeta,
      },
      postInputs
    );

    const batch = (await getBatch(deps.supabase, batchId))!;
    const posts = await listPostsForBatch(deps.supabase, batchId);

    if (!replayed) {
      await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_batch_generated", {
        batchId,
        count: posts.length,
        funnelMix: req.funnelMix,
        platform: req.platform,
        latencyMs,
        repairUsed,
        droppedCount: dropped.length,
        via,
      });
      for (const p of posts) {
        await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_created", {
          postId: p.id,
          origin: "generate",
          byAgent: opts.requestedBy === "agent",
        });
      }
    }
    for (const p of posts) opts.onDraft?.(p);

    return {
      batch,
      posts,
      dropped,
      replayed,
      thinContext: context.thin,
      via,
      repairUsed,
    };
  } catch (err) {
    const stage =
      err instanceof SocialGenerationError ? err.stage : err instanceof SocialRateLimitError ? null : "model";
    if (stage) {
      await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_generation_failed", {
        stage,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}
