/**
 * TUTOR-1 Wave 3 (package C2) — the tutor's FIVE runtime tools (AC-T3.6).
 *
 * These are the ONLY capabilities the live tutor model has, and they are
 * DELIBERATELY narrow (the directive's "YOUR TOOLS" section is the contract):
 *
 *   get_lesson_context   — load another lesson of THIS course (read).
 *   get_mastery_summary  — refresh the learner's private mastery snapshot (read).
 *   generate_practice    — mint 1–3 tagged practice items (ONE structured call).
 *   emit_evidence        — record a mastery inference (WRITES NOTHING — the route
 *                          emits the analytics event; this tool only RETURNS the
 *                          validated payloads for the loop to carry out).
 *   propose_escalation   — draft a consent-pending hand-off to the instructor
 *                          (the ONE service-role write in this surface).
 *
 * This registry is LOCAL by design (Wave 3 §C2): it does NOT import the
 * course-agent tool machinery (lib/ai/tools/*), which is welded to the
 * CoursePatch pipeline. A tutor tool is a pure {name, description, params(zod),
 * execute(args, deps)} record; the loop owns argument validation, the model
 * seam, and event emission.
 *
 * ── WHY emit_evidence WRITES NOTHING (documented loudly) ─────────────────────
 * The learner-facing tutor turn runs the tool loop and returns a structured
 * result; the ROUTE (Wave 3 §C3) is the single writer that persists the turn AND
 * emits the tutor_inference analytics events (server-emitted, admin client — a
 * browser can never forge learning evidence). If this tool wrote directly it
 * would double-emit and bypass the route's idempotency. So emit_evidence
 * VALIDATES the payloads against the frozen contract and hands them back; the
 * route emits them exactly once.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import type { ModelClient } from "@/lib/ai/modelClient";
import {
  TutorInferencePayloadSchema,
  type TutorInferencePayload,
} from "@/lib/analytics/events";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { runStructuredCall } from "@/lib/ai/subagent";
import {
  assembleLessonContext,
  type LessonConceptNode,
} from "./lessonContext";
import { buildSnapshotIndex, type SnapshotIndex } from "./grounding";
import {
  assembleLearnerState,
  type LearnerStateInputs,
} from "./learnerState";
import { rootCause, type EdgeLike } from "@/lib/tutor/mastery/queries";
import { TUTOR_MASTERY_THRESHOLD } from "@/lib/tutor/mastery/config";
import type { TutorCharter } from "./charter";

/* ─────────────────────────────── tool names ─────────────────────────────── */

/** The FIVE tutor tool names — a const tuple (AC-T3.6 asserts exactly these). */
export const TUTOR_TOOL_NAMES = [
  "get_lesson_context",
  "get_mastery_summary",
  "generate_practice",
  "emit_evidence",
  "propose_escalation",
] as const;

export type TutorToolName = (typeof TUTOR_TOOL_NAMES)[number];

/* ─────────────────────────────── deps shape ─────────────────────────────── */

type DB = SupabaseClient<Database>;

/** The ambient context every tool execution shares. */
export interface TutorToolCtx {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId?: string;
}

/**
 * The dependencies a tool's `execute` receives. `learnerClient` is the
 * LEARNER-SCOPED client (privacy-correct by construction — the learner reads
 * only their own mastery/queue). `serviceClient` is the admin client (the ONE
 * write — propose_escalation — needs it; a learner has no insert policy on the
 * escalation table). `model` is ALREADY POOLED by the caller (withPooledModel);
 * a tool that calls the model never wraps it again.
 */
export interface TutorToolDeps {
  learnerClient: DB;
  serviceClient: DB;
  snapshot: PublicationSnapshot;
  snapshotIndex: SnapshotIndex;
  conceptNodes: LessonConceptNode[];
  conceptEdges: EdgeLike[];
  charter: TutorCharter;
  ctx: TutorToolCtx;
  /** Pooled ModelClient (the caller passes an already-wrapped model). */
  model: ModelClient;
}

/** A tool's return: a human-readable summary (rides the tool_result event) plus
 *  the structured `data` the loop compacts to JSON and feeds back to the model. */
export interface TutorToolResult {
  summary: string;
  data: unknown;
}

/** One tutor tool — the LOCAL registry shape (never the course-agent idiom). */
export interface TutorTool<A = unknown> {
  name: TutorToolName;
  description: string;
  params: z.ZodType<A>;
  execute(args: A, deps: TutorToolDeps): Promise<TutorToolResult>;
}

/* ─────────────────────────── get_lesson_context ─────────────────────────── */

const GetLessonContextParams = z.object({
  lessonId: z.string().describe("The lesson id (of THIS course) to load."),
});

const getLessonContext: TutorTool<z.infer<typeof GetLessonContextParams>> = {
  name: "get_lesson_context",
  description:
    "Load another lesson of THIS course — its readable content and the concepts anchored to it — so you can teach across the course. Cite what you use. Returns a compact, budget-capped context block.",
  params: GetLessonContextParams,
  async execute(args, deps) {
    const text = assembleLessonContext(deps.snapshot, args.lessonId, deps.conceptNodes);
    const found = !text.startsWith("Lesson not found:");
    return {
      summary: found
        ? `Loaded lesson context for ${args.lessonId} (${text.length} chars).`
        : `Lesson ${args.lessonId} not found in this publication.`,
      data: { lessonId: args.lessonId, found, context: text },
    };
  },
};

/* ─────────────────────────── get_mastery_summary ────────────────────────── */

const GetMasterySummaryParams = z.object({});

/** Re-derive the L3 learner-state block on demand (the same read the loop does
 *  at turn start). Reads ONLY the learner's own rows via the learner-scoped
 *  client: my_review_queue (definer RPC, own rows) + learner_mastery (RLS: own
 *  rows). rootCause runs over those rows + the course edges. */
const getMasterySummary: TutorTool<z.infer<typeof GetMasterySummaryParams>> = {
  name: "get_mastery_summary",
  description:
    "Refresh this learner's private mastery snapshot (their review queue, this lesson's concept mastery, and the likely upstream gap). Their data, for your guidance only — never shown to anyone else.",
  params: GetMasterySummaryParams,
  async execute(_args, deps) {
    const state = await gatherLearnerState(deps);
    const text = assembleLearnerState(state, { threshold: TUTOR_MASTERY_THRESHOLD });
    return {
      summary: `Refreshed learner mastery snapshot (${state.masteryRows.length} nodes, queue ${state.reviewQueue.length}).`,
      data: { learnerState: text, rootCauseNodeId: state.rootCauseNodeId },
    };
  },
};

/**
 * Gather the L3 inputs on the LEARNER-scoped client. EXPORTED so the loop
 * assembles the SAME block at turn start (one code path, one privacy boundary).
 * `lessonNodeIds` is the set of node ids anchored to the current lesson (scopes
 * the mastery section); rootCause runs over the learner's own mastery + course
 * edges.
 */
export async function gatherLearnerState(deps: TutorToolDeps): Promise<LearnerStateInputs> {
  const { learnerClient, ctx } = deps;

  // The review queue (definer RPC — own rows only).
  const reviewQueue: LearnerStateInputs["reviewQueue"] = [];
  try {
    const { data } = await learnerClient.rpc("my_review_queue", { p_course_id: ctx.courseId });
    if (Array.isArray(data)) {
      for (const r of data) {
        reviewQueue.push({ nodeId: r.node_id, title: r.title, rank: r.rank });
      }
    }
  } catch {
    // A read failure degrades to an empty section — never throws a turn.
  }

  // The learner's own mastery rows (RLS: own rows).
  const masteryRows: LearnerStateInputs["masteryRows"] = [];
  const masteryLike: Array<{ nodeId: string; decayedP: number }> = [];
  try {
    const { data } = await learnerClient
      .from("learner_mastery")
      .select("node_id, decayed_p")
      .eq("course_id", ctx.courseId);
    if (Array.isArray(data)) {
      for (const r of data) {
        masteryRows.push({ nodeId: r.node_id, decayedP: r.decayed_p });
        masteryLike.push({ nodeId: r.node_id, decayedP: r.decayed_p });
      }
    }
  } catch {
    // degrade silently
  }

  // Node ids anchored to the current lesson (scopes the mastery section), plus a
  // title lookup used by the root-cause line and the mastery rows.
  const lessonId = ctx.lessonId;
  const lessonNodeIds: string[] = [];
  const nodeTitleById = new Map<string, string>();
  for (const n of deps.conceptNodes) {
    nodeTitleById.set(n.id, n.title);
    if (lessonId && conceptAnchoredToLesson(n.anchors, lessonId)) lessonNodeIds.push(n.id);
  }
  for (const r of masteryRows) {
    r.title = nodeTitleById.get(r.nodeId) ?? null;
  }

  // Root cause: the deepest below-mastery prerequisite of this lesson's concepts.
  // Pick the weakest below-threshold lesson node as the target, then walk upstream.
  let rootCauseNodeId: string | null = null;
  if (lessonNodeIds.length > 0 && masteryLike.length > 0) {
    const lessonSet = new Set(lessonNodeIds);
    const target = [...masteryLike]
      .filter((m) => lessonSet.has(m.nodeId))
      .sort((a, b) => a.decayedP - b.decayedP || a.nodeId.localeCompare(b.nodeId))[0];
    if (target) rootCauseNodeId = rootCause(masteryLike, deps.conceptEdges, target.nodeId);
  }

  return {
    reviewQueue,
    masteryRows,
    lessonNodeIds,
    rootCauseNodeId,
    nodeTitleById,
    recentSynopsis: [],
  };
}

/** Leniently test whether a concept node's jsonb anchors reference a lesson. */
function conceptAnchoredToLesson(anchors: unknown, lessonId: string): boolean {
  if (!Array.isArray(anchors)) return false;
  for (const a of anchors) {
    if (a && typeof a === "object" && (a as Record<string, unknown>).lessonId === lessonId) {
      return true;
    }
  }
  return false;
}

/* ─────────────────────────── generate_practice ──────────────────────────── */

const GeneratePracticeParams = z.object({
  nodeIds: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("The 1–3 concept node ids the practice should target."),
  kind: z
    .enum(["mc", "short"])
    .optional()
    .describe("Preferred item kind (multiple-choice or short-answer)."),
});

/** The strict shape the practice-gen model returns. W4 (Contract 5): the item
 *  now AUTHORS its own key + a one-line explanation — practice is FORMATIVE and
 *  LOW-STAKES, so the client grades locally and the answer is revealed only AFTER
 *  the learner answers. Every added field is `.nullable()` (the strict-schema
 *  rule — the JSON-schema converter makes optionals nullable on the wire); the
 *  prompt, not the schema, requires the key for the applicable kind. */
const PracticeGenItemSchema = z.object({
  nodeId: z.string(),
  kind: z.enum(["mc", "short"]),
  prompt: z.string(),
  /** 4 choices when kind === "mc"; null/absent for short-answer. */
  choices: z.array(z.string()).nullable().optional(),
  /** The correct choice index (0..3) for `mc`; null for `short`. */
  correctChoiceIndex: z.number().int().min(0).max(3).nullable().optional(),
  /** 1–3 accepted answers for `short` (trim/lowercase match); null for `mc`. */
  acceptedAnswers: z.array(z.string()).max(4).nullable().optional(),
  /** A one-line explanation shown after the learner answers. */
  explanation: z.string().max(240).nullable().optional(),
});
const PracticeGenOutputSchema = z.object({
  items: z.array(PracticeGenItemSchema).min(1).max(3),
});

/** One minted practice item (the loop returns these to the model + the route
 *  persists nothing here — the item lives only for this turn until answered).
 *  W4: it carries its OWN key so the client grades locally (formative). */
export interface MintedPracticeItem {
  nodeId: string;
  practiceItemRef: string;
  kind: "mc" | "short";
  prompt: string;
  choices: string[] | null;
  /** The correct choice index for `mc`; null for `short` or a keyless item. */
  correctChoiceIndex: number | null;
  /** Accepted short-answer strings for `short`; null for `mc` or keyless. */
  acceptedAnswers: string[] | null;
  /** A one-line explanation revealed after the learner answers; null if absent. */
  explanation: string | null;
  /** [FWD] reserved for a future item bank — ALWAYS null in Wave 3. */
  itemBankRef: null;
}

const generatePractice: TutorTool<z.infer<typeof GeneratePracticeParams>> = {
  name: "generate_practice",
  description:
    "Produce 1–3 short practice items targeted at named concept nodes. Each item is tagged with its node and a practice reference, so answering it feeds the learner's mastery. Offer practice when a concept firms up or the learner wants reps. Items are FORMATIVE and low-stakes: author the answer key + a one-line explanation on each item, but the answer is revealed to the learner only AFTER they answer.",
  params: GeneratePracticeParams,
  async execute(args, deps) {
    const job = TUTOR_MODELS.practice_gen;
    const kindHint = args.kind ? ` Prefer ${args.kind} items.` : "";
    const call = await runStructuredCall(deps.model, {
      system:
        "You author short FORMATIVE practice items grounded in this course's concepts. Return ONLY the JSON object. For a multiple-choice ('mc') item, provide exactly 4 plausible choices AND the 0-based index of the correct one in `correctChoiceIndex`. For a short-answer ('short') item, omit choices and give 1–3 accepted answers in `acceptedAnswers` (they'll be matched trim/lowercase). Add a one-line `explanation` on every item. The item is formative — the answer is shown only after the learner answers, so DO author the key.",
      input: `Generate practice items for concept node ids: ${args.nodeIds.join(", ")}.${kindHint}`,
      outputName: "tutor_practice_gen",
      outputSchema: PracticeGenOutputSchema,
      model: job.model,
      effort: job.effort,
      timeoutMs: job.timeoutMs,
      maxRetries: job.maxRetries,
      maxOutputTokens: job.maxOutputTokens,
    });

    if (!call.ok || !call.data) {
      return {
        summary: `Practice generation failed (${call.error ?? "unknown"}).`,
        data: { items: [] as MintedPracticeItem[], error: call.error ?? "practice_gen_failed" },
      };
    }

    // Mint a stable practiceItemRef per item; itemBankRef is [FWD]-carried null.
    // The key rides the item (formative); a missing/kind-mismatched key is
    // carried as null so the client renders a keyless "discuss with the tutor"
    // card rather than fake-grading.
    const items: MintedPracticeItem[] = call.data.items.map((it) => ({
      nodeId: it.nodeId,
      practiceItemRef: crypto.randomUUID(),
      kind: it.kind,
      prompt: it.prompt,
      choices: it.kind === "mc" ? it.choices ?? null : null,
      correctChoiceIndex: it.kind === "mc" ? it.correctChoiceIndex ?? null : null,
      acceptedAnswers:
        it.kind === "short" && it.acceptedAnswers && it.acceptedAnswers.length > 0
          ? it.acceptedAnswers
          : null,
      explanation: it.explanation ?? null,
      itemBankRef: null,
    }));

    return {
      summary: `Generated ${items.length} practice item(s) for ${args.nodeIds.length} concept(s).`,
      data: { items },
    };
  },
};

/* ───────────────────────────── emit_evidence ────────────────────────────── */

const EmitEvidenceParams = z.object({
  items: z
    .array(TutorInferencePayloadSchema)
    .min(1)
    .max(4)
    .describe(
      "1–4 mastery inferences to record. Weak/moderate strengths only — you inform the model, never decree it."
    ),
});

/**
 * emit_evidence WRITES NOTHING (see the module header). It VALIDATES the
 * inference payloads against the frozen Wave-3 contract and RETURNS them; the
 * route is the single writer/emitter (idempotent, admin-client, server-only).
 */
const emitEvidence: TutorTool<z.infer<typeof EmitEvidenceParams>> = {
  name: "emit_evidence",
  description:
    "Record structured mastery inference(s) for the concept(s) this turn revealed signal about (they nailed it unprompted / they're guessing). Weak and moderate strengths only. These are queued and emitted by the runtime — this tool itself persists nothing.",
  params: EmitEvidenceParams,
  async execute(args) {
    // The Zod params already validated each item against TutorInferencePayloadSchema;
    // re-validate defensively so a caller passing raw args can't smuggle a bad shape.
    const items: TutorInferencePayload[] = args.items.map((it) =>
      TutorInferencePayloadSchema.parse(it)
    );
    return {
      summary: `Queued ${items.length} mastery inference(s) for emission by the runtime.`,
      data: { items },
    };
  },
};

/* ─────────────────────────── propose_escalation ─────────────────────────── */

const ProposeEscalationParams = z.object({
  learnerQuestion: z
    .string()
    .describe("The learner's question, verbatim — what deserves the instructor's answer."),
  nodeIds: z.array(z.string()).describe("The concept node id(s) the learner is stuck on."),
  proposedAnswer: z
    .string()
    .describe("Your best proposed answer, surfaced to the instructor (never auto-sent to the learner)."),
});

/**
 * The ONE write in the tutor surface: draft a consent-pending escalation
 * candidate (the service role writes it — a learner has no insert policy). The
 * candidate is invisible to the creator until the learner consents (strict
 * regime, migration 20260804100000). Returns {consentRequired:true, candidateId}.
 */
const proposeEscalation: TutorTool<z.infer<typeof ProposeEscalationParams>> = {
  name: "propose_escalation",
  description:
    "When the course can't answer or the learner is stuck beyond your scaffolds: draft an escalation (their question, the concepts, your proposed answer) for THEIR consent to share with the instructor. Nothing reaches the instructor without that consent — say so when proposing.",
  params: ProposeEscalationParams,
  async execute(args, deps) {
    const insert: Database["public"]["Tables"]["tutor_escalation_candidates"]["Insert"] = {
      user_id: deps.ctx.userId,
      course_id: deps.ctx.courseId,
      node_ids: args.nodeIds,
      anchors: [],
      learner_question: args.learnerQuestion,
      tutor_proposed_answer: args.proposedAnswer,
      rung_trail: [],
      // status defaults to 'consent_pending' in the DB — never set here.
    };
    const { data, error } = await deps.serviceClient
      .from("tutor_escalation_candidates")
      .insert(insert)
      .select("id")
      .single();
    if (error || !data) {
      return {
        summary: `Failed to draft escalation (${error?.message ?? "unknown"}).`,
        data: { consentRequired: true, candidateId: null, error: error?.message ?? "insert_failed" },
      };
    }
    return {
      summary: "Drafted an escalation candidate — pending the learner's consent to share with the instructor.",
      data: { consentRequired: true, candidateId: data.id },
    };
  },
};

/* ─────────────────────────────── registry ───────────────────────────────── */

/** The five tutor tools, keyed by name. */
export const TUTOR_TOOLS: Record<TutorToolName, TutorTool> = {
  get_lesson_context: getLessonContext as TutorTool,
  get_mastery_summary: getMasterySummary as TutorTool,
  generate_practice: generatePractice as TutorTool,
  emit_evidence: emitEvidence as TutorTool,
  propose_escalation: proposeEscalation as TutorTool,
};

/** Re-export the snapshot-index builder so a caller wiring deps has one import. */
export { buildSnapshotIndex };
