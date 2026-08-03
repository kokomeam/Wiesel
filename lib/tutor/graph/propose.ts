/**
 * Per-lesson concept PROPOSAL (TUTOR-1 Wave 1.3 · Directive §1.2 step 3).
 *
 * The model reads ONE lesson chunk and proposes 1–4 durable, testable concepts
 * (things a learner masters — never slide titles) plus any concepts the lesson
 * USES but never TEACHES (assumed priors). The schema is the mock seam: the
 * responseFormat name `graph_extraction_proposal` keys the mock's structured map.
 *
 * `normalizeGrain` is PURE, deterministic post-hoc grain enforcement over the
 * whole run's proposals — it never calls a model. Flags accumulate into the run
 * result so the creator sees why a lesson was over/under/course-capped.
 */

import { z } from "zod";
import type { LessonChunk } from "./extractionSource";
import type { ExtractionConfig } from "./config";

/* ─────────────────────────── proposal schema ────────────────────────────── */

/** One proposed concept from a lesson. `lessonAnchors` name the block(s)/slide(s)
 *  that teach it (later resolved against the snapshot). `isAssumedPrior` flags a
 *  concept the lesson leans on but never teaches. */
export const ProposedConceptSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  lessonAnchors: z.array(
    z.object({
      blockId: z.string().min(1),
      slideId: z.string().nullable(),
    })
  ),
  confidence: z.number().min(0).max(1),
  isAssumedPrior: z.boolean(),
  evidenceQuote: z.string().max(300),
});
export type ProposedConcept = z.infer<typeof ProposedConceptSchema>;

/** The per-lesson batch the model returns (≤12 concepts — grain is enforced
 *  post-hoc, so the schema cap is a generous safety bound, not the grain rule). */
export const ProposalBatchSchema = z.object({
  concepts: z.array(ProposedConceptSchema).max(12),
});
export type ProposalBatch = z.infer<typeof ProposalBatchSchema>;

/** The responseFormat name — the mock's `opts.structured` map key. */
export const PROPOSAL_RESPONSE_NAME = "graph_extraction_proposal";

/* ─────────────────────────── prompt builder ─────────────────────────────── */

/** STATIC system prefix — byte-identical across every lesson call so the
 *  provider's prompt cache hits. States the grain rule + the assumed-prior rule
 *  in-prompt (Directive §1.2 step 3). NEVER carries lesson-specific text (that
 *  rides in the per-call input). */
export const PROPOSAL_SYSTEM_PROMPT = [
  "You extract a course's KNOWLEDGE MODEL from one lesson's content.",
  "",
  "GRAIN RULE: propose 1–4 DURABLE, TESTABLE concepts per lesson — concepts a",
  "learner MASTERS (an idea you could write a quiz question about), NEVER slide",
  "titles, section headers, or activity names. Fewer, sharper concepts beat many",
  "shallow ones. A lesson may legitimately yield just one concept.",
  "",
  "ASSUMED-PRIOR RULE: if the lesson USES a concept but never TEACHES it (it's",
  "assumed background the learner is expected to already know), set",
  "isAssumedPrior=true. Those become assumed-prior nodes, not taught concepts.",
  "",
  "For each concept give: a short title, a one-to-three sentence description of",
  "what the learner should be able to do, the lessonAnchors (the blockId — and",
  "slideId when the concept is taught on a specific slide, else slideId:null) it",
  "is taught by, a confidence in [0,1], and a short verbatim evidenceQuote (≤300",
  "chars) from the lesson text that grounds it.",
  "",
  "Return ONLY the JSON object matching the schema. Anchor ids MUST be ids that",
  "appear in the provided lesson content — never invent an id.",
].join("\n");

/** The per-call input: the lesson chunk framed with its ids so the model anchors
 *  to REAL block/slide ids (it's told which ids exist). */
export function buildProposalInput(chunk: LessonChunk): string {
  const anchorList = chunk.anchors
    .map((a) => (a.slideId ? `- block ${a.blockId}, slide ${a.slideId}` : `- block ${a.blockId}`))
    .join("\n");
  return [
    `MODULE: ${chunk.moduleTitle}`,
    `LESSON: ${chunk.lessonTitle}`,
    "",
    "VALID ANCHOR IDS (use only these; slideId is optional):",
    anchorList || "(none — this lesson has no minable blocks)",
    "",
    "LESSON CONTENT:",
    chunk.text,
  ].join("\n");
}

/* ─────────────────────────── grain normalization ────────────────────────── */

/** A proposal tagged with the lesson it came from — the unit `normalizeGrain`
 *  operates on (a proposal must remember its lesson to enforce per-lesson grain). */
export interface LessonProposal {
  lessonId: string;
  proposal: ProposedConcept;
}

export interface NormalizeGrainResult {
  kept: LessonProposal[];
  flags: string[];
}

/** Descending by confidence; stable tie-break by original index so the result is
 *  deterministic (two equal-confidence proposals keep their input order). */
function topByConfidence(items: LessonProposal[], keep: number): LessonProposal[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.proposal.confidence - a.item.proposal.confidence || a.i - b.i)
    .slice(0, keep)
    .map(({ item }) => item);
}

/**
 * PURE post-hoc grain enforcement over ALL of a run's proposals.
 *
 *   per lesson  > grainMaxPerLesson  → keep top-N by confidence, flag `grain_over:{lessonId}`
 *   per lesson == 0                  → flag `grain_zero:{lessonId}` (nothing to keep)
 *   course total > grainCourseMax    → keep top by confidence globally, flag `grain_course_over`
 *
 * The per-lesson cap runs FIRST (so the course cap sees already-trimmed lessons),
 * then the global cap. `lessonIds` scopes the zero-check to the lessons that were
 * actually processed (a lesson with no proposals must still be able to flag zero).
 */
export function normalizeGrain(
  proposals: LessonProposal[],
  cfg: Pick<ExtractionConfig, "grainMaxPerLesson" | "grainCourseMax">,
  lessonIds: string[]
): NormalizeGrainResult {
  const flags: string[] = [];

  // Group by lesson (preserve first-seen order for determinism).
  const byLesson = new Map<string, LessonProposal[]>();
  for (const id of lessonIds) byLesson.set(id, []);
  for (const p of proposals) {
    const bucket = byLesson.get(p.lessonId) ?? [];
    bucket.push(p);
    byLesson.set(p.lessonId, bucket);
  }

  // Per-lesson cap + zero flag.
  let kept: LessonProposal[] = [];
  for (const [lessonId, bucket] of byLesson) {
    if (bucket.length === 0) {
      flags.push(`grain_zero:${lessonId}`);
      continue;
    }
    if (bucket.length > cfg.grainMaxPerLesson) {
      flags.push(`grain_over:${lessonId}`);
      kept.push(...topByConfidence(bucket, cfg.grainMaxPerLesson));
    } else {
      kept.push(...bucket);
    }
  }

  // Course-wide cap.
  if (kept.length > cfg.grainCourseMax) {
    flags.push("grain_course_over");
    kept = topByConfidence(kept, cfg.grainCourseMax);
  }

  return { kept, flags };
}
