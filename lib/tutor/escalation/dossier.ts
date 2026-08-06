/**
 * Escalation DOSSIER synthesis (TUTOR-1 Wave 6 · P6.2).
 *
 * When a learner consents to hand an escalation to their instructor, Terra writes
 * ONE plain-English dossier over the ANONYMIZED question + its concept-node
 * context — a short synthesized summary the creator will read, plus honest notes
 * on where the tutor's proposed answer is uncertain.
 *
 * ── THE PRIVACY SPINE (binding) ──────────────────────────────────────────────
 * The prompt carries NO learner identity — only the anonymized question text and
 * the concept-node context (title / description / the tutor's proposed answer).
 * `buildDossierPrompt` is PURE and takes exactly those inputs; there is no code
 * path by which a user id, email, or name can reach the model. Identity stays
 * server-side (the dossier ROW carries user_id; the model call never does).
 *
 * The DossierSchema + the responseFormat name live here (the mock seam);
 * `synthesizeDossier` runs the one structured Terra call via runStructuredCall so
 * the pooled cost decorator (withPooledModel) intercepts it upstream.
 */

import { z } from "zod";
import type { ModelClient } from "@/lib/ai/modelClient";
import { runStructuredCall } from "@/lib/ai/subagent";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";

/* ────────────────────────────── schema ──────────────────────────────────── */

/** The Terra synthesis. `summary` = the plain-English case the creator reads (what
 *  the learner is stuck on + what the tutor tried); `confidenceNotes` = an honest
 *  note on where the tutor's proposed answer is uncertain / needs the instructor's
 *  confirmation. Both are bounded so the strict-JSON schema stays compact. */
export const DossierSchema = z.object({
  summary: z.string().min(1).max(2000),
  confidenceNotes: z.string().min(1).max(1000),
});
export type Dossier = z.infer<typeof DossierSchema>;

/** The responseFormat name — the mock's `opts.structured` map key. */
export const DOSSIER_RESPONSE_NAME = "escalation_dossier";

export const DOSSIER_SYSTEM_PROMPT = [
  "You are preparing a hand-off dossier for a course instructor. A learner using the",
  "AI tutor got stuck on a concept and consented to share their question with the",
  "instructor. Write a SHORT, plain-English case the instructor can act on.",
  "",
  "You are given ONLY: the learner's (anonymized) question, the concept node(s) it",
  "sits on, and the tutor's proposed answer. You have NO learner identity — never",
  "refer to the learner by any name; say 'the learner'.",
  "",
  "Return:",
  "- summary: what the learner is confused about and what the tutor already tried,",
  "  in 2–4 sentences. Concrete and specific to the concept.",
  "- confidenceNotes: where the tutor's proposed answer is uncertain or needs the",
  "  instructor to confirm/correct it. Be honest about the gaps.",
  "",
  "Return ONLY the JSON object matching the schema.",
].join("\n");

/* ─────────────────────────── prompt builder (PURE) ──────────────────────── */

/** The anonymized concept context handed to the model alongside the question.
 *  Deliberately identity-FREE — node titles/descriptions + the tutor's proposal. */
export interface DossierNodeContext {
  /** The concept node(s) the escalation sits on. */
  nodes: { title: string; description?: string }[];
  /** The tutor's best proposed answer (for the instructor to confirm). */
  tutorProposedAnswer?: string | null;
  /** The scaffolding rungs the tutor already walked (compact, identity-free). */
  rungTrail?: { rung: number }[];
}

/**
 * Build the dossier synthesis prompt input. PURE. NO identity token appears — the
 * only free text is the question + node titles/descriptions + the tutor's proposed
 * answer. (Asserted by the pure verify suite: the built string contains no user id.)
 */
export function buildDossierPrompt(question: string, nodeContext: DossierNodeContext): string {
  const parts: string[] = [];
  parts.push(`LEARNER QUESTION (anonymized):\n${question.trim()}`);

  if (nodeContext.nodes.length > 0) {
    const nodeLines = nodeContext.nodes
      .map((n) => {
        const desc = n.description?.trim();
        return desc ? `- ${n.title.trim()}: ${desc}` : `- ${n.title.trim()}`;
      })
      .join("\n");
    parts.push(`CONCEPT NODE(S):\n${nodeLines}`);
  }

  const proposed = nodeContext.tutorProposedAnswer?.trim();
  if (proposed) {
    parts.push(`TUTOR'S PROPOSED ANSWER (for the instructor to confirm):\n${proposed}`);
  }

  if (nodeContext.rungTrail && nodeContext.rungTrail.length > 0) {
    const rungs = nodeContext.rungTrail.map((r) => r.rung).join(" → ");
    parts.push(`SCAFFOLDING RUNGS ALREADY TRIED: ${rungs}`);
  }

  return parts.join("\n\n");
}

/* ─────────────────────────── synthesis (orchestration) ──────────────────── */

export interface SynthesizeDossierDeps {
  /** The model client — cost/concurrency already decorated by withPooledModel. */
  model: ModelClient;
  /** Cooperative cancellation for the whole synthesis run. */
  signal?: AbortSignal;
}

export interface SynthesizeDossierResult {
  ok: boolean;
  data: Dossier | null;
  responseId?: string | null;
  error?: string;
}

/**
 * Run ONE structured Terra call producing the dossier over the ANONYMIZED question
 * + node context. The cost is emitted upstream by the withPooledModel decorator
 * (keyed by the course author). NEVER passes learner identity to the model.
 */
export async function synthesizeDossier(
  deps: SynthesizeDossierDeps,
  args: { question: string; nodeContext: DossierNodeContext }
): Promise<SynthesizeDossierResult> {
  const res = await runStructuredCall(deps.model, {
    system: DOSSIER_SYSTEM_PROMPT,
    input: buildDossierPrompt(args.question, args.nodeContext),
    outputName: DOSSIER_RESPONSE_NAME,
    outputSchema: DossierSchema,
    model: TUTOR_MODELS.escalation_dossier.model,
    effort: TUTOR_MODELS.escalation_dossier.effort,
    timeoutMs: TUTOR_MODELS.escalation_dossier.timeoutMs,
    maxRetries: TUTOR_MODELS.escalation_dossier.maxRetries,
    maxOutputTokens: TUTOR_MODELS.escalation_dossier.maxOutputTokens,
    signal: deps.signal,
  });
  return { ok: res.ok, data: res.data, responseId: res.responseId, error: res.error };
}
