"use client";

/**
 * TUTOR-1 A3 Wave 4/5 — the client `tool_evidence` POST helper (+ Wave-5's
 * awaited `explain_back_grade` helper).
 *
 * `postToolEvidence` is fire-and-forget evidence for a completed LOCALLY-graded
 * assessment card (a checkUnderstanding answer / a sequenceTask submission /
 * a fadedExample fill / a predictThenReveal commit — ONE evidence per card).
 * Mirrors the PracticeCard.postSignal pattern: best-effort, never blocks the UI,
 * swallows every error (access / network). The ROUTE builds the idempotent
 * `completionKey = "toolcard:" + cardId`, records via `recordToolEvidence`, and
 * fires the same mastery refold the other evidence endpoints fire — the client
 * just reports the outcome.
 *
 * `gradeExplainBack` (Wave 5) is DIFFERENT: explainBack grades on the SERVER
 * (free text → semantic rubric presence), so this one AWAITS the graded response
 * and returns the per-criterion results the card renders. The route records the
 * evidence itself (from its own grade) — the client never sends an outcome for it.
 *
 * ZOD-FREE by house rule (learn route bundle): no zod, no lib/tutor/runtime.
 */

import type {
  ExplainBackCriterionResult,
  TutorAssessmentOutcome,
} from "@/lib/learn/tutorClientTypes";

/** The `tool_evidence` request body (contract §6). Nullable optionals are
 *  omitted rather than sent null where the field doesn't apply. */
export interface ToolEvidenceInput {
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  cardId: string;
  /** The LOCALLY-graded card kinds (explainBack grades server-side — see
   *  `gradeExplainBack`, never this helper). */
  toolName: "checkUnderstanding" | "sequenceTask" | "fadedExample" | "predictThenReveal";
  conceptSlug: string;
  outcome: TutorAssessmentOutcome;
  /** The selected distractor's / near-miss misconceptionId (checkUnderstanding,
   *  predictThenReveal). */
  misconceptionId?: string | null;
  confidence?: "sure" | "unsure" | null;
  /** The card's fade level (fadedExample only); null for the other kinds. */
  fadeLevel?: number | null;
  initiation: "practice_request" | "invitation_accepted";
  /** submit-time − mount-time (event handler only, never Date.now in render). */
  latencyMs?: number | null;
}

/**
 * POST one `tool_evidence` signal. Fire-and-forget — the returned promise is
 * never awaited by the UI; any failure is swallowed (evidence is best-effort).
 * `fadeLevel` rides for a fadedExample card (the card's level); null otherwise.
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
      fadeLevel: input.fadeLevel ?? null,
      initiation: input.initiation,
      latencyMs: input.latencyMs ?? null,
    }),
  }).catch(() => {});
}

/** The input to `gradeExplainBack` — everything the server needs to grade a
 *  free-text explanation against the card's rubric. */
export interface ExplainBackGradeInput {
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  cardId: string;
  conceptSlug: string;
  text: string;
  rubric: { criterion: string; required: boolean }[];
  initiation: "practice_request" | "invitation_accepted";
}

/** The parsed result of `explain_back_grade`. On a graded response
 *  `ok === true` + `criteria`/`outcome` are set; on ANY failure `ok === false`
 *  (the card shows a plain retry — never a fake grade). There is NO pass/fail
 *  verdict field — the card renders per-criterion presence only (A3-17). */
export type ExplainBackGradeResult =
  | { ok: true; criteria: ExplainBackCriterionResult[]; outcome: TutorAssessmentOutcome }
  | { ok: false };

/**
 * A3 Wave 5 — POST the `explain_back_grade` action and AWAIT the graded response.
 *
 * UNLIKE `postToolEvidence`, this is NOT fire-and-forget: the card blocks on the
 * server's semantic grade (presence-of-idea per rubric criterion) and renders the
 * returned `criteria`. The route records the tutor_evidence itself (from its own
 * grade), so the client never sends an outcome for explainBack. Any failure —
 * network, non-2xx, a malformed body, or the server's own `{ ok:false }` — resolves
 * to `{ ok:false }` (fail closed, never a fabricated grade; the card retries).
 */
export async function gradeExplainBack(
  input: ExplainBackGradeInput,
): Promise<ExplainBackGradeResult> {
  try {
    const res = await fetch("/api/learn/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "explain_back_grade",
        courseId: input.courseId,
        publicationId: input.publicationId,
        version: input.version,
        lessonId: input.lessonId,
        cardId: input.cardId,
        conceptSlug: input.conceptSlug,
        text: input.text,
        rubric: input.rubric,
        initiation: input.initiation,
      }),
    });
    if (!res.ok) return { ok: false };
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") return { ok: false };
    const b = body as Record<string, unknown>;
    // The route returns { ok, criteria, outcome } — a false/absent ok, a
    // non-array criteria, or a bad outcome all fail closed.
    if (b.ok !== true || !Array.isArray(b.criteria)) return { ok: false };
    const outcome = b.outcome;
    if (outcome !== "demonstrated" && outcome !== "partial" && outcome !== "not_demonstrated") {
      return { ok: false };
    }
    const criteria: ExplainBackCriterionResult[] = (b.criteria as unknown[])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .filter((c) => typeof c.criterion === "string")
      .map((c) => ({
        criterion: c.criterion as string,
        present: c.present === true,
        note: typeof c.note === "string" ? (c.note as string) : "",
      }));
    return { ok: true, criteria, outcome };
  } catch {
    return { ok: false };
  }
}
