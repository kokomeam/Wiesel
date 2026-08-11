/**
 * TUTOR-1 Amendment A4, Wave 3 — the SCOPE POLICY orchestrator.
 *
 * `runScopedRetrieval` is the one entry the tutor turn calls. It computes
 * eligibility (active ∪ completed — never ordinal), retrieves Tier 1 (active
 * lesson) ALWAYS and Tier 2 (completed lessons) ONLY under one enumerated,
 * event-logged expansion code, detects forward material + retrieval failure, and
 * reports whether any retrieved passage supports a course attribution (the
 * provenance gate). The `retrieve` fn is INJECTED — prod wraps `retrieveChunks`
 * over the publication (query embed UN-POOLED, §2 / A4-21); tests pass a recording
 * stub. Every lessonIds passed to `retrieve` is ⊆ eligible, so an incomplete
 * lesson is NEVER retrieved from (A4-14).
 *
 * The builders turn a decision into the per-turn prompt additions the loop injects
 * (retrieved-passage context + forward-decline / failure-escalation / provenance
 * instructions); `routeContradiction` emits the contradiction event into the
 * escalation loop.
 */

import type { LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import type { EdgeLike, MasteryLike } from "@/lib/tutor/mastery/queries";
import {
  emitTutorRuntimeEvent,
  type TutorRuntimeEventSink,
} from "@/lib/tutor/runtime/runtimeEvents";
import type { RetrievedChunk } from "./retrieve";
import { computeEligibleLessons, type Eligibility } from "./eligibility";
import { questionLessonIds, prerequisiteLessonGaps } from "./conceptLessons";
import {
  decideExpansion,
  detectExplicitRequest,
  detectInsufficientLocal,
  detectMultiConceptSpan,
  detectPrerequisiteGap,
  type ExpansionDecision,
} from "./expansion";
import { detectForwardMaterial, type ForwardMaterial } from "./forward";
import { scopeConfig, type ScopeConfig } from "./scopeConfig";

/** The injected retriever — returns fused/ranked chunks for the given lessons. */
export type ScopeRetrieveFn = (args: { lessonIds: string[]; limit: number }) => Promise<RetrievedChunk[]>;

export interface ScopeDecision {
  eligible: Eligibility;
  tier1: RetrievedChunk[];
  tier2: RetrievedChunk[];
  /** tier1 ∪ tier2. */
  chunks: RetrievedChunk[];
  expansion: ExpansionDecision;
  forwardMaterial: ForwardMaterial | null;
  /** No relevant chunk across eligible tiers AND no forward material ⇒ the course
   *  doesn't cover it → offer escalation (A4-18). */
  retrievalFailure: boolean;
  /** ≥1 retrieved chunk clears τ — the provenance gate (A4-20). */
  hasCourseSupport: boolean;
}

export interface RunScopedRetrievalDeps {
  retrieve: ScopeRetrieveFn;
  onRuntimeEvent?: TutorRuntimeEventSink;
}

export interface RunScopedRetrievalArgs {
  courseId: string;
  activeLessonId: string | null;
  completedLessonIds: Set<string>;
  message: string;
  nodes: LessonConceptNode[];
  edges: EdgeLike[];
  mastery: MasteryLike[];
  /** lesson id → title (for forward-material naming). */
  lessonTitleById?: Map<string, string>;
  cfg?: ScopeConfig;
}

export async function runScopedRetrieval(
  deps: RunScopedRetrievalDeps,
  args: RunScopedRetrievalArgs
): Promise<ScopeDecision> {
  const cfg = args.cfg ?? scopeConfig();
  const eligible = computeEligibleLessons({
    activeLessonId: args.activeLessonId,
    completedLessonIds: args.completedLessonIds,
  });
  const completedSet = new Set(eligible.completed);

  // Tier 1 — the active lesson, always (when there is one). ⊆ eligible.
  const tier1 = args.activeLessonId
    ? await deps.retrieve({ lessonIds: [args.activeLessonId], limit: cfg.tier1Budget })
    : [];

  // Expansion signals.
  const explicitRequest = detectExplicitRequest(args.message);
  const multiConceptSpan = detectMultiConceptSpan(
    questionLessonIds(args.nodes, args.message),
    args.activeLessonId,
    completedSet
  );
  const prereqGaps = args.activeLessonId
    ? prerequisiteLessonGaps({
        nodes: args.nodes,
        edges: args.edges,
        mastery: args.mastery,
        activeLessonId: args.activeLessonId,
      })
    : [];
  const prerequisiteGap = detectPrerequisiteGap(
    prereqGaps.flatMap((g) => g.coveringLessonIds),
    completedSet
  );
  const insufficientLocal = detectInsufficientLocal(tier1, cfg.tau);

  const expansion = decideExpansion({
    explicitRequest,
    multiConceptSpan,
    prerequisiteGap,
    insufficientLocal,
    completedLessonIds: eligible.completed,
  });

  // Tier 2 — only under expansion, filtered to eligible completed lessons.
  let tier2: RetrievedChunk[] = [];
  const targets = expansion.tier2LessonIds.filter((l) => eligible.eligible.has(l) && l !== args.activeLessonId);
  if (expansion.expand && targets.length > 0) {
    tier2 = await deps.retrieve({ lessonIds: targets, limit: cfg.tier2Budget });
    emitTutorRuntimeEvent(
      {
        name: "tutor.retrieval.expanded",
        fields: { code: expansion.code, lessons: targets, tier1Count: tier1.length, tier2Count: tier2.length },
      },
      deps.onRuntimeEvent
    );
  } else if (expansion.expand) {
    // Decided but no reachable eligible target → no expansion actually occurs.
    expansion.expand = false;
    expansion.code = null;
    expansion.tier2LessonIds = [];
  }

  const chunks = [...tier1, ...tier2];
  // Provenance (A4-20) — a course attribution is legitimate iff ≥1 retrieved chunk
  // clears τ on the cosine-SIMILARITY scale (the Wave-5 calibration signal).
  const hasCourseSupport = chunks.some((c) => c.similarity >= cfg.tau);
  const forwardMaterial = detectForwardMaterial({
    nodes: args.nodes,
    message: args.message,
    eligible: eligible.eligible,
    lessonTitleById: args.lessonTitleById,
  });
  const retrievalFailure = !hasCourseSupport && !forwardMaterial;

  return { eligible, tier1, tier2, chunks, expansion, forwardMaterial, retrievalFailure, hasCourseSupport };
}

/* ─────────────────────── prompt additions for the loop ───────────────────── */

/** The retrieved passages as a grounded context block (with anchors) — the source
 *  the model must ground course claims in. Empty string when there are no chunks. */
export function buildRetrievalContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const lines = chunks.map((c, i) => {
    const anchor = `lesson ${c.lessonId} · block ${c.blockId}${c.slideId ? ` · slide ${c.slideId}` : ""}`;
    return `[${i + 1}] (${anchor})\n${c.text}`;
  });
  return `RETRIEVED COURSE PASSAGES — ground every course claim in these and cite by their lesson/block/slide anchors:\n\n${lines.join("\n\n")}`;
}

/** The per-turn scope instructions (provenance always; forward-decline + failure-
 *  escalation when they apply). Appended to the loop's per-turn input. */
export function buildScopeInstructions(
  decision: ScopeDecision,
  lessonTitleById?: Map<string, string>
): string[] {
  const out: string[] = [];
  // Provenance (A4-20).
  out.push(
    'Attribute a fact to the course ONLY when a RETRIEVED COURSE PASSAGE above supports it; never say "the course explains…"/"the course covers…" without one.'
  );
  if (decision.forwardMaterial) {
    const title =
      decision.forwardMaterial.lessonTitle ??
      lessonTitleById?.get(decision.forwardMaterial.lessonId) ??
      "a later lesson the learner hasn't reached";
    out.push(
      `This question is covered LATER in the course, in "${title}", which the learner hasn't completed yet. Name where it's covered and offer to help once they reach it — do NOT explain it now, and do NOT teach it from your own knowledge.`
    );
  }
  if (decision.retrievalFailure) {
    out.push(
      "The course's materials do NOT cover this question. Say so plainly and offer to raise it with the course creator (the escalation path) — do NOT answer it from your own knowledge."
    );
  }
  return out;
}

/**
 * Route a model-flagged contradiction (the course asserts X, the model would
 * assert Y) into the escalation loop for CREATOR review (A4-19). Evidence, not a
 * failure — the runtime still follows the course. Emits tutor.contradiction.detected.
 */
export function routeContradiction(
  deps: { onRuntimeEvent?: TutorRuntimeEventSink },
  args: { courseId: string; note: string; lessonId?: string | null }
): void {
  emitTutorRuntimeEvent(
    {
      name: "tutor.contradiction.detected",
      fields: { courseId: args.courseId, note: args.note.slice(0, 500), lessonId: args.lessonId ?? null },
    },
    deps.onRuntimeEvent
  );
}
