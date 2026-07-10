/**
 * Lesson Clip Repurposing tools (Marketing Phase 1.5, M-A slice — PRD §13):
 * 1 read + 2 reversible writes, ZERO irreversible (auto-commit + revert log,
 * no approval cards — the §13 header rule). REST routes, the clips UI, and
 * the agent all call these through executeMarketingTool → the gate.
 *
 * Behavioral contract (§13): summaries explain WHY a moment ranks well in
 * creator terms (the rubric rationale, never a scores dump); the funnel-
 * balanced default is proposed when the creator doesn't specify stages.
 * Later milestones add generate_lesson_clips / cancel_clip_job / posting-kit
 * / short-link tools with their infrastructure (M-B..M-D).
 */

import { z } from "zod";
import {
  CLIP_AUDIOGRAM_CAVEAT,
  CLIP_LAYOUT_LABELS,
  CLIP_MAX_CANDIDATES,
  CLIP_PLATFORM_SPECS,
  CLIP_PLATFORMS,
  FUNNEL_STAGES,
} from "../clips/constants";
import { coursePreviewPath } from "../ctaDestination";
import { generatePostingKit, isClipPlatform } from "../clips/postingKit";
import { emitClipEvent } from "../clips/events";
import {
  ClipGenerationError,
  ClipModelUnavailableError,
  ClipTranscriptUnavailableError,
} from "../clips/errors";
import { createMuxFrameInspector } from "../clips/format";
import { getCandidate, listCandidatesForLesson, updateCandidateStatus } from "../clips/repository";
import { selectClipMoments, type ClipPipelineDeps } from "../clips/selection";
import { createReapProvider, isReapConfigured } from "../clips/provider/reapClient";
import { createMuxPrecutOps } from "../clips/render/precut";
import { listRenderJobsForLesson, type ClipRenderJob } from "../clips/render/jobs";
import {
  cancelRenderJob,
  ClipRenderError,
  createClipRenderJob,
} from "../clips/render/service";
import type { ClipMomentCandidate } from "../clips/schemas";
import { defineMarketingTool, MarketingToolError, type MarketingToolContext } from "./types";

function depsFrom(ctx: MarketingToolContext): ClipPipelineDeps {
  return {
    supabase: ctx.supabase,
    ownerId: ctx.ownerId,
    model: ctx.model,
    clock: ctx.services.clock,
    courseIdForEvents: ctx.courseId,
    // FR-1: the classifier's frame source for EXTERNAL UPLOADS only (studio
    // recordings carry metadata and short-circuit before this is touched) —
    // Mux thumbnail stills judged through the model's vision seam.
    frameInspectorFor: (asset) => createMuxFrameInspector(ctx.model, asset),
  };
}

/** Map pipeline errors onto agent-teachable MarketingToolErrors. */
function rethrow(err: unknown): never {
  if (
    err instanceof ClipTranscriptUnavailableError ||
    err instanceof ClipModelUnavailableError ||
    err instanceof ClipGenerationError
  ) {
    throw new MarketingToolError(err.message);
  }
  throw err;
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function candidateLine(c: ClipMomentCandidate): string {
  const caveat = c.layout === "audiogram" ? ` (${CLIP_AUDIOGRAM_CAVEAT})` : "";
  return `#${c.rank} [${fmtMs(c.startMs)}–${fmtMs(c.endMs)} · ${c.momentType} · ${c.funnelStage} · ${CLIP_LAYOUT_LABELS[c.layout]}] "${c.hookText}" — ${c.rationale}${caveat}`;
}

function compactCandidate(c: ClipMomentCandidate) {
  return {
    id: c.id,
    rank: c.rank,
    startMs: c.startMs,
    endMs: c.endMs,
    durationSeconds: Math.round((c.endMs - c.startMs) / 1000),
    momentType: c.momentType,
    hookText: c.hookText,
    altHooks: c.altHooks,
    funnelStage: c.funnelStage,
    targetPlatformFit: c.targetPlatformFit,
    rationale: c.rationale,
    captionDraft: c.captionDraft,
    endCardCta: c.endCardCta,
    /** FR-2: what kind of clip this candidate becomes when rendered. */
    layout: c.layout,
    layoutLabel: CLIP_LAYOUT_LABELS[c.layout],
    status: c.status,
    isMultiSegment: c.segments !== null,
  };
}

const selectClipMomentsTool = defineMarketingTool({
  name: "select_clip_moments",
  description:
    "Find the most teachable, hook-worthy moments in a lesson's video recording and stage them as ranked clip candidates (with draft hooks, funnel-stage fit, and a creator-facing rationale each). Uses the lesson transcript + course context + quiz-miss data — grounded moments, never vocal-energy guesses. stages=null proposes the funnel-balanced default. Candidates are drafts: nothing is rendered or posted (rendering arrives in a later milestone); dismiss any candidate freely.",
  params: z.object({
    lessonId: z.uuid(),
    /** null → balanced funnel mix (the §13 default proposal). */
    stages: z.array(z.enum(FUNNEL_STAGES)).nullable(),
    /** null → all clip platforms. */
    targetPlatforms: z.array(z.enum(CLIP_PLATFORMS)).nullable(),
    count: z.number().int().min(1).max(CLIP_MAX_CANDIDATES).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "select_clip_moments",
  existingTarget: () => null, // a create — revert removes the candidate set
  async execute(args, ctx) {
    try {
      const result = await selectClipMoments(
        depsFrom(ctx),
        {
          lessonId: args.lessonId,
          courseId: ctx.courseId,
          stages: args.stages ?? "balanced",
          targetPlatforms: args.targetPlatforms ?? [...CLIP_PLATFORMS],
          count: args.count ?? CLIP_MAX_CANDIDATES,
        },
        { requestedBy: ctx.requestedBy }
      );
      const droppedNote =
        result.dropped.length > 0
          ? ` ${result.dropped.length} candidate(s) were dropped by validation (${result.dropped[0].reason}).`
          : "";
      return {
        summary: `Found ${result.candidates.length} moment(s) worth clipping in this lesson (transcript: ${result.transcript.source}).${droppedNote}\n${result.candidates.map(candidateLine).join("\n")}`,
        data: {
          requestId: result.requestId,
          candidates: result.candidates.map(compactCandidate),
          dropped: result.dropped,
        },
        target: { entity: "clip_moment_set", id: result.requestId },
      };
    } catch (err) {
      rethrow(err);
    }
  },
});

const listClipMomentCandidatesTool = defineMarketingTool({
  name: "list_clip_moment_candidates",
  description:
    "List a lesson's existing clip moment candidates (ranked, with hooks, stages, spans, and status). Call this before selecting again — candidates persist across runs.",
  params: z.object({
    lessonId: z.uuid(),
    includeDismissed: z.boolean().nullable(),
  }),
  reversibility: "read",
  async execute(args, ctx) {
    const candidates = await listCandidatesForLesson(ctx.supabase, args.lessonId, {
      includeDismissed: args.includeDismissed ?? false,
    });
    return {
      summary: candidates.length
        ? `${candidates.length} candidate(s).\n${candidates.slice(0, 5).map(candidateLine).join("\n")}`
        : "No clip candidates for this lesson yet — run select_clip_moments.",
      data: { candidates: candidates.map(compactCandidate) },
    };
  },
});

const updateClipMomentStatusTool = defineMarketingTool({
  name: "update_clip_moment_status",
  description:
    "Mark a clip moment candidate selected (the creator wants it rendered — rendering arrives in a later milestone) or dismissed (hides it from the picker), or restore it to candidate. Reversible.",
  params: z.object({
    candidateId: z.uuid(),
    status: z.enum(["selected", "dismissed", "candidate"]),
  }),
  reversibility: "reversible",
  actionKind: "update_clip_moment_status",
  existingTarget: (args) => ({ entity: "clip_moment_candidate", id: args.candidateId }),
  async execute(args, ctx) {
    const existing = await getCandidate(ctx.supabase, args.candidateId);
    if (!existing) throw new MarketingToolError(`Clip candidate ${args.candidateId} not found`);
    const updated = await updateCandidateStatus(ctx.supabase, args.candidateId, args.status);
    if (args.status === "selected" || args.status === "dismissed") {
      await emitClipEvent(
        ctx.supabase,
        ctx.courseId,
        args.status === "selected" ? "clip_moment_selected" : "clip_moment_dismissed",
        { candidateId: updated.id, lessonId: updated.lessonId, requestId: updated.requestId }
      );
    }
    return {
      summary: `Candidate #${updated.rank} ("${updated.hookText}") is now ${updated.status}.`,
      data: compactCandidate(updated),
      target: { entity: "clip_moment_candidate", id: updated.id },
    };
  },
});

/* ───────────────────────── render jobs (M-B) ──────────────────────────── */

function jobLine(j: ClipRenderJob): string {
  const state =
    j.status === "completed"
      ? "ready to download"
      : j.status === "failed"
        ? `failed (${j.error ?? "unknown"})`
        : j.status === "cancelled"
          ? "cancelled"
          : "rendering in the background";
  return `${CLIP_LAYOUT_LABELS[j.layout]} · ${j.preset} · ${state}`;
}

function compactJob(j: ClipRenderJob) {
  return {
    id: j.id,
    candidateId: j.candidateId,
    layout: j.layout,
    layoutLabel: CLIP_LAYOUT_LABELS[j.layout],
    provider: j.provider,
    preset: j.preset,
    status: j.status,
    cropProvenance: j.cropProvenance,
    output: j.output,
    costMinutes: j.costMinutes,
    error: j.error,
    createdAt: j.createdAt,
  };
}

const generateLessonClipsTool = defineMarketingTool({
  name: "generate_lesson_clips",
  description:
    "Queue a RENDER of a clip moment candidate (the creator picked it — now make the video). The render runs in the background (pre-cut to the exact validated span → the layout's render path); QUEUED IS NOT RENDERED and nothing is ever posted — the creator downloads the finished clip and posts it manually. Quota-gated (daily jobs + monthly minutes). Reversible: reverting cancels the job (spend already incurred stays on the ledger).",
  params: z.object({
    candidateId: z.uuid(),
    /** Packaging preset (tofu_hook | mofu_story | bofu_preview); null → by
     *  the candidate's funnel stage. */
    preset: z.enum(["tofu_hook", "mofu_story", "bofu_preview"]).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "generate_lesson_clips",
  existingTarget: () => null, // a create — revert cancels the job
  async execute(args, ctx) {
    const candidate = await getCandidate(ctx.supabase, args.candidateId);
    if (!candidate) throw new MarketingToolError(`Clip candidate ${args.candidateId} not found`);
    const preset =
      args.preset ??
      (candidate.funnelStage === "bofu"
        ? "bofu_preview"
        : candidate.funnelStage === "mofu"
          ? "mofu_story"
          : "tofu_hook");
    try {
      const job = await createClipRenderJob(
        {
          supabase: ctx.supabase,
          ownerId: ctx.ownerId,
          courseIdForEvents: ctx.courseId,
          model: ctx.model,
          nowIso: ctx.services.clock.now(),
        },
        { candidate, preset, idempotencyKey: `gen:${candidate.id}:${preset}` }
      );
      return {
        summary: `Render queued for "${candidate.hookText}" — ${CLIP_LAYOUT_LABELS[job.layout]} (${job.provider === "reap" ? "provider reframe" : "in-house composition"}), preset ${preset}. It processes in the background over the next few minutes; queued is NOT rendered yet, and nothing is ever posted for you.`,
        data: compactJob(job),
        target: { entity: "clip_render_job", id: job.id },
      };
    } catch (err) {
      if (err instanceof ClipRenderError) throw new MarketingToolError(err.message);
      throw err;
    }
  },
});

const cancelClipJobTool = defineMarketingTool({
  name: "cancel_clip_job",
  description:
    "Cancel an in-flight clip render job (best-effort at the provider; the job row is marked cancelled). Spend already incurred stays on the ledger. Reversible (restoring the row lets the next background pass re-poll; a provider-side cancel that already landed converges the job honestly).",
  params: z.object({ jobId: z.uuid() }),
  reversibility: "reversible",
  actionKind: "cancel_clip_job",
  existingTarget: (args) => ({ entity: "clip_render_job", id: args.jobId }),
  async execute(args, ctx) {
    const job = await cancelRenderJob(
      {
        supabase: ctx.supabase,
        provider: isReapConfigured() ? createReapProvider() : undefined,
        precutOps: createMuxPrecutOps(),
      },
      args.jobId
    );
    if (!job) throw new MarketingToolError(`Clip render job ${args.jobId} not found`);
    return {
      summary:
        job.status === "cancelled"
          ? `Render cancelled (${CLIP_LAYOUT_LABELS[job.layout]}).`
          : `That render already finished (${job.status}) — nothing to cancel.`,
      data: compactJob(job),
      target: { entity: "clip_render_job", id: job.id },
    };
  },
});

const listClipJobsTool = defineMarketingTool({
  name: "list_clip_jobs",
  description:
    "List a lesson's clip render jobs (layout, status, output readiness, cost minutes). Renders happen in the background — check here for progress instead of re-queuing.",
  params: z.object({ lessonId: z.uuid() }),
  reversibility: "read",
  async execute(args, ctx) {
    const jobs = await listRenderJobsForLesson(ctx.supabase, args.lessonId);
    return {
      summary: jobs.length
        ? `${jobs.length} render job(s).\n${jobs.slice(0, 6).map(jobLine).join("\n")}`
        : "No render jobs for this lesson yet — pick a candidate and run generate_lesson_clips.",
      data: { jobs: jobs.map(compactJob) },
    };
  },
});

/* ─────────────────────── posting kit (M-D) ────────────────────────────── */

const generatePostingKitTool = defineMarketingTool({
  name: "generate_posting_kit",
  description:
    "Build the posting kit for a RENDERED clip (a social_post with post_type='clip'): caption + hashtags + a unique comment keyword + a /l/ short link to the course + the compliance disclosure line (code-inserted, never AI text). The creator copies the kit and posts MANUALLY — WiseSel never posts. Reversible (regenerating replaces the kit; the short link survives as an audit row).",
  params: z.object({
    postId: z.uuid(),
    /** null → the post's own platform. */
    platform: z.enum(CLIP_PLATFORMS).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "generate_posting_kit",
  existingTarget: (args) => ({ entity: "social_post", id: args.postId }),
  async execute(args, ctx) {
    const { data: post } = await ctx.supabase
      .from("social_post")
      .select("id, course_id, platform, post_type, ai_metadata, body")
      .eq("id", args.postId)
      .maybeSingle();
    if (!post) throw new MarketingToolError(`Post ${args.postId} not found`);
    if (post.post_type !== "clip") {
      throw new MarketingToolError("Posting kits are for rendered clips — this is a text post.");
    }
    const meta = (post.ai_metadata as Record<string, unknown>) ?? {};
    const platform = args.platform ?? (isClipPlatform(post.platform) ? post.platform : "instagram");
    const { data: course } = post.course_id
      ? await ctx.supabase.from("courses").select("title").eq("id", post.course_id).maybeSingle()
      : { data: null };
    const destinationPath = post.course_id
      ? ((await coursePreviewPath(ctx.supabase, post.course_id)) ?? `/p/${post.course_id}`)
      : null;
    const kit = await generatePostingKit(
      {
        supabase: ctx.supabase,
        ownerId: ctx.ownerId,
        courseIdForEvents: ctx.courseId,
        model: ctx.model,
        siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
      },
      {
        postId: post.id,
        platform,
        hookText: (meta.hookText as string) ?? post.body.slice(0, 80),
        rationale: (meta.rationale as string) ?? "",
        courseId: post.course_id,
        courseTitle: course?.title ?? "my course",
        destinationPath,
      }
    );
    return {
      summary: `Posting kit ready (${CLIP_PLATFORM_SPECS[platform].label}): comment keyword "${kit.commentKeyword}", short link /l/${kit.shortCode ?? "—"}. Copy the full text below and post it MANUALLY — WiseSel never posts for you.\n\n${kit.fullText}`,
      data: kit,
      target: { entity: "social_post", id: post.id },
    };
  },
});

export const clipTools = [
  selectClipMomentsTool,
  listClipMomentCandidatesTool,
  updateClipMomentStatusTool,
  generateLessonClipsTool,
  cancelClipJobTool,
  listClipJobsTool,
  generatePostingKitTool,
];
