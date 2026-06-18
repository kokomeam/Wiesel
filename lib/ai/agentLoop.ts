/**
 * The server-side agentic loop — provider-neutral.
 *
 * Per user turn: persist the user message, load the document + replayed history,
 * then loop: stream a model turn → for each tool call, validate args + apply its
 * CoursePatches to the in-memory doc + stream a tool_result → feed the output
 * back → repeat until the model returns no tool calls (capped, with a
 * checkpoint for very large jobs). Finally reconcile the doc to the DB ONCE and
 * stage the turn's net block changes as one reviewable change-set.
 *
 * Everything mutates through the same CoursePatch pipeline the studio UI uses;
 * the loop never imports a provider SDK (that lives behind ModelClient).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { applyCoursePatch, CoursePatchSchema } from "@/lib/course/patches";
import { findLesson } from "@/lib/course/queries";
import type { CourseDocument } from "@/lib/course/types";
import { buildContextMessage, buildSystemPrompt } from "./context";
import { createChangeSet } from "./changeSet";
import { diffBlocks, type BlockChange } from "./changeSetDiff";
import { buildGenerationState, serializeGenerationState, type RecentChange } from "./generationState";
import { buildBoundedAgentInput, defaultHistoryPolicy, editHistoryPolicy, type HistoryPolicy } from "./historyPolicy";
import {
  loadHistory,
  saveAssistantMessage,
  saveToolMessage,
  saveUserMessage,
  updateToolMessageOutput,
} from "./conversations";
import type { AgentEvent } from "./events";
import type { ModelClient, ModelInputItem, ModelTurnResult, ReasoningEffort } from "./modelClient";
import type { LessonOutline } from "./outline";
import { loadCourseDoc, reconcileCourseDoc } from "./serverPersistence";
import { AUTHORING_TOOL_NAMES, GENERATE_TOOL_NAMES, executeTool, getToolDefinitions, type ToolContext } from "./tools";

type DB = SupabaseClient<Database>;
// Per-turn step cap (one model call + its tool batch = one step). Env-overridable;
// a dense single lesson can need more than the old 12 before it's done.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS) || 16;
// A whole agent run (PLAN + every lesson's GENERATE/CRITIQUE) shares ONE call
// budget — the runaway ceiling, mainly for module builds (N lessons × MAX_TURNS).
// Paired with the per-turn cap so the raise above isn't unbounded.
const MAX_TOTAL_CALLS = Number(process.env.AGENT_MAX_TOTAL_CALLS) || 64;

/** A mutable per-run model-call budget, shared by every phase/lesson of one agent
 *  run (passed by reference through the loop contexts). */
export interface CallBudget {
  remaining: number;
}

/** Seed a fresh run budget from env (or the default). */
export function newCallBudget(): CallBudget {
  return { remaining: MAX_TOTAL_CALLS };
}

/** One always-on structured line per model call so the WITHIN-run prompt-cache
 *  hit rate is a measured number (consecutive calls should warm hard), not a
 *  per-phase aggregate that hides the warm-up. Grep `agent_call`. */
export function logModelCall(
  label: string,
  model: string,
  turn: number,
  usage: ModelTurnResult["usage"]
): void {
  console.log(
    JSON.stringify({
      tag: "agent_call",
      label,
      turn,
      model,
      inputTokens: usage?.inputTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
    })
  );
}

/** Per-call options layered onto the loop (the phased pipeline uses these; the
 *  edit/delete paths pass none → byte-identical legacy behavior). */
export interface LoopOptions {
  effort?: ReasoningEffort;
  /** Per-call model override (falls back to the provider default). */
  model?: string;
  /** Layer the GENERATE teaching bar + layout guide onto the system prompt. */
  layered?: boolean;
  /** Inject an approved outline as the authoring spec. */
  outline?: LessonOutline;
  /** Use this exact system prompt instead of building one (CRITIQUE supplies a
   *  fresh-eyes critic prompt + the deck-as-data). */
  systemOverride?: string;
  /** Override the per-turn cap (CRITIQUE uses a small one). */
  maxTurns?: number;
  /** Skip the end-of-loop reconcile + change-set + terminal events so the caller
   *  can finalize ONCE across multiple phases. */
  deferFinalize?: boolean;
  /** Restrict the model to AUTHORING tools (no structural/destructive ops) — the
   *  edit path uses this so a content edit can't churn the course tree. */
  authoringOnly?: boolean;
  /** The narrowest set — structured slide authoring + auxiliary blocks, NO flat
   *  deck/slide ops — so GENERATE/CRITIQUE honor the plan's structured layout. */
  generateTools?: boolean;
  /** Label for the per-call `agent_call` log (e.g. "generate"/"critique"/"edit");
   *  mirrors the phase label so within-run cache hits are attributable. */
  callLabel?: string;
  /** How history is replayed each turn. Omit → the env default (bounded). Pass
   *  `{ mode: "full" }` for the byte-identical legacy full-replay behavior. */
  historyPolicy?: HistoryPolicy;
}

/** Accumulated token usage across a phase's model turns (instrumentation). */
export interface PhaseUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Input tokens served from the provider's prompt cache (≈90% cheaper). */
  cachedTokens: number;
}

export interface LoopResult {
  doc: CourseDocument;
  docMutated: boolean;
  lastAssistantMessageId: string | null;
  assistantText: string;
  usage: PhaseUsage;
  toolCalls: number;
  /** Number of model turns the loop actually ran (instrumentation). */
  turns: number;
  paused: boolean;
}

export interface AgentRunParams {
  supabase: DB;
  model: ModelClient;
  courseId: string;
  lessonId: string;
  ownerId: string;
  conversationId: string;
  userMessage: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A calm, one-line version of a tool failure for the CHAT transcript. The model
 * still receives the full detail (so it can self-correct), but the user never
 * sees a raw Zod validation dump — these guards are an internal safety net, not
 * a message addressed to them.
 */
function friendlyToolError(toolName: string, detail: string): string {
  const label = TOOL_VERB[toolName] ?? "make that change";
  if (/invalid (json )?arguments|invalid input|expected /i.test(detail)) {
    return `Had to reshape the ${label} and retry.`;
  }
  if (/not found|no access|don'?t have/i.test(detail)) {
    return `Couldn't find what that ${label} pointed at — retrying.`;
  }
  return `Couldn't ${label} on that pass — retrying.`;
}

/** Short verb phrases for the friendly error line (kept generic on purpose). */
const TOOL_VERB: Record<string, string> = {
  set_structured_slide: "slide layout",
  add_structured_slide: "slide layout",
  set_slide_layout: "slide layout",
  update_slide: "slide",
  add_slide: "slide",
  write_slide_deck: "slide deck",
  write_quiz: "knowledge check",
  write_homework: "practice",
  write_lecture_text: "lecture",
};

function changeSummary(changes: BlockChange[]): string {
  const n = (op: string) => changes.filter((c) => c.op === op).length;
  const parts: string[] = [];
  if (n("create")) parts.push(`${n("create")} added`);
  if (n("update")) parts.push(`${n("update")} updated`);
  if (n("delete")) parts.push(`${n("delete")} removed`);
  return parts.join(", ") || "no changes";
}

/** The shared run context for the model loop (everything except the doc). */
export interface LoopContext {
  supabase: DB;
  model: ModelClient;
  courseId: string;
  lessonId: string;
  ownerId: string;
  conversationId: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** The per-run model-call budget, shared across every phase/lesson of one run.
   *  Seeded by `loopContext()`; decremented per model call. */
  callBudget?: CallBudget;
}

/** Reconcile the doc to the DB ONCE and stage the net diff (vs `baselineDoc`) as
 *  one reviewable change-set. Shared by the single-turn loop and the phased
 *  pipeline (which finalizes once after CRITIQUE). The change_sets.lesson_id FK
 *  requires an existing row, so the docked lessonId is coalesced to a changed
 *  block's lesson (always persisted) or NULL. */
export async function reconcileAndStage(
  c: LoopContext,
  doc: CourseDocument,
  baselineDoc: CourseDocument,
  lastAssistantMessageId: string | null
): Promise<void> {
  const err = await reconcileCourseDoc(c.supabase, doc, c.ownerId);
  if (err) c.emit({ type: "error", message: `Some changes may not have saved: ${err}` });

  const changes = diffBlocks(baselineDoc, doc);
  if (changes.length > 0) {
    const summary = changeSummary(changes);
    const stagedLessonId = findLesson(doc, c.lessonId)
      ? c.lessonId
      : (changes.find((ch) => ch.lessonId)?.lessonId ?? null);
    const cs = await createChangeSet(
      c.supabase,
      { courseId: c.courseId, lessonId: stagedLessonId, conversationId: c.conversationId, messageId: lastAssistantMessageId, summary },
      changes
    );
    if (cs) c.emit({ type: "change_set", changeSetId: cs.changeSetId, count: cs.count, summary });
  }
}

/**
 * Run model turns until the agent stops OR a DESTRUCTIVE action needs the
 * user's confirmation (then it pauses, emitting `confirmation_request` + `done`,
 * and `resumeAgentTurn` picks up after the user decides).
 *
 * `doc` is the live in-memory document; `baselineDoc` is the snapshot the
 * end-of-turn change-set diffs against (so an already-applied, already-confirmed
 * delete is excluded from the reviewable set). `initialMutated` forces a final
 * reconcile even if THIS loop makes no further changes (used when resuming after
 * a confirmed delete already mutated `doc`).
 */
export async function runConversationLoop(
  c: LoopContext,
  startDoc: CourseDocument,
  baselineDoc: CourseDocument,
  initialMutated: boolean,
  options: LoopOptions = {}
): Promise<LoopResult> {
  let doc = startDoc;
  // STATIC system (cacheable) + the VARIABLE course/lesson/outline as a leading
  // developer message — so the big static prefix + tools cache across calls.
  const system = options.systemOverride ?? buildSystemPrompt({ layered: options.layered });
  const contextMessage = options.systemOverride
    ? null
    : buildContextMessage(doc, c.lessonId, { outline: options.outline });
  const allowed = options.generateTools
    ? GENERATE_TOOL_NAMES
    : options.authoringOnly
      ? AUTHORING_TOOL_NAMES
      : null;
  const tools = allowed ? getToolDefinitions().filter((t) => allowed.has(t.name)) : getToolDefinitions();
  const history = await loadHistory(c.supabase, c.conversationId);
  const policy = options.historyPolicy ?? defaultHistoryPolicy();
  const maxTurns = options.maxTurns ?? MAX_TURNS;

  // This run's turn-by-turn accumulation (one group per model turn = its
  // assistant text + function_call + function_call_output items). The model input
  // is REBUILT from this each turn (bounded) instead of one ever-growing array.
  const eventGroups: ModelInputItem[][] = [];
  const recentChanges: RecentChange[] = [];

  let fullAssistantText = "";
  let lastAssistantMessageId: string | null = null;
  let docMutated = initialMutated;
  let paused = false;
  const usage: PhaseUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  let toolCallCount = 0;
  let turnsRun = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (c.signal?.aborted) break;

    // Build this turn's model input. Bounded = stable context + a compact
    // generation-state summary + the last K tool groups (older tool I/O dropped,
    // represented by the summary). Full = the legacy whole-transcript replay.
    let input: ModelInputItem[];
    if (policy.mode === "bounded") {
      const stateSummary =
        policy.includeGenerationState
          ? serializeGenerationState(
              buildGenerationState(doc, c.lessonId, {
                phase: options.callLabel ?? "loop",
                outline: options.outline,
                recentChanges: recentChanges.slice(-6),
              }),
              policy.maxStateSummaryChars
            )
          : undefined;
      const built = buildBoundedAgentInput({
        contextMessage,
        generationStateSummary: stateSummary,
        history,
        eventGroups,
        keepRecentToolEvents: policy.keepRecentToolEvents,
        keepRecentChatMessages: policy.keepRecentChatMessages,
        maxToolResultChars: policy.maxToolResultChars,
      });
      input = built.input;
      console.log(JSON.stringify({ tag: "agent_input_compaction", phase: options.callLabel ?? "loop", turn, ...built.stats }));
    } else {
      input = contextMessage
        ? [{ role: "developer", content: contextMessage }, ...history, ...eventGroups.flat()]
        : [...history, ...eventGroups.flat()];
    }

    // The whole run shares one call budget (the module-build runaway guard). When
    // it's spent, stop here the same way the per-turn cap does — emit a checkpoint
    // so the user can ask to continue, then settle whatever's been built.
    if (c.callBudget && c.callBudget.remaining <= 0) {
      c.emit({
        type: "checkpoint",
        reason: "Reached the overall step budget for this request. Ask me to continue if there's more to do.",
        completedSteps: turn,
      });
      break;
    }
    if (c.callBudget) c.callBudget.remaining -= 1;

    const result = await c.model.runTurn({ system, input, tools, signal: c.signal, effort: options.effort, model: options.model }, (ev) => {
      if (ev.type === "text_delta") {
        fullAssistantText += ev.delta;
        c.emit({ type: "assistant_delta", text: ev.delta });
      } else if (ev.type === "tool_call") {
        c.emit({ type: "tool_start", toolCallId: ev.call.callId, tool: ev.call.name });
      } else if (ev.type === "error") {
        c.emit({ type: "error", message: ev.message });
      }
    });
    logModelCall(options.callLabel ?? "loop", options.model ?? c.model.model, turn, result.usage);
    turnsRun += 1;
    usage.inputTokens += result.usage?.inputTokens ?? 0;
    usage.outputTokens += result.usage?.outputTokens ?? 0;
    usage.reasoningTokens += result.usage?.reasoningTokens ?? 0;
    usage.cachedTokens += result.usage?.cachedTokens ?? 0;
    toolCallCount += result.toolCalls.length;

    lastAssistantMessageId = await saveAssistantMessage(c.supabase, c.conversationId, c.courseId, {
      text: result.text,
      toolCalls: result.toolCalls,
    });
    // This turn's items (assistant text + calls + outputs) accumulate here, then
    // get appended to eventGroups so the NEXT turn's bounded tail keeps them whole.
    const group: ModelInputItem[] = [];
    if (result.text) group.push({ role: "assistant", content: result.text });
    for (const tc of result.toolCalls) {
      group.push({ type: "function_call", callId: tc.callId, name: tc.name, arguments: tc.arguments });
    }

    if (result.finishReason === "error") break;
    if (result.toolCalls.length === 0) break;

    for (const call of result.toolCalls) {
      // Once paused, every remaining call in this batch gets a benign deferred
      // output so the saved turn stays a valid (every function_call answered)
      // conversation; the model reconsiders them after the user decides.
      if (paused) {
        const deferred = JSON.stringify({
          status: "deferred",
          message: "Not run — paused for a required confirmation.",
        });
        await saveToolMessage(c.supabase, c.conversationId, c.courseId, { callId: call.callId, name: call.name, output: deferred });
        group.push({ type: "function_call_output", callId: call.callId, output: deferred });
        continue;
      }

      let ok = true;
      let summary = "";
      let outputStr: string;
      let blockId: string | undefined;
      let blockType: string | undefined;

      try {
        const ctx: ToolContext = { doc, courseId: c.courseId, lessonId: c.lessonId };
        const outcome = await executeTool(call.name, call.arguments, ctx);
        summary = outcome.summary;

        // DESTRUCTIVE → do NOT apply; pause and ask the user. The placeholder
        // output keeps the conversation valid; resume rewrites it.
        if (outcome.confirm) {
          const placeholder = JSON.stringify({
            status: "awaiting_confirmation",
            message: `Shown the creator a dialog to confirm deleting ${outcome.confirm.label}. Paused until they decide.`,
          });
          const toolMessageId = await saveToolMessage(c.supabase, c.conversationId, c.courseId, {
            callId: call.callId,
            name: call.name,
            output: placeholder,
          });
          group.push({ type: "function_call_output", callId: call.callId, output: placeholder });
          c.emit({
            type: "confirmation_request",
            toolCallId: call.callId,
            toolMessageId,
            kind: outcome.confirm.kind,
            label: outcome.confirm.label,
            patch: outcome.patches?.[0],
          });
          paused = true;
          continue;
        }

        if (outcome.patches && outcome.patches.length > 0) {
          const preDoc = doc;
          const errors: string[] = [];
          for (const patch of outcome.patches) {
            const safe = CoursePatchSchema.safeParse(patch);
            if (!safe.success) {
              errors.push("invalid patch");
              continue;
            }
            const res = applyCoursePatch(doc, safe.data, nowIso());
            if (res.ok) {
              doc = res.doc;
              docMutated = true;
            } else {
              errors.push(res.error);
            }
          }
          const toolChanges = diffBlocks(preDoc, doc);
          if (toolChanges.length > 0) {
            blockId = toolChanges[0].blockId;
            blockType = toolChanges[0].blockType;
          }
          if (errors.length > 0 && toolChanges.length === 0) {
            ok = false;
            summary = `Couldn't apply change: ${errors[0]}`;
          }
        }

        outputStr =
          outcome.data !== undefined
            ? JSON.stringify(outcome.data)
            : JSON.stringify({ ok, summary });
      } catch (error) {
        ok = false;
        // The MODEL gets the full detail (it needs it to self-correct); the
        // USER-facing card shows a calm one-liner instead of a raw dump.
        const detail = error instanceof Error ? error.message : "Tool failed";
        summary = friendlyToolError(call.name, detail);
        outputStr = JSON.stringify({ error: detail });
      }

      await saveToolMessage(c.supabase, c.conversationId, c.courseId, {
        callId: call.callId,
        name: call.name,
        output: outputStr,
      });
      group.push({ type: "function_call_output", callId: call.callId, output: outputStr });
      recentChanges.push({ turn, toolName: call.name, summary });
      c.emit({ type: "tool_result", toolCallId: call.callId, tool: call.name, ok, summary, blockId, blockType, lessonId: c.lessonId });
    }

    // Finalize this turn's group so the next turn's bounded input can include it.
    eventGroups.push(group);

    if (paused) break;
    if (turn === maxTurns - 1) {
      c.emit({
        type: "checkpoint",
        reason: "Reached the per-turn step limit. Ask me to continue if there's more to do.",
        completedSteps: turn + 1,
      });
    }
  }

  // When deferring, the caller finalizes ONCE after later phases (so a single
  // change-set spans PLAN→GENERATE→CRITIQUE). Otherwise reconcile + stage + close.
  if (!options.deferFinalize) {
    if (docMutated) await reconcileAndStage(c, doc, baselineDoc, lastAssistantMessageId);
    // A paused turn doesn't "settle" with a final message — the popup is the next
    // beat; `done` just closes the stream (the client keeps the streamed text).
    if (!paused) c.emit({ type: "assistant_message", content: fullAssistantText });
    c.emit({ type: "done" });
  }

  return { doc, docMutated, lastAssistantMessageId, assistantText: fullAssistantText, usage, toolCalls: toolCallCount, turns: turnsRun, paused };
}

/** The minimal fields every phase/turn entrypoint shares — lets `loopContext`
 *  accept run params, resume params, and the generate-resume params alike. */
export interface LoopContextSource {
  supabase: DB;
  model: ModelClient;
  courseId: string;
  lessonId: string;
  ownerId: string;
  conversationId: string;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** An existing run budget to keep sharing; omit to start a fresh one. */
  callBudget?: CallBudget;
}

export function loopContext(p: LoopContextSource): LoopContext {
  return {
    supabase: p.supabase,
    model: p.model,
    courseId: p.courseId,
    lessonId: p.lessonId,
    ownerId: p.ownerId,
    conversationId: p.conversationId,
    emit: p.emit,
    signal: p.signal,
    // One budget per agent run, shared across every phase/lesson it spawns
    // (downstream contexts spread from this one, so they share the reference).
    callBudget: p.callBudget ?? newCallBudget(),
  };
}

export async function runAgentTurn(p: AgentRunParams): Promise<void> {
  await saveUserMessage(p.supabase, p.conversationId, p.courseId, p.userMessage);

  const doc = await loadCourseDoc(p.supabase, p.courseId);
  if (!doc) {
    p.emit({ type: "error", message: "Course not found or you don't have access." });
    p.emit({ type: "done" });
    return;
  }
  await runConversationLoop(loopContext(p), doc, structuredClone(doc), false, { layered: true, callLabel: "edit", historyPolicy: editHistoryPolicy() });
}

export interface AgentResumeParams {
  supabase: DB;
  model: ModelClient;
  courseId: string;
  lessonId: string;
  ownerId: string;
  conversationId: string;
  /** The paused destructive tool call + its placeholder message. */
  toolCallId: string;
  toolMessageId: string;
  kind: "module" | "lesson";
  label: string;
  /** The CoursePatch to apply iff confirmed (re-validated here). */
  patch: unknown;
  decision: "confirm" | "cancel";
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * Resume a turn the user paused at a destructive delete: apply (or skip) the
 * delete, finalize the placeholder tool output, then continue the model loop so
 * the agent can finish or acknowledge. RLS + the patch whitelist keep this safe
 * even though the patch round-trips through the client.
 */
export async function resumeAgentTurn(p: AgentResumeParams): Promise<void> {
  let doc = await loadCourseDoc(p.supabase, p.courseId);
  if (!doc) {
    p.emit({ type: "error", message: "Course not found or you don't have access." });
    p.emit({ type: "done" });
    return;
  }

  let applied = false;
  if (p.decision === "confirm") {
    const safe = CoursePatchSchema.safeParse(p.patch);
    // Whitelist: a confirmation may ONLY apply a module/lesson delete.
    if (safe.success && (safe.data.action === "DELETE_MODULE" || safe.data.action === "DELETE_LESSON")) {
      const res = applyCoursePatch(doc, safe.data, nowIso());
      if (res.ok) {
        doc = res.doc;
        applied = true;
      }
    }
  }

  const output = JSON.stringify(
    p.decision === "cancel"
      ? { status: "declined", message: `The creator declined to delete ${p.label}. Do not try again; continue with the rest of the task without it.` }
      : applied
        ? { status: "confirmed", message: `The creator confirmed. Deleted ${p.label}.` }
        : { status: "error", message: `Could not delete ${p.label} (it may already be gone).` }
  );
  await updateToolMessageOutput(p.supabase, p.toolMessageId, {
    callId: p.toolCallId,
    name: `delete_${p.kind}`,
    output,
  });

  // Resolve the paused tool card to its final state in the live transcript.
  p.emit({
    type: "tool_result",
    toolCallId: p.toolCallId,
    tool: `delete_${p.kind}`,
    ok: p.decision === "confirm" ? applied : true,
    summary:
      p.decision === "cancel"
        ? `Kept ${p.label}`
        : applied
          ? `Deleted ${p.label}`
          : `Couldn't delete ${p.label}`,
    lessonId: p.lessonId,
  });

  // Continue the agent. Baseline = the post-delete doc, so the deletion itself
  // isn't re-surfaced as a reviewable change — only any follow-up work is.
  await runConversationLoop(loopContext(p), doc, structuredClone(doc), applied, { layered: true, callLabel: "edit", historyPolicy: editHistoryPolicy() });
}
