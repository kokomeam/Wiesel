"use client";

/**
 * TUTOR-1 A3 Wave 4 — the client `tool_evidence` POST helper.
 *
 * Fire-and-forget evidence for a completed assessment card (a checkUnderstanding
 * answer / a sequenceTask submission — ONE evidence per card). Mirrors the
 * PracticeCard.postSignal pattern: best-effort, never blocks the UI, swallows
 * every error (access / network). The ROUTE builds the idempotent
 * `completionKey = "toolcard:" + cardId`, records via `recordToolEvidence`, and
 * fires the same mastery refold the other evidence endpoints fire — the client
 * just reports the outcome.
 *
 * ZOD-FREE by house rule (learn route bundle): no zod, no lib/tutor/runtime.
 */

import type { TutorAssessmentOutcome } from "@/lib/learn/tutorClientTypes";

/** The `tool_evidence` request body (contract §6). Nullable optionals are
 *  omitted rather than sent null where the field doesn't apply. */
export interface ToolEvidenceInput {
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  cardId: string;
  toolName: "checkUnderstanding" | "sequenceTask";
  conceptSlug: string;
  outcome: TutorAssessmentOutcome;
  /** The selected distractor's misconceptionId (checkUnderstanding only). */
  misconceptionId?: string | null;
  confidence?: "sure" | "unsure" | null;
  initiation: "practice_request" | "invitation_accepted";
  /** submit-time − mount-time (event handler only, never Date.now in render). */
  latencyMs?: number | null;
}

/**
 * POST one `tool_evidence` signal. Fire-and-forget — the returned promise is
 * never awaited by the UI; any failure is swallowed (evidence is best-effort).
 * `fadeLevel` is null in Wave 4 (fadedExample is Wave 5).
 */
export function postToolEvidence(input: ToolEvidenceInput): void {
  void fetch("/api/learn/tutor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "tool_evidence",
      courseId: input.courseId,
      publicationId: input.publicationId,
      version: input.version,
      lessonId: input.lessonId,
      cardId: input.cardId,
      toolName: input.toolName,
      conceptSlug: input.conceptSlug,
      outcome: input.outcome,
      misconceptionId: input.misconceptionId ?? null,
      confidence: input.confidence ?? null,
      fadeLevel: null,
      initiation: input.initiation,
      latencyMs: input.latencyMs ?? null,
    }),
  }).catch(() => {});
}
