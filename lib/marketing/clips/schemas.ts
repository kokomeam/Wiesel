/**
 * Lesson Clip Repurposing — Zod single source of truth (Phase 1.5 PRD §7.2,
 * §12). Every shape is defined ONCE here and inferred everywhere: the REST
 * routes, the agent tools, the selection gate, the eval harness. Types are
 * never hand-written. Naming mirrors Phase 1: `ModelMoment*` = the
 * model-facing structured-output contract; `ClipMomentCandidate` = the domain
 * row mirror.
 */

import { z } from "zod";
import {
  CLIP_ALT_HOOK_COUNT,
  CLIP_CANDIDATE_STATUSES,
  CLIP_HOOK_MAX_WORDS,
  CLIP_LAYOUTS,
  CLIP_MAX_CANDIDATES,
  CLIP_MOMENT_TYPES,
  CLIP_PLATFORMS,
  CLIP_RUBRIC_DIMENSIONS,
  CLIP_RUBRIC_THRESHOLDS,
  FORMAT_SOURCES,
  FUNNEL_STAGES,
  RECORDING_FORMATS,
} from "./constants";

export const ClipPlatformSchema = z.enum(CLIP_PLATFORMS);
export const ClipMomentTypeSchema = z.enum(CLIP_MOMENT_TYPES);
export const ClipFunnelStageSchema = z.enum(FUNNEL_STAGES);
export const ClipCandidateStatusSchema = z.enum(CLIP_CANDIDATE_STATUSES);

/* ─────────── recording formats + layouts (amendment §1, FR-1/FR-2) ─────── */

/** The shared-contracts Zod mirror (amendment FR-1) — the TS types are
 *  INFERRED from these enums, never hand-written. */
export const RecordingFormatSchema = z.enum(RECORDING_FORMATS);
export type RecordingFormat = z.infer<typeof RecordingFormatSchema>;

export const FormatSourceSchema = z.enum(FORMAT_SOURCES);
export type FormatSource = z.infer<typeof FormatSourceSchema>;

export const ClipLayoutSchema = z.enum(CLIP_LAYOUTS);
export type ClipLayout = z.infer<typeof ClipLayoutSchema>;

/**
 * Slide-sync contract (FR-2/FR-6): slide↔timestamp alignment for a lesson's
 * recording. Entries are ordered by atMs; a slide stays active until the next
 * entry. ⚠ No platform producer exists yet (the FR-7(g) audit finding — the
 * recorder does not capture slide timings), so production lessons carry null
 * sync today and `slide_short` routing is reachable only where sync data is
 * supplied (eval fixtures now; the recorder capture is an M-F prerequisite).
 */
export const SlideSyncEntrySchema = z.object({
  slideId: z.string().min(1),
  /** When this slide became visible, ms from media start. */
  atMs: z.number().int().nonnegative(),
});
export type SlideSyncEntry = z.infer<typeof SlideSyncEntrySchema>;

export function hookWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/* ───────────────────────── transcript shapes ──────────────────────────── */

/** One transcript word: {w, startMs, endMs, speaker} (PRD §12.1). speaker is
 *  null for platform (Mux) transcripts — no diarization there. */
export const TranscriptWordSchema = z.object({
  w: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speaker: z.string().nullable(),
});
export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;

/** Domain mirror of a lesson_transcript row (camelCase). */
export const LessonTranscriptSchema = z.object({
  id: z.uuid(),
  creatorId: z.uuid(),
  courseId: z.uuid().nullable(),
  lessonId: z.uuid(),
  source: z.enum(["platform", "provider"]),
  language: z.string(),
  durationSeconds: z.number().nonnegative(),
  words: z.array(TranscriptWordSchema),
  text: z.string(),
  providerRef: z.string().nullable(),
  /** The video asset this transcript was built FROM (null = legacy row).
   *  A lesson can hold several takes; the cache rebuilds when the lesson's
   *  CURRENT take (newest ready captioned video) is a different asset. */
  videoAssetId: z.uuid().nullable(),
  /** FR-1: the recording format FACT + where it came from. Creator override
   *  lands here (format_source='creator_override') via overrideTranscriptFormat. */
  recordingFormat: RecordingFormatSchema,
  formatSource: FormatSourceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LessonTranscript = z.infer<typeof LessonTranscriptSchema>;

/* ────────────────────── rubric scores (§8.3) ──────────────────────────── */

const rubricShape = Object.fromEntries(
  CLIP_RUBRIC_DIMENSIONS.map((d) => [
    d,
    z
      .number()
      .int()
      .min(0)
      .max(CLIP_RUBRIC_THRESHOLDS.maxPerDimension)
      .describe("0-5 per the rubric"),
  ])
) as Record<(typeof CLIP_RUBRIC_DIMENSIONS)[number], z.ZodNumber>;

export const RubricScoresSchema = z.object(rubricShape);
export type RubricScores = z.infer<typeof RubricScoresSchema>;

export function rubricTotal(scores: RubricScores): number {
  return CLIP_RUBRIC_DIMENSIONS.reduce((sum, d) => sum + scores[d], 0);
}

/** The §8.3 viability bar: total ≥ 21/35 AND hook_potential ≥ 3 AND
 *  standalone ≥ 4. Single source — validation pass + eval harness. */
export function meetsRubricThreshold(scores: RubricScores): boolean {
  return (
    rubricTotal(scores) >= CLIP_RUBRIC_THRESHOLDS.totalMin &&
    scores.hook_potential >= CLIP_RUBRIC_THRESHOLDS.hookPotentialMin &&
    scores.standalone >= CLIP_RUBRIC_THRESHOLDS.standaloneMin
  );
}

/* ─────────────── model-facing selection contract (§7.2) ───────────────── */

/** A multi-segment span (§7.3 exception only). */
export const MomentSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});
export type MomentSegment = z.infer<typeof MomentSegmentSchema>;

/**
 * One ranked moment candidate as the SELECTION call must return it. Span
 * bounds vs. media duration, platform caption caps, and pairwise overlap are
 * enforced in CODE (validate.ts) — the model can't know the media duration
 * and strict JSON schema strips numeric bounds anyway (the studio lesson:
 * clamp/check in code, never hard-reject the parse on stripped keywords).
 */
export const ModelMomentSchema = z
  .object({
    rank: z.number().int().min(1).max(CLIP_MAX_CANDIDATES),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    momentType: ClipMomentTypeSchema,
    hookText: z.string().min(1).describe(`overlay-ready, ≤${CLIP_HOOK_MAX_WORDS} words`),
    altHooks: z
      .array(z.string().min(1))
      .describe(`exactly ${CLIP_ALT_HOOK_COUNT} alternates, same rules as hookText`),
    funnelStage: ClipFunnelStageSchema,
    targetPlatformFit: z.array(ClipPlatformSchema).min(1),
    rationale: z.string().min(1).describe("1-2 sentences, creator-facing"),
    rubricScores: RubricScoresSchema,
    captionDraft: z.string().nullable(),
    endCardCta: z.string().nullable(),
    /** §7.3: multi-segment is an EXPLICIT exception — null for contiguous. */
    segments: z.array(MomentSegmentSchema).nullable(),
    stitchedScript: z.string().nullable(),
  })
  .superRefine((m, ctx) => {
    if (m.endMs <= m.startMs)
      ctx.addIssue({ code: "custom", path: ["endMs"], message: "endMs must be after startMs" });
    if (hookWordCount(m.hookText) > CLIP_HOOK_MAX_WORDS)
      ctx.addIssue({
        code: "custom",
        path: ["hookText"],
        message: `hook must be ≤${CLIP_HOOK_MAX_WORDS} words (overlay text)`,
      });
    if (m.altHooks.length !== CLIP_ALT_HOOK_COUNT)
      ctx.addIssue({
        code: "custom",
        path: ["altHooks"],
        message: `exactly ${CLIP_ALT_HOOK_COUNT} alternate hooks required`,
      });
    if (m.segments !== null) {
      if (m.segments.length < 2)
        ctx.addIssue({
          code: "custom",
          path: ["segments"],
          message: "a multi-segment moment needs ≥2 segments (else emit contiguous with segments=null)",
        });
      if (!m.stitchedScript?.trim())
        ctx.addIssue({
          code: "custom",
          path: ["stitchedScript"],
          message: "a multi-segment moment requires its stitchedScript",
        });
      for (const [i, s] of m.segments.entries()) {
        if (s.endMs <= s.startMs)
          ctx.addIssue({ code: "custom", path: ["segments", i], message: "segment endMs must be after startMs" });
      }
    }
    if (m.segments === null && m.stitchedScript !== null)
      ctx.addIssue({
        code: "custom",
        path: ["stitchedScript"],
        message: "stitchedScript must be null for a contiguous span (§7.3)",
      });
  });
export type ModelMoment = z.infer<typeof ModelMomentSchema>;

export const ModelMomentBatchSchema = z.object({
  candidates: z.array(ModelMomentSchema).min(1).max(CLIP_MAX_CANDIDATES),
});
export type ModelMomentBatch = z.infer<typeof ModelMomentBatchSchema>;

/* ───────── map step (long transcripts, §7.5 middle-out map/reduce) ─────── */

/** Per-chunk shortlist entry from the cheap map step: a rough span + why. */
export const MapShortlistSchema = z.object({
  moments: z
    .array(
      z.object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        momentType: ClipMomentTypeSchema,
        why: z.string().min(1).describe("one sentence"),
      })
    )
    .max(4),
});
export type MapShortlist = z.infer<typeof MapShortlistSchema>;

/* ───────────── the ONE validation call's contract (§7.4/§7.5) ──────────── */

/** Per-hook integrity verdict: every factual claim in the hook must be
 *  supported by the candidate transcript (§7.4.3 — the anti-clickbait gate). */
export const HookVerdictSchema = z.object({
  hook: z.string(),
  supported: z.boolean(),
  unsupportedClaim: z.string().nullable(),
});

export const CandidateVerdictSchema = z.object({
  rank: z.number().int().min(1).max(CLIP_MAX_CANDIDATES),
  coherence: z.object({
    pass: z.boolean(),
    /** The offending phrase when it fails ("as I said earlier"). */
    offendingPhrase: z.string().nullable(),
    /** A proposed ±8s trim/extend that would resolve it (code validates the
     *  bound; out-of-bound proposals are ignored and the candidate drops). */
    adjustedStartMs: z.number().int().nonnegative().nullable(),
    adjustedEndMs: z.number().int().nonnegative().nullable(),
  }),
  /** Verdicts for hookText + both altHooks, in that order. */
  hooks: z.array(HookVerdictSchema).min(1),
});
export const ValidationVerdictBatchSchema = z.object({
  verdicts: z.array(CandidateVerdictSchema).min(1).max(CLIP_MAX_CANDIDATES),
});
export type CandidateVerdict = z.infer<typeof CandidateVerdictSchema>;
export type ValidationVerdictBatch = z.infer<typeof ValidationVerdictBatchSchema>;

/* ─────────────────────────── request shapes ───────────────────────────── */

/** POST /clip-moments request (§7.1 request parameters). The BASE object is
 *  exported separately — zod v4 forbids .omit()/.extend() on refined schemas
 *  (the Phase 1 lesson; the build's page-data collection catches it, tsc
 *  does not). */
export const SelectMomentsRequestBaseSchema = z.object({
  lessonId: z.uuid(),
  courseId: z.uuid().optional(),
  /** Desired funnel stages, or balanced (the funnel-balanced default). */
  stages: z.union([z.literal("balanced"), z.array(ClipFunnelStageSchema).min(1).max(3)]).default("balanced"),
  targetPlatforms: z.array(ClipPlatformSchema).min(1).max(CLIP_PLATFORMS.length),
  count: z.number().int().min(1).max(CLIP_MAX_CANDIDATES).default(CLIP_MAX_CANDIDATES),
});
export const SelectMomentsRequestSchema = SelectMomentsRequestBaseSchema;
export type SelectMomentsRequest = z.infer<typeof SelectMomentsRequestSchema>;

/* ─────────────────────── domain row mirror (§12.2) ────────────────────── */

export const ClipMomentCandidateSchema = z.object({
  id: z.uuid(),
  creatorId: z.uuid(),
  courseId: z.uuid().nullable(),
  lessonId: z.uuid(),
  transcriptId: z.uuid(),
  /** Groups one selection run's candidate SET — the gate's composite revert
   *  unit (the social_post_batch precedent). */
  requestId: z.uuid(),
  rank: z.number().int().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  segments: z.array(MomentSegmentSchema).nullable(),
  stitchedScript: z.string().nullable(),
  momentType: ClipMomentTypeSchema,
  hookText: z.string(),
  altHooks: z.array(z.string()),
  funnelStage: ClipFunnelStageSchema,
  targetPlatformFit: z.array(ClipPlatformSchema),
  rubricScores: RubricScoresSchema,
  rationale: z.string(),
  captionDraft: z.string().nullable(),
  endCardCta: z.string().nullable(),
  /** FR-2: the resolved layout — creators see what kind of clip a candidate
   *  will become BEFORE rendering. Stored on every candidate row. */
  layout: ClipLayoutSchema,
  status: ClipCandidateStatusSchema,
  promptVersion: z.string(),
  aiMetadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClipMomentCandidate = z.infer<typeof ClipMomentCandidateSchema>;
