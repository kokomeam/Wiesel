/**
 * TUTOR-1 Wave 3 (package C2) — the LIVE tutor turn loop.
 *
 * `runTutorTurn` is the single orchestration point for one learner turn: it
 * assembles the byte-stable layered prompt (L0..L4), runs a BOUNDED tool loop
 * (≤3 rounds) over the FIVE tutor tools, parses the structured turn output,
 * applies the deterministic scaffolding overrides, validates grounding against
 * the learner's own snapshot, and returns a fully-cleaned result the ROUTE
 * (Wave 3 §C3) persists + emits from.
 *
 * ── DESIGN INVARIANTS ────────────────────────────────────────────────────────
 *  • DETERMINISTIC + FULLY MOCKABLE: every model call goes through deps.model
 *    (the mock's scripted/structured seam); no wall-clock (nowIso is a seam);
 *    ids come from the caller's inputs, not Date.now.
 *  • NEVER THROWS: any failure settles into { ok:false, error } — the same
 *    contract as runGraphExtraction. A learner turn must never crash the route.
 *  • The MODEL is already pooled by the caller (withPooledModel) — the loop
 *    never wraps it again.
 *  • emit_evidence WRITES NOTHING here — the route emits the queued inferences.
 *
 * ── ORDER OF OPERATIONS (load-bearing) ───────────────────────────────────────
 *  model structured output
 *    → applyScaffolding (rung overrides: just-show-me / opening-turn clamp)
 *    → validateTurnOutput (citations resolve · canon suppression · grounding)
 *    → return { output: cleaned, flags, ok }.
 *  Scaffolding runs on the RAW TurnOutput (it needs the marker prose + rung);
 *  validation then cleans the (rung-adjusted) output.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import type {
  ModelClient,
  ModelInputItem,
  ModelStreamEvent,
} from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { getCachedSnapshot } from "@/lib/learn/publicationCache";
import { TUTOR_MASTERY_THRESHOLD } from "@/lib/tutor/mastery/config";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";

import { resolveCharter, serializeCharter, type TutorCharter } from "./charter";
import { assembleLessonContext, type LessonConceptNode } from "./lessonContext";
import { assembleLearnerState } from "./learnerState";
import {
  serializeHistory,
  collapseToChaining,
  HISTORY_MAX_TURNS,
  type HistoryTurn,
} from "./history";
import {
  assembleTutorPrompt,
  LAYER_BUDGETS,
} from "./promptLayers";
import {
  TurnOutputSchema,
  type TurnOutput,
} from "./outputContract";
import {
  applyScaffolding,
  detectJustShowMe,
} from "./scaffolding";
import {
  buildSnapshotIndex,
  validateTurnOutput,
  type SnapshotIndex,
  type ValidatedTurn,
} from "./grounding";
import {
  deriveSessionState,
  shouldInterjectRootCause,
  ROOT_CAUSE_INTERJECTION_MARKER,
  type SessionTurn,
} from "./session";
import {
  TUTOR_TOOLS,
  TUTOR_TOOL_NAMES,
  gatherLearnerState,
  type MintedPracticeItem,
  type TutorToolCtx,
  type TutorToolDeps,
} from "./tools";
import type { TutorInferencePayload } from "@/lib/analytics/events";
import type { z } from "zod";

type DB = SupabaseClient<Database>;

/** The `guidanceStyle` field on the charter maps 1:1 to the scaffolding style. */
type GuidanceStyle = TutorCharter["guidanceStyle"];

/* ─────────────────────────────── inputs ─────────────────────────────────── */

export interface RunTutorTurnDeps {
  /** Learner-scoped client (own mastery/queue/thread reads). */
  learnerClient: DB;
  /** Admin client (the ONE write — propose_escalation). */
  serviceClient: DB;
  /** ALREADY POOLED ModelClient (the caller wraps it via withPooledModel). */
  model: ModelClient;
  /** Injectable snapshot loader (defaults to getCachedSnapshot). */
  loadSnapshot?: (publicationId: string) => Promise<{ snapshot: PublicationSnapshot }>;
  /** The course's concept nodes (anchors drive L2/L3 + get_lesson_context). */
  conceptNodes: LessonConceptNode[];
  /** The course's concept edges (root-cause + prerequisite adjacency). */
  conceptEdges: EdgeLike[];
  /** Wall-clock seam (deterministic tests); reserved for future recency use. */
  nowIso?: string;
  /** Abort seam — threaded into every model call (cancel a stalled turn). */
  signal?: AbortSignal;
}

export interface RunTutorTurnCtx {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId?: string;
  blockId?: string;
  slideId?: string;
  /** Ambient assessment state — the model scaffolds (never states) a live answer. */
  quizActive?: boolean;
  /** The raw tutor_course_settings row (or null → charter defaults). */
  charterRow: Database["public"]["Tables"]["tutor_course_settings"]["Row"] | null;
  /** The replayed thread tail (oldest → newest). */
  historyTurns: HistoryTurn[];
  /** THIS turn's learner message. */
  learnerMessage: string;
  /** Opaque session flags (reserved — carried through, not interpreted). */
  sessionFlags?: Record<string, unknown>;
}

/* ─────────────────────────────── result ─────────────────────────────────── */

export interface TutorTurnResult {
  ok: boolean;
  /** The cleaned, validated turn (marker-free prose + resolved citations). */
  output: ValidatedTurn["cleaned"] | null;
  /** Grounding flags (citation_dropped / anchor_downgraded / ungrounded / …). */
  groundingFlags: string[];
  /** The raw evidence payloads the tutor emitted (the ROUTE emits these). */
  evidence: TutorInferencePayload[];
  /** Practice items minted this turn (generate_practice), if any. */
  practiceItems: MintedPracticeItem[];
  /** The escalation, when propose_escalation ran (candidateId or null). */
  escalation: { candidateId: string | null; consentRequired: true } | null;
  /** One {tool, summary} per tool call executed (replayable trace). */
  toolTrace: { tool: string; summary: string }[];
  /** Accumulated token usage across every model round. */
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number };
  /** The LAST round's provider response id (the chaining anchor for the next turn). */
  responseId: string | null;
  /** The rung the turn resolved at (post-scaffolding), for the row + telemetry. */
  rung: number | null;
  /** W3.5 · session markers stamped on THIS turn (e.g. 'root_cause_interjection').
   *  Persisted into the assistant row's grounding jsonb so the NEXT turn's derived
   *  session state sees which once-per-session behaviors already fired. */
  sessionMarkers: string[];
  error?: string;
}

/* ─────────────────────────────── constants ──────────────────────────────── */

/** The bounded tool-loop cap — ≤3 rounds (Wave 3 §3.1: the interactive turn). */
const MAX_TOOL_ROUNDS = 3;

/** How many chars of each history turn seed the recent-session synopsis (≤6). */
const SYNOPSIS_CHARS = 80;

/* ── W3.5 · session behaviors + assessment integrity ─────────────────────────
 *
 * The highest rung a `concept_review_only` charter permits while a quiz is LIVE.
 * A rung-4 verbatim answer is never allowed during an active assessment; rung 3
 * (a worked partial that still leaves the last step) is the ceiling, so concept
 * scaffolding continues but the on-screen question is never handed over. */
export const ASSESSMENT_ACTIVE_MAX_RUNG = 3;

/** Default copy the loop appends when it CLAMPS a would-be full answer during an
 *  active assessment (concept_review_only). `charter.toneNotes` tweaks the voice
 *  via `assessmentDeferCopy(toneNotes)` — never the substance. */
export const ASSESSMENT_DEFER_COPY =
  "I can't hand over the answer to a live quiz question — but I'll gladly walk the concept behind it right now, and the question itself the moment you've made your attempt.";

/** The tone-aware variant. A charter tone note is woven into a short lead so the
 *  defer reads in the creator's voice; the commitment (no verbatim answer, help
 *  with the concept) is invariant. */
export function assessmentDeferCopy(toneNotes?: string | null): string {
  const note = toneNotes?.trim();
  if (!note) return ASSESSMENT_DEFER_COPY;
  return `${ASSESSMENT_DEFER_COPY} (${note})`;
}

/** The typed refusal copy for a `block` charter while a quiz is live — the whole
 *  turn short-circuits to this (rung 0, zero model calls, zero evidence). */
export const ASSESSMENT_BLOCK_COPY =
  "While this quiz is in progress I can't help with it — that's the course's rule for graded work. As soon as you've submitted, I'm here to review any concept it covered.";

/** The per-turn instruction appended to the model input when a quiz is active.
 *  Names the integrity behavior so it rides the per-turn input (NOT L0). */
function assessmentInstruction(mode: "block" | "concept_review_only"): string {
  return mode === "block"
    ? "A graded quiz is ACTIVE and this course blocks assessment help: do not help with the quiz; warmly point to reviewing the concepts after the attempt."
    : "A graded quiz is ACTIVE: scaffold the underlying CONCEPT only — never state the answer to the on-screen question verbatim, at any rung. Concept review divorced from the live question is fine.";
}

/** The per-turn instruction appended when the root-cause interjection fires. */
function rootCauseInterjectionInstruction(title: string): string {
  return `If it feels natural this turn, briefly offer to check "${title}" first — offer it ONCE, and drop it immediately if the learner would rather push on.`;
}

/* ─────────────────────────────── the loop ───────────────────────────────── */

export async function runTutorTurn(
  deps: RunTutorTurnDeps,
  ctx: RunTutorTurnCtx
): Promise<TutorTurnResult> {
  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  const empty = (error: string): TutorTurnResult => ({
    ok: false,
    output: null,
    groundingFlags: [],
    evidence: [],
    practiceItems: [],
    escalation: null,
    toolTrace: [],
    usage,
    responseId: null,
    rung: null,
    sessionMarkers: [],
    error,
  });

  try {
    /* ── Charter (L1). ── */
    const charter = resolveCharter(ctx.charterRow);
    const style: GuidanceStyle = charter.guidanceStyle;

    /* ── Snapshot + index. ── */
    const loaded = deps.loadSnapshot
      ? await deps.loadSnapshot(ctx.publicationId)
      : await getCachedSnapshot(ctx.publicationId);
    const snapshot = loaded.snapshot;
    const index: SnapshotIndex = buildSnapshotIndex(snapshot);

    /* ── The docked lesson (fall back to the first lesson of the snapshot). ── */
    const lessonId = ctx.lessonId ?? firstLessonId(snapshot);

    /* ── L1 · L2. ── */
    const charterSerialized = serializeCharter(charter);
    const lessonContext = lessonId
      ? assembleLessonContext(snapshot, lessonId, deps.conceptNodes, {
          blockId: ctx.blockId,
          slideId: ctx.slideId,
          budgetChars: LAYER_BUDGETS.l2Chars,
        })
      : "LESSON: (none)";

    /* ── Tool deps (shared by the loop's tool executions). ── */
    const toolCtx: TutorToolCtx = {
      userId: ctx.userId,
      courseId: ctx.courseId,
      publicationId: ctx.publicationId,
      version: ctx.version,
      lessonId,
    };
    const toolDeps: TutorToolDeps = {
      learnerClient: deps.learnerClient,
      serviceClient: deps.serviceClient,
      snapshot,
      snapshotIndex: index,
      conceptNodes: deps.conceptNodes,
      conceptEdges: deps.conceptEdges,
      charter,
      ctx: toolCtx,
      model: deps.model,
    };

    /* ── L3: the learner state (own rows, learner-scoped) + a recent synopsis. ── */
    const state = await gatherLearnerState(toolDeps);
    state.recentSynopsis = deriveSynopsis(ctx.historyTurns);
    const learnerState = assembleLearnerState(state, {
      threshold: TUTOR_MASTERY_THRESHOLD,
      budgetChars: LAYER_BUDGETS.l3Chars,
    });

    /* ── W3.5 · SESSION STATE (derived from history) + the two behavior hooks. ──
     *
     * Session state is derived statelessly from the thread history (session.ts).
     * TWO behaviors ride the PER-TURN INPUT (never L0 — so the cached prefix is
     * untouched): the root-cause interjection instruction and the assessment-
     * integrity instruction. The `block` case short-circuits BEFORE any model
     * call; the concept_review_only clamp is applied AFTER scaffolding. */
    const nowIso = deps.nowIso ?? new Date().toISOString();
    const sessionTurns: SessionTurn[] = ctx.historyTurns.map((t) => ({
      role: t.role,
      content: t.content,
      createdAt: t.createdAt ?? nowIso,
      grounding: t.grounding,
    }));
    const sessionState = deriveSessionState(sessionTurns, nowIso);

    // (a) ASSESSMENT INTEGRITY, mode 'block': short-circuit with a typed refusal
    //     BEFORE the model — zero model calls, zero evidence, rung 0, no citations.
    if (ctx.quizActive && charter.assessmentHelp === "block") {
      const spans = [{ kind: "grounded" as const, text: ASSESSMENT_BLOCK_COPY }];
      return {
        ok: true,
        output: {
          citations: [],
          rung: 0,
          evidence: [],
          practiceItems: undefined,
          escalationProposal: null,
          prose: ASSESSMENT_BLOCK_COPY,
          spans,
        },
        groundingFlags: [],
        evidence: [],
        practiceItems: [],
        escalation: null,
        toolTrace: [],
        usage,
        responseId: null,
        rung: 0,
        sessionMarkers: [],
      };
    }

    // (b) The extra per-turn instruction lines (input-only; L0 is never touched).
    const extraInstructions: string[] = [];

    // Assessment integrity for a LIVE quiz under concept_review_only.
    const assessmentActive = !!ctx.quizActive && charter.assessmentHelp === "concept_review_only";
    if (assessmentActive) {
      extraInstructions.push(assessmentInstruction("concept_review_only"));
    }

    // Root-cause interjection — fire at most ONCE per session (session.ts owns the
    // gate); the marker is stamped into THIS turn's grounding on the way out.
    const interject = shouldInterjectRootCause({
      sessionState,
      rootCauseNodeId: state.rootCauseNodeId,
      lessonNodeIds: state.lessonNodeIds,
    });
    let interjectionStamped = false;
    if (interject && state.rootCauseNodeId) {
      const title = state.nodeTitleById?.get(state.rootCauseNodeId) ?? state.rootCauseNodeId;
      extraInstructions.push(rootCauseInterjectionInstruction(title));
      interjectionStamped = true;
    }

    /* ── L4: textual history, OR provider-side chaining when the flag is on. ── */
    const chained = collapseToChaining(ctx.historyTurns);
    const historyText = chained
      ? "" // chaining collapses the textual replay
      : serializeHistory(ctx.historyTurns, LAYER_BUDGETS.l4Chars);

    /* ── Assemble the prompt (system + developer + input). ── */
    const basePrompt = assembleTutorPrompt({
      charterSerialized,
      lessonContext,
      learnerState,
      historyText,
      learnerMessage: ctx.learnerMessage,
    });
    // Append the behavior instructions to the per-turn INPUT (after the message),
    // so the stable L0/L1/L2 prefix — the cache line — is byte-unchanged.
    const prompt = extraInstructions.length
      ? { ...basePrompt, input: `${basePrompt.input}\n\n${extraInstructions.join("\n")}` }
      : basePrompt;

    /* ── Strict tool schemas for the five tutor tools. ── */
    const tools = TUTOR_TOOL_NAMES.map((name) => {
      const t = TUTOR_TOOLS[name];
      return { name: t.name, description: t.description, parameters: toStrictJsonSchema(t.params) };
    });

    const responseFormat = {
      name: "tutor_turn_output",
      schema: toStrictJsonSchema(TurnOutputSchema),
    };

    const job = TUTOR_MODELS.tutor_turn;

    /* ── The BOUNDED tool loop. Each round runs one model turn; any tool_call
     *    events are executed locally, their compact JSON results fed back as
     *    function_call/function_call_output items; after MAX_TOOL_ROUNDS or when
     *    the model answers (structured final, no tool calls) we parse. ── */
    const developerItem: ModelInputItem = { role: "developer", content: prompt.developer };
    const userItem: ModelInputItem = { role: "user", content: prompt.input };
    const conversation: ModelInputItem[] = [developerItem, userItem];

    const toolTrace: { tool: string; summary: string }[] = [];
    const evidence: TutorInferencePayload[] = [];
    const practiceItems: MintedPracticeItem[] = [];
    let escalation: TutorTurnResult["escalation"] = null;
    let lastResponseId: string | null = chained?.previousResponseId ?? null;
    let finalText = "";
    let parsedOutput: TurnOutput | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const noop = (_ev: ModelStreamEvent) => void _ev;
      const result = await deps.model.runTurn(
        {
          system: prompt.system,
          input: conversation,
          tools,
          responseFormat,
          stream: false,
          signal: deps.signal,
          model: job.model,
          effort: job.effort,
          timeoutMs: job.timeoutMs,
          maxRetries: job.maxRetries,
          maxOutputTokens: job.maxOutputTokens,
          ...(chained ? { previousResponseId: chained.previousResponseId } : {}),
        },
        noop
      );
      addUsage(usage, result.usage);
      lastResponseId = result.responseId ?? lastResponseId;
      finalText = result.text;

      if (result.finishReason === "error") {
        return { ...empty(result.errorKind ?? "model_error"), usage, responseId: lastResponseId };
      }

      // No tool calls → the model answered. Parse the structured final.
      if (result.toolCalls.length === 0) {
        parsedOutput = parseTurnOutput(result.text);
        break;
      }

      // Execute each requested tool locally; feed compact JSON results back.
      for (const call of result.toolCalls) {
        conversation.push({ type: "function_call", callId: call.callId, name: call.name, arguments: call.arguments });
        const { summary, data } = await runTool(call.name, call.arguments, toolDeps);
        toolTrace.push({ tool: call.name, summary });

        // Collect side-channel outputs the loop must surface.
        collectToolOutputs(call.name, data, { evidence, practiceItems, setEscalation: (e) => (escalation = e) });

        conversation.push({
          type: "function_call_output",
          callId: call.callId,
          output: compactJson({ summary, data }),
        });
      }
    }

    // If we exhausted the tool rounds without a structured answer, ask ONCE more
    // for the final structured turn (no tools this time — force the answer).
    if (!parsedOutput) {
      const noop = (_ev: ModelStreamEvent) => void _ev;
      const result = await deps.model.runTurn(
        {
          system: prompt.system,
          input: [
            ...conversation,
            { role: "user", content: "Now produce your final tutor turn as the structured JSON object. Do not call any more tools." },
          ],
          tools: [],
          responseFormat,
          stream: false,
          signal: deps.signal,
          model: job.model,
          effort: job.effort,
          timeoutMs: job.timeoutMs,
          maxRetries: job.maxRetries,
          maxOutputTokens: job.maxOutputTokens,
        },
        noop
      );
      addUsage(usage, result.usage);
      lastResponseId = result.responseId ?? lastResponseId;
      finalText = result.text;
      if (result.finishReason === "error") {
        return { ...empty(result.errorKind ?? "model_error"), usage, responseId: lastResponseId };
      }
      parsedOutput = parseTurnOutput(result.text);
    }

    // A single re-ask on parse failure (the runStructuredCall convention, inline).
    if (!parsedOutput) {
      const noop = (_ev: ModelStreamEvent) => void _ev;
      const result = await deps.model.runTurn(
        {
          system: prompt.system,
          input: [
            developerItem,
            userItem,
            { role: "user", content: "The previous response was not valid JSON for the required schema. Respond again with ONLY the JSON object." },
          ],
          tools: [],
          responseFormat,
          stream: false,
          signal: deps.signal,
          model: job.model,
          effort: job.effort,
          timeoutMs: job.timeoutMs,
          maxRetries: job.maxRetries,
          maxOutputTokens: job.maxOutputTokens,
        },
        noop
      );
      addUsage(usage, result.usage);
      lastResponseId = result.responseId ?? lastResponseId;
      finalText = result.text;
      parsedOutput = parseTurnOutput(result.text);
    }

    if (!parsedOutput) {
      return { ...empty("schema_parse_failed"), usage, responseId: lastResponseId };
    }

    void finalText;

    /* ── Scaffolding overrides on the RAW output (needs marker prose + rung). ── */
    let scaffolded = applyScaffolding(parsedOutput, {
      style,
      isOpeningTurn: ctx.historyTurns.length === 0,
      justShowMe: detectJustShowMe(ctx.learnerMessage),
    });

    /* ── W3.5 · ASSESSMENT INTEGRITY clamp (concept_review_only + live quiz). ──
     *
     * The rung is CLAMPED to ≤ ASSESSMENT_ACTIVE_MAX_RUNG while a quiz is live —
     * even an explicit "just show me" (which scaffolding lifted to rung 4) is
     * DEFERRED, never a verbatim answer. When the clamp actually reduces the rung
     * (the turn WANTED to give the answer), the charter-tone-aware defer copy is
     * appended so the learner hears why. Runs on the RAW marked prose (before
     * grounding strips markers) so the appended copy rides through cleanly. */
    if (assessmentActive && scaffolded.rung > ASSESSMENT_ACTIVE_MAX_RUNG) {
      const deferCopy = assessmentDeferCopy(charter.toneNotes);
      scaffolded = {
        ...scaffolded,
        rung: ASSESSMENT_ACTIVE_MAX_RUNG,
        proseWithSpanMarkers: `${scaffolded.proseWithSpanMarkers} ${deferCopy}`.trim(),
      };
    }

    /* ── Grounding validation + canon suppression → the cleaned turn. ── */
    const validated = validateTurnOutput(scaffolded, index, { courseCanon: charter.courseCanon });

    // The turn's OWN evidence (the structured output) merges with any tool-emitted
    // evidence — de-duplicated by (nodeId, direction, turnRef) so a tool that also
    // emitted the same inference doesn't double-count.
    mergeEvidence(evidence, scaffolded.evidence);

    // Evidence items must reference REAL concept nodes: the contract accepts any
    // string nodeId at parse time (a mangled id must not cost the whole turn),
    // so the loop is where non-resolving items drop — flagged, mirroring
    // citation_dropped. Only survivors reach the frozen event schema downstream.
    const knownNodeIds = new Set(deps.conceptNodes.map((n) => n.id));
    const resolvedEvidence = evidence.filter((e) => knownNodeIds.has(e.nodeId));
    if (resolvedEvidence.length !== evidence.length) validated.flags.push("evidence_dropped");

    return {
      ok: validated.ok,
      output: validated.cleaned,
      groundingFlags: validated.flags,
      evidence: resolvedEvidence,
      practiceItems,
      escalation,
      toolTrace,
      usage,
      responseId: lastResponseId,
      rung: scaffolded.rung,
      // Stamp the root-cause marker only when the interjection actually fired AND
      // the turn completed ok — a failed turn persists nothing, so no marker.
      sessionMarkers: interjectionStamped ? [ROOT_CAUSE_INTERJECTION_MARKER] : [],
    };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}

/* ─────────────────────────────── helpers ────────────────────────────────── */

/** Execute a tutor tool by name; unknown names return an error result (never throws). */
async function runTool(
  name: string,
  rawArgs: string,
  deps: TutorToolDeps
): Promise<{ summary: string; data: unknown }> {
  const tool = (TUTOR_TOOLS as Record<string, (typeof TUTOR_TOOLS)[keyof typeof TUTOR_TOOLS]>)[name];
  if (!tool) {
    return { summary: `Unknown tool: ${name}`, data: { error: "unknown_tool" } };
  }
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(rawArgs || "{}");
  } catch {
    return { summary: `Invalid JSON arguments for ${name}`, data: { error: "invalid_args" } };
  }
  const validated = (tool.params as z.ZodType).safeParse(parsedArgs);
  if (!validated.success) {
    return {
      summary: `Invalid arguments for ${name}: ${validated.error.issues[0]?.message ?? "schema error"}`,
      data: { error: "invalid_args" },
    };
  }
  try {
    return await tool.execute(validated.data, deps);
  } catch (err) {
    return { summary: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: "tool_error" } };
  }
}

/** Route a tool's structured output into the loop's side channels. */
function collectToolOutputs(
  name: string,
  data: unknown,
  sinks: {
    evidence: TutorInferencePayload[];
    practiceItems: MintedPracticeItem[];
    setEscalation: (e: TutorTurnResult["escalation"]) => void;
  }
): void {
  if (data == null || typeof data !== "object") return;
  const rec = data as Record<string, unknown>;
  if (name === "emit_evidence" && Array.isArray(rec.items)) {
    for (const it of rec.items) sinks.evidence.push(it as TutorInferencePayload);
  } else if (name === "generate_practice" && Array.isArray(rec.items)) {
    for (const it of rec.items) sinks.practiceItems.push(it as MintedPracticeItem);
  } else if (name === "propose_escalation") {
    sinks.setEscalation({
      candidateId: (rec.candidateId as string | null) ?? null,
      consentRequired: true,
    });
  }
}

/** Parse + validate the structured turn output; null on any parse/schema failure. */
function parseTurnOutput(text: string): TurnOutput | null {
  try {
    const parsed = TurnOutputSchema.safeParse(JSON.parse(text || "{}"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Merge structured-output evidence into the tool-emitted set, de-duped by
 *  (nodeId, direction, turnRef). */
function mergeEvidence(into: TutorInferencePayload[], extra: TutorInferencePayload[]): void {
  const key = (e: TutorInferencePayload) => `${e.nodeId}|${e.direction}|${e.turnRef}`;
  const seen = new Set(into.map(key));
  for (const e of extra) {
    if (seen.has(key(e))) continue;
    seen.add(key(e));
    into.push(e);
  }
}

/** The recent-session synopsis for L3: each of the last ≤6 turns' first ~80 chars. */
function deriveSynopsis(turns: HistoryTurn[]): string[] {
  return turns.slice(-6).map((t) => {
    const who = t.role === "learner" ? "L" : t.role === "instructor" ? "I" : "T";
    const trimmed = t.content.replace(/\s+/g, " ").trim().slice(0, SYNOPSIS_CHARS);
    return `${who}: ${trimmed}`;
  });
}

/** The first lesson id of a snapshot (module order → lesson order), or undefined. */
function firstLessonId(snapshot: PublicationSnapshot): string | undefined {
  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) return lesson.id;
  }
  return undefined;
}

function addUsage(
  total: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number },
  turn: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedTokens?: number } | undefined
): void {
  if (!turn) return;
  total.inputTokens += turn.inputTokens ?? 0;
  total.outputTokens += turn.outputTokens ?? 0;
  total.reasoningTokens += turn.reasoningTokens ?? 0;
  total.cachedTokens += turn.cachedTokens ?? 0;
}

/** Compact a tool result to JSON, capping runaway payloads (a big lesson-context
 *  block feeds back trimmed — the model already saw the docked lesson in L2). */
function compactJson(value: unknown, cap = 8_000): string {
  let s = JSON.stringify(value);
  if (s.length > cap) s = s.slice(0, cap) + '…"}';
  return s;
}

export { HISTORY_MAX_TURNS };
