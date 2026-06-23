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
import { debugAgent } from "./debugLog";
import { AGENT_NO_PROGRESS_LIMIT } from "./modelConfig";
import { buildBoundedAgentInput, buildScopedAgentInput, defaultHistoryPolicy, editHistoryPolicy, type HistoryPolicy } from "./historyPolicy";
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
import { AUTHORING_TOOL_NAMES, GENERATE_TOOL_NAMES, executeTool, getToolDefinitions, type ToolContext, type VisualGenContext } from "./tools";
import { AI_VISUALS } from "./visuals/config";
import { storeGeneratedImage } from "./visuals/storeImage";

type DB = SupabaseClient<Database>;
// Per-turn step cap (one model call + its tool batch = one step). Env-overridable;
// a dense single lesson can need more than the old 12 before it's done.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS) || 16;
// A whole agent run (PLAN + every lesson's GENERATE/CRITIQUE) shares ONE call
// budget — the runaway ceiling, mainly for module builds (N lessons × MAX_TURNS).
// The per-lesson coverage driver + no-progress guard now prevent per-lesson
// runaway, so this can be generous enough that an 8-lesson module doesn't starve
// its later lessons. Env: AGENT_MAX_TOTAL_CALLS.
const MAX_TOTAL_CALLS = Number(process.env.AGENT_MAX_TOTAL_CALLS) || 200;
// How many times a single plan slide spec may come back from the batch tool as
// "couldn't build (missing content)" before the coverage driver ABANDONS it (stops
// re-sending it and surfaces it in the checkpoint) — so one unbuildable slide can't
// spin the loop to its turn cap. Env: AGENT_MAX_SPEC_BUILD_ATTEMPTS.
const MAX_SPEC_BUILD_ATTEMPTS = Number(process.env.AGENT_MAX_SPEC_BUILD_ATTEMPTS) || 2;

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
  // No usage object ⇒ the provider never returned usage (almost always a TRANSPORT
  // failure: the request died before the model ran). Logging `inputTokens: 0` then
  // FALSELY reads as "no prompt was sent". Emit `usageAvailable: false` instead so
  // a timeout is never mistaken for an empty/zero-token request.
  if (!usage) {
    console.log(JSON.stringify({ tag: "agent_call", label, turn, model, usageAvailable: false }));
    return;
  }
  console.log(
    JSON.stringify({
      tag: "agent_call",
      label,
      turn,
      model,
      usageAvailable: true,
      inputTokens: usage.inputTokens ?? 0,
      cachedTokens: usage.cachedTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
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
  /** The pre-created empty slide deck to author into (named in the context so the
   *  model never creates a second deck / a placeholder starter). */
  deckBlockId?: string;
  /** An extra, run-specific instruction appended to the context message — the
   *  targeted REPAIR pass uses it to list exactly the hard failures to fix. */
  extraInstruction?: string;
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
  /** Per-call max output tokens (authoring turns get more headroom than the
   *  provider default so high-effort reasoning doesn't starve slide content). */
  maxOutputTokens?: number;
  /** GENERATE/REPAIR: drive the loop to PLAN COVERAGE instead of stopping the
   *  instant the model returns no tool calls. When specs remain the loop nudges
   *  the model to keep building (up to maxTurns), and a no-progress guard stops a
   *  stalled run. Requires `outline`. Off (legacy stop-when-model-stops) otherwise. */
  driveToCoverage?: boolean;
  /** GENERATE/REPAIR: build the model input FROM SCRATCH each turn out of the
   *  system + the full plan (in the context message) + the generation-state
   *  summary + THIS run's tool I/O — and DON'T load the conversation transcript at
   *  all. The plan can never be diluted/buried by cross-lesson history, and there's
   *  nothing to compact. Requires `outline` (else there's no plan to scope to). */
  scopedInput?: boolean;
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
  /** The loop stopped on a budget / per-turn cap (emitted a checkpoint) rather
   *  than because the model was done — so an unmet plan is "ran out of room". */
  checkpointed: boolean;
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

/** Plan-coverage snapshot for the coverage driver — derived from the SAME
 *  deterministic generation-state the bounded input already builds (no model). */
interface CoverageProgress {
  covered: number;
  remaining: string[];
  missingBlocks: string[];
}

function coverageProgress(doc: CourseDocument, lessonId: string, outline: LessonOutline): CoverageProgress {
  const p = buildGenerationState(doc, lessonId, { phase: "drive", outline }).planProgress;
  return {
    covered: p?.slideSpecsCompleted.length ?? 0,
    remaining: p?.slideSpecsRemaining ?? [],
    missingBlocks: p?.requiredBlocksMissing ?? [],
  };
}

/** The concrete "keep going" message injected when the model stops early but the
 *  plan isn't fully built — it names the exact specs + blocks still owed so the
 *  model resumes building instead of ending the turn. */
function buildContinuationNudge(prog: CoverageProgress, outline: LessonOutline, deckBlockId?: string): string {
  const byId = new Map(outline.slides.map((s) => [s.id, s]));
  const lines = [
    "You stopped, but the approved plan is NOT fully built yet. Keep going — do NOT summarize, explain, or end the turn until every planned slide exists.",
  ];
  if (prog.remaining.length) {
    lines.push(
      `STILL TO BUILD (${prog.remaining.length} slide spec(s)): author the next 1–3 NOW with add_structured_slides_batch into deck ${deckBlockId ?? "(this lesson's deck)"}, stamping each slideSpecId:`
    );
    for (const id of prog.remaining.slice(0, 4)) {
      const s = byId.get(id);
      if (s) lines.push(`  - [${id} · ${s.role} · layout=${s.layout}] ${s.title} — ${s.teachingGoal}.`);
    }
    if (prog.remaining.length > 4) lines.push(`  …and ${prog.remaining.length - 4} more after those.`);
  }
  if (prog.missingBlocks.includes("quiz") && outline.quizPlan) {
    lines.push(`Also still owed: the knowledge check — create it with write_quiz (${outline.quizPlan.questionCount} question(s)).`);
  }
  if (prog.missingBlocks.includes("homework") && outline.homeworkPlan) {
    lines.push("Also still owed: the practice — create it with write_homework.");
  }
  return lines.join("\n");
}

/**
 * A calm, one-line version of a tool failure for the CHAT transcript. The model
 * still receives the full detail (so it can self-correct), but the user never
 * sees a raw Zod validation dump — these guards are an internal safety net, not
 * a message addressed to them.
 */
function friendlyToolError(toolName: string, detail: string): string {
  const noun = TOOL_VERB[toolName]; // e.g. "diagram", "slide" — undefined for generic tools
  if (/invalid (json )?arguments|invalid input|expected /i.test(detail)) {
    return noun ? `Had to adjust the ${noun} and retry.` : "Had to adjust that and retry.";
  }
  if (/not found|no access|don'?t have/i.test(detail)) {
    return noun ? `Couldn't find what that ${noun} pointed at — retrying.` : "Couldn't find what that pointed at — retrying.";
  }
  return noun ? `Couldn't update the ${noun} on that pass — retrying.` : "Couldn't make that change on that pass — retrying.";
}

/** Short NOUN phrases for the friendly error line (the thing the tool acts on). */
const TOOL_VERB: Record<string, string> = {
  set_structured_slide: "slide",
  add_structured_slide: "slide",
  add_structured_slides_batch: "slides",
  set_slide_layout: "slide layout",
  update_slide: "slide",
  add_slide: "slide",
  add_diagram: "diagram",
  set_diagram: "diagram",
  add_image: "image",
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
  /** Image-generation capability (built by `loopContext` when configured) — passed
   *  into each tool's ctx so `add_image` can generate + store an illustration. */
  visuals?: VisualGenContext;
}

/** Persist the doc to the DB (full-snapshot reconcile). IDEMPOTENT + repeatable —
 *  the phased pipeline calls it incrementally (after each lesson / phase) so the
 *  DB reflects progress even if a later phase dies or the run is aborted (the
 *  "Module 5 has no data" fix). Never aborts on `c.signal`: a flush MUST complete
 *  even when the run was just cancelled. */
export async function reconcileDoc(c: LoopContext, doc: CourseDocument): Promise<void> {
  const err = await reconcileCourseDoc(c.supabase, doc, c.ownerId);
  if (err && !c.signal?.aborted) c.emit({ type: "error", message: `Some changes may not have saved: ${err}` });
}

/** Stage the net block diff (vs `baselineDoc`) as ONE reviewable change-set.
 *  Returns true if a change-set was created. The change_sets.lesson_id FK requires
 *  an existing row, so the docked lessonId is coalesced to a changed block's lesson
 *  (always persisted) or NULL. Does NOT reconcile — call `reconcileDoc` first. */
export async function stageChangeSet(
  c: LoopContext,
  doc: CourseDocument,
  baselineDoc: CourseDocument,
  lastAssistantMessageId: string | null
): Promise<boolean> {
  const changes = diffBlocks(baselineDoc, doc);
  if (changes.length === 0) return false;
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
  return !!cs;
}

/** Reconcile the doc to the DB and stage the net diff as one change-set. Shared by
 *  the single-turn loop (which finalizes here). The phased pipeline uses the split
 *  `reconcileDoc` + `stageChangeSet` for incremental persistence + flush-on-exit. */
export async function reconcileAndStage(
  c: LoopContext,
  doc: CourseDocument,
  baselineDoc: CourseDocument,
  lastAssistantMessageId: string | null
): Promise<void> {
  await reconcileDoc(c, doc);
  await stageChangeSet(c, doc, baselineDoc, lastAssistantMessageId);
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
    : buildContextMessage(doc, c.lessonId, {
        outline: options.outline,
        deckBlockId: options.deckBlockId,
        extraInstruction: options.extraInstruction,
      });
  const allowed = options.generateTools
    ? GENERATE_TOOL_NAMES
    : options.authoringOnly
      ? AUTHORING_TOOL_NAMES
      : null;
  const tools = allowed ? getToolDefinitions().filter((t) => allowed.has(t.name)) : getToolDefinitions();
  // SCOPED (GENERATE/REPAIR): never load the conversation transcript — the plan +
  // generation-state are the entire working context, so the (possibly 800+-message)
  // history can't dilute the plan, and the load is skipped outright.
  const scoped = !!options.scopedInput && !!options.outline;
  const history = scoped ? [] : await loadHistory(c.supabase, c.conversationId);
  const policy = options.historyPolicy ?? defaultHistoryPolicy();
  const maxTurns = options.maxTurns ?? MAX_TURNS;
  // The plan's ordered spec ids — threaded into the tool ctx so batch authoring can
  // DETERMINISTICALLY stamp each slide with its spec id (guaranteeing coverage even
  // if the model omits/mis-types slideSpecId). Empty when there's no plan.
  const planSpecIds = options.outline?.slides.map((s) => s.id) ?? [];
  // DIAGNOSTIC: spec id → its plan keyPoint count (so a slide-reject log can tell
  // an author-ignored-a-real-brief from an empty/absent brief).
  const planSpecPoints: Record<string, number> = {};
  for (const s of options.outline?.slides ?? []) planSpecPoints[s.id] = s.keyPoints.length;
  // Generous cap on the scoped generation-state summary (the plan rides in the
  // context message; this carries the built/remaining list).
  const scopedStateMaxChars = policy.mode === "bounded" ? policy.maxStateSummaryChars : 12000;

  // This run's turn-by-turn accumulation (one group per model turn = its
  // assistant text + function_call + function_call_output items). The model input
  // is REBUILT from this each turn (bounded) instead of one ever-growing array.
  const eventGroups: ModelInputItem[][] = [];
  const recentChanges: RecentChange[] = [];

  let fullAssistantText = "";
  let lastAssistantMessageId: string | null = null;
  let docMutated = initialMutated;
  let paused = false;
  let checkpointed = false;
  const usage: PhaseUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  let toolCallCount = 0;
  let turnsRun = 0;

  // Coverage driver state (GENERATE/REPAIR). `prevCovered` seeds from the doc the
  // loop STARTS with, so a repair pass measures NET new coverage, not absolute.
  const driveOutline = options.driveToCoverage ? options.outline : undefined;
  let prevCovered = driveOutline ? coverageProgress(doc, c.lessonId, driveOutline).covered : 0;
  let noProgressTurns = 0;
  // Per-spec unbuildable-attempt tally + the abandoned set (FIX 2 attempt cap).
  const specBuildFailures = new Map<string, number>();
  const abandonedSpecs = new Set<string>();
  // A driven GENERATE/REPAIR loop runs INSIDE the validate/repair pipeline, which
  // owns the ONE authoritative end-of-run checkpoint — so the loop only RECORDS
  // that it stopped short (sets `checkpointed`) without emitting a duplicate. The
  // standalone edit/critique path (no driver) still emits its own checkpoint.
  const stopShort = (reason: string, completedSteps: number) => {
    if (!driveOutline) c.emit({ type: "checkpoint", reason, completedSteps });
    checkpointed = true;
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (c.signal?.aborted) break;

    // Build this turn's model input. Scoped (GENERATE/REPAIR) = system + the full
    // plan (context message) + generation-state + THIS run's tool I/O, no history.
    // Bounded = stable context + a compact generation-state summary + the last K
    // tool groups. Full = the legacy whole-transcript replay.
    let input: ModelInputItem[];
    if (scoped) {
      const stateSummary = serializeGenerationState(
        buildGenerationState(doc, c.lessonId, {
          phase: options.callLabel ?? "loop",
          outline: options.outline,
          recentChanges: recentChanges.slice(-6),
        }),
        scopedStateMaxChars
      );
      const built = buildScopedAgentInput({
        contextMessage,
        generationStateSummary: stateSummary,
        eventGroups,
        maxToolResultChars: policy.mode === "bounded" ? policy.maxToolResultChars : 4000,
      });
      input = built.input;
      console.log(JSON.stringify({ tag: "agent_input_scoped", phase: options.callLabel ?? "loop", turn, ...built.stats }));
    } else if (policy.mode === "bounded") {
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
      stopShort("Reached the overall step budget for this request. Ask me to continue if there's more to do.", turn);
      break;
    }
    if (c.callBudget) c.callBudget.remaining -= 1;

    const result = await c.model.runTurn({ system, input, tools, signal: c.signal, effort: options.effort, model: options.model, maxOutputTokens: options.maxOutputTokens }, (ev) => {
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
    // DIAGNOSTIC: per-authoring-turn finish_reason + tool-call arg sizes. A
    // finishReason of "incomplete" (or a tool-call args length near the output cap)
    // means the model hit max_output_tokens MID-JSON — the truncation signature that
    // can read downstream as a parse failure or a half-built slide.
    debugAgent("authoring_turn", {
      phase: options.callLabel ?? "loop",
      turn,
      finishReason: result.finishReason,
      outputTokens: result.usage?.outputTokens ?? null,
      maxOutputTokens: options.maxOutputTokens ?? null,
      textLen: result.text.length,
      toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, argsLen: tc.arguments.length })),
    });
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
    const noToolCalls = result.toolCalls.length === 0;
    // Legacy paths (edit/critique/delete) stop the instant the model stops. The
    // coverage driver instead checks the plan after the group settles (below).
    if (noToolCalls && !driveOutline) break;

    const docBeforeTools = doc;
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
        const ctx: ToolContext = { doc, courseId: c.courseId, lessonId: c.lessonId, visuals: c.visuals, planSpecIds, planSpecPoints };
        const outcome = await executeTool(call.name, call.arguments, ctx);
        summary = outcome.summary;

        // FIX 2 — per-spec attempt cap: the batch tool reports slides it genuinely
        // couldn't build (missing content). Count those per spec; after
        // MAX_SPEC_BUILD_ATTEMPTS, ABANDON the spec so the coverage driver stops
        // re-sending it to the turn cap (it's surfaced in the checkpoint instead).
        if (outcome.data && typeof outcome.data === "object") {
          const failed = (outcome.data as { failed?: { slideSpecId?: string }[] }).failed;
          if (Array.isArray(failed)) {
            for (const f of failed) {
              const sid = f?.slideSpecId;
              if (typeof sid === "string" && sid.trim()) {
                const n = (specBuildFailures.get(sid) ?? 0) + 1;
                specBuildFailures.set(sid, n);
                if (n >= MAX_SPEC_BUILD_ATTEMPTS) abandonedSpecs.add(sid);
              }
            }
          }
        }

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

    // LIVE PERSISTENCE (driven GENERATE/REPAIR only): reconcile this turn's new
    // slides to the DB the moment the batch lands — so the editor can render them
    // live AND a hard stop / crash never loses more than the current turn's work
    // (flush-on-exit then only has to stage what's already persisted). Edit/critique
    // persist once at the end (deferFinalize), so they're byte-identical to before.
    if (driveOutline && doc !== docBeforeTools) {
      await reconcileDoc(c, doc);
    }

    // COVERAGE DRIVER (GENERATE/REPAIR): keep building until the plan is met,
    // instead of stopping the instant the model emits a no-tool-call turn. A
    // no-progress guard stops a stalled run (e.g. repeated schema failures) so it
    // can't burn the budget spinning.
    if (driveOutline) {
      const prog = coverageProgress(doc, c.lessonId, driveOutline);
      // Specs abandoned after MAX_SPEC_BUILD_ATTEMPTS don't count toward "still
      // owed" — the driver stops chasing them (they're surfaced in the checkpoint).
      const effectiveRemaining = prog.remaining.filter((id) => !abandonedSpecs.has(id));
      if (prog.covered > prevCovered) {
        prevCovered = prog.covered;
        noProgressTurns = 0;
      } else {
        noProgressTurns += 1;
      }
      const planMet = effectiveRemaining.length === 0 && prog.missingBlocks.length === 0;
      if (planMet) {
        // If everything still-buildable is built but some specs were abandoned as
        // unbuildable, stop SHORT (checkpoint) — never present an unmet plan as done.
        if (abandonedSpecs.size > 0) {
          stopShort(`Couldn't build ${abandonedSpecs.size} planned slide(s) after ${MAX_SPEC_BUILD_ATTEMPTS} attempts (${[...abandonedSpecs].join(", ")}). Ask me to continue and I'll try them again.`, prog.covered);
        }
        break; // contract satisfied (or all remaining abandoned) — done
      }

      if (noProgressTurns >= AGENT_NO_PROGRESS_LIMIT) {
        stopShort("Generation stalled before the plan was complete (no new slides over several steps). Ask me to continue and I'll finish what's left.", prog.covered);
        break;
      }
      // The model stopped early but BUILDABLE specs remain — inject a concrete nudge
      // so the NEXT turn resumes building exactly what's still owed (minus abandoned).
      if (noToolCalls) {
        eventGroups.push([{ role: "user", content: buildContinuationNudge({ ...prog, remaining: effectiveRemaining }, driveOutline, options.deckBlockId) }]);
      }
    }

    if (turn === maxTurns - 1) {
      stopShort("Reached the per-turn step limit. Ask me to continue if there's more to do.", turn + 1);
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

  return { doc, docMutated, lastAssistantMessageId, assistantText: fullAssistantText, usage, toolCalls: toolCallCount, turns: turnsRun, paused, checkpointed };
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

/** Build the illustration capability for `add_image` — present only when image
 *  generation is enabled AND the model client can produce images. It wraps the
 *  model's `generateImage` (gpt-image-1, through the same proxy) and stores the
 *  bytes to Supabase, returning a public URL. The educational-style + no-text
 *  suffix steers the model away from garbled embedded labels. */
function makeVisualGenContext(p: LoopContextSource): VisualGenContext | undefined {
  if (!AI_VISUALS.enabled || !AI_VISUALS.imageGeneration) return undefined;
  const generate = p.model.generateImage?.bind(p.model);
  if (!generate) return undefined;
  return {
    maxPerLesson: AI_VISUALS.maxPerLesson,
    async generateIllustration({ prompt }) {
      const styled =
        `${prompt}\n\nStyle: clean, modern flat educational illustration; a single clear subject; soft neutral palette; ` +
        `no embedded text, words, letters, numbers, labels, captions, logos, or watermark.`;
      const img = await generate({ prompt: styled, aspectRatio: "4:3", signal: p.signal });
      if (!img) return null;
      return storeGeneratedImage(p.supabase, { ownerId: p.ownerId, courseId: p.courseId, image: img });
    },
  };
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
    visuals: makeVisualGenContext(p),
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
