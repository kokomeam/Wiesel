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
import { CLIP_MAX_CANDIDATES, CLIP_PLATFORMS, FUNNEL_STAGES } from "../clips/constants";
import { emitClipEvent } from "../clips/events";
import {
  ClipGenerationError,
  ClipModelUnavailableError,
  ClipTranscriptUnavailableError,
} from "../clips/errors";
import { getCandidate, listCandidatesForLesson, updateCandidateStatus } from "../clips/repository";
import { selectClipMoments, type ClipPipelineDeps } from "../clips/selection";
import type { ClipMomentCandidate } from "../clips/schemas";
import { defineMarketingTool, MarketingToolError, type MarketingToolContext } from "./types";

function depsFrom(ctx: MarketingToolContext): ClipPipelineDeps {
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
  return `#${c.rank} [${fmtMs(c.startMs)}–${fmtMs(c.endMs)} · ${c.momentType} · ${c.funnelStage}] "${c.hookText}" — ${c.rationale}`;
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

export const clipTools = [
  selectClipMomentsTool,
  listClipMomentCandidatesTool,
  updateClipMomentStatusTool,
];
