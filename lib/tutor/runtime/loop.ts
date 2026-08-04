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
  error?: string;
}

/* ─────────────────────────────── constants ──────────────────────────────── */

/** The bounded tool-loop cap — ≤3 rounds (Wave 3 §3.1: the interactive turn). */
const MAX_TOOL_ROUNDS = 3;

/** How many chars of each history turn seed the recent-session synopsis (≤6). */
const SYNOPSIS_CHARS = 80;

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

    /* ── L4: textual history, OR provider-side chaining when the flag is on. ── */
    const chained = collapseToChaining(ctx.historyTurns);
    const historyText = chained
      ? "" // chaining collapses the textual replay
      : serializeHistory(ctx.historyTurns, LAYER_BUDGETS.l4Chars);

    /* ── Assemble the prompt (system + developer + input). ── */
    const prompt = assembleTutorPrompt({
      charterSerialized,
      lessonContext,
      learnerState,
      historyText,
      learnerMessage: ctx.learnerMessage,
    });

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
      const noop = (_ev: ModelStreamEvent) => {};
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
      const noop = (_ev: ModelStreamEvent) => {};
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
      const noop = (_ev: ModelStreamEvent) => {};
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
    const scaffolded = applyScaffolding(parsedOutput, {
      style,
      isOpeningTurn: ctx.historyTurns.length === 0,
      justShowMe: detectJustShowMe(ctx.learnerMessage),
    });

    /* ── Grounding validation + canon suppression → the cleaned turn. ── */
    const validated = validateTurnOutput(scaffolded, index, { courseCanon: charter.courseCanon });

    // The turn's OWN evidence (the structured output) merges with any tool-emitted
    // evidence — de-duplicated by (nodeId, direction, turnRef) so a tool that also
    // emitted the same inference doesn't double-count.
    mergeEvidence(evidence, scaffolded.evidence);

    return {
      ok: validated.ok,
      output: validated.cleaned,
      groundingFlags: validated.flags,
      evidence,
      practiceItems,
      escalation,
      toolTrace,
      usage,
      responseId: lastResponseId,
      rung: scaffolded.rung,
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
