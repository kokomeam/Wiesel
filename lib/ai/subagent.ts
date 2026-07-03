/**
 * The subagent primitive (Milestone 5).
 *
 * `runSubagent` runs one narrow role — Analyst / Remediation / Comms — over the
 * EXISTING agent loop with an arbitrary tool allow-set and NO conversation
 * persistence, then returns a Zod-validated structured result (strict JSON
 * schema via the Responses API). Roles without tools skip the loop and go
 * straight to the one-shot structured call.
 *
 * Concurrency: `withSemaphore(model)` decorates the ModelClient so EVERY model
 * call downstream — loop turns and one-shots, across all concurrently-running
 * subagents — shares one global semaphore capped at
 * MAINTENANCE_MAX_CONCURRENT_MODEL_CALLS (default 2).
 *
 * Budgets: the orchestrator seeds ONE CallBudget (shared by reference — the
 * loop already decrements it) plus a token budget this module decrements.
 * Graceful truncation: when a loop exhausts its room mid-flight, the last call
 * is spent on the structured verdict over whatever was gathered
 * (`{ok:true, truncated:true}`); with nothing left, `{ok:false, truncated:true}`.
 */

import type { z } from "zod";
import type { CourseDocument } from "@/lib/course/types";
import {
  runConversationLoop,
  type LoopContext,
  type PhaseUsage,
} from "./agentLoop";
import type { ModelClient, ModelTurnParams } from "./modelClient";
import { toStrictJsonSchema } from "./schema";

/* ───────────────────────────── Semaphore ───────────────────────────────── */

export class Semaphore {
  private inFlightCount = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.inFlightCount;
  }

  async acquire(): Promise<() => void> {
    if (this.inFlightCount < this.max) {
      this.inFlightCount += 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.inFlightCount += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightCount -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

/** The GLOBAL model-call cap for maintenance runs (spec: 2). */
export const modelCallSemaphore = new Semaphore(
  Math.max(1, Number(process.env.MAINTENANCE_MAX_CONCURRENT_MODEL_CALLS) || 2)
);

/** Decorate a ModelClient so every runTurn holds the semaphore — loop-based AND
 *  one-shot subagent calls are uniformly capped, and a mock's recording still
 *  sees every call (the decorator delegates). */
export function withSemaphore(
  base: ModelClient,
  semaphore: Semaphore = modelCallSemaphore
): ModelClient {
  return {
    model: base.model,
    async runTurn(params, onEvent) {
      const release = await semaphore.acquire();
      try {
        return await base.runTurn(params, onEvent);
      } finally {
        release();
      }
    },
    generateImage: base.generateImage?.bind(base),
    inspectImage: base.inspectImage?.bind(base),
  };
}

/* ─────────────────────── One-shot structured call ──────────────────────── */

export interface StructuredCallResult<T> {
  ok: boolean;
  data: T | null;
  usage: PhaseUsage;
  error?: string;
}

function addUsage(total: PhaseUsage, turn: PhaseUsage | undefined): void {
  if (!turn) return;
  total.inputTokens += turn.inputTokens ?? 0;
  total.outputTokens += turn.outputTokens ?? 0;
  total.reasoningTokens += turn.reasoningTokens ?? 0;
  total.cachedTokens += turn.cachedTokens ?? 0;
}

/**
 * ONE structured (json_schema) call with a single re-ask on parse failure —
 * the intent.ts pattern, kept local (runStructuredPlan is welded to the plan
 * phases). No tools, no streaming, nothing persisted.
 */
export async function runStructuredCall<T>(
  model: ModelClient,
  args: {
    system: string;
    input: string;
    outputName: string;
    outputSchema: z.ZodType<T>;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }
): Promise<StructuredCallResult<T>> {
  const usage: PhaseUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  const params: ModelTurnParams = {
    system: args.system,
    input: [{ role: "user", content: args.input }],
    tools: [],
    stream: false,
    signal: args.signal,
    maxOutputTokens: args.maxOutputTokens ?? 8000,
    responseFormat: { name: args.outputName, schema: toStrictJsonSchema(args.outputSchema) },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await model.runTurn(
      attempt === 0
        ? params
        : {
            ...params,
            input: [
              ...params.input,
              {
                role: "user",
                content:
                  "The previous response was not valid JSON for the required schema. Respond again with ONLY the JSON object.",
              },
            ],
          },
      () => {}
    );
    addUsage(usage, result.usage as PhaseUsage | undefined);
    if (result.finishReason === "error") {
      return { ok: false, data: null, usage, error: result.errorKind ?? "model error" };
    }
    try {
      const parsed = args.outputSchema.safeParse(JSON.parse(result.text || "{}"));
      if (parsed.success) return { ok: true, data: parsed.data, usage };
    } catch {
      // fall through to the re-ask
    }
  }
  return { ok: false, data: null, usage, error: "schema_parse_failed" };
}

/* ────────────────────────────── runSubagent ────────────────────────────── */

export interface TokenBudget {
  remaining: number;
}

export interface RunSubagentParams<T> {
  /** The orchestrator's LoopContext — model already semaphore-wrapped, ONE
   *  shared CallBudget, persist-free emit passthrough. */
  c: LoopContext;
  role: "analyst" | "remediation" | "comms";
  systemPrompt: string;
  /** Developer context: the finding + evidence + lesson view, the analytics
   *  scope note, etc. Rides as extraInstruction (loop) / input prefix (one-shot). */
  context: string;
  userMessage: string;
  outputSchema: z.ZodType<T>;
  /** responseFormat.name — also keys the mock's opts.structured map. */
  outputName: string;
  /** Set → run the agent loop first (allowedToolNames, persist:false), then the
   *  structured verdict over its final analysis. Undefined → pure one-shot. */
  tools?: ReadonlySet<string>;
  /** Required when `tools` is set. */
  doc?: CourseDocument;
  /** Override the docked lesson for the loop (Remediation targets per finding). */
  lessonId?: string;
  maxTurns?: number;
  tokenBudget: TokenBudget;
}

export interface SubagentResult<T> {
  ok: boolean;
  data: T | null;
  truncated: boolean;
  usage: PhaseUsage;
  toolCalls: number;
  /** For agent_runs.report — the replayable trace of what this subagent did. */
  transcript: { tool: string; summary: string }[];
  /** The (possibly mutated) doc after a loop-based subagent; the input doc
   *  otherwise. */
  doc: CourseDocument | null;
  docMutated: boolean;
  error?: string;
}

function budgetExhausted(c: LoopContext, tokens: TokenBudget): boolean {
  return (c.callBudget !== undefined && c.callBudget.remaining <= 0) || tokens.remaining <= 0;
}

export async function runSubagent<T>(p: RunSubagentParams<T>): Promise<SubagentResult<T>> {
  const usage: PhaseUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  const transcript: { tool: string; summary: string }[] = [];
  let doc: CourseDocument | null = p.doc ?? null;
  let docMutated = false;
  let toolCalls = 0;
  let loopAnalysis = "";
  let truncated = false;

  if (budgetExhausted(p.c, p.tokenBudget)) {
    return { ok: false, data: null, truncated: true, usage, toolCalls, transcript, doc, docMutated, error: "budget_exhausted" };
  }

  // ── Optional tool loop (Analyst navigation / Remediation edits). ──
  if (p.tools) {
    if (!doc) throw new Error(`runSubagent(${p.role}): tools require a doc`);
    const c2: LoopContext = {
      ...p.c,
      lessonId: p.lessonId ?? p.c.lessonId,
      emit: (event) => {
        if (event.type === "tool_result") {
          transcript.push({ tool: event.tool, summary: event.summary });
        }
        p.c.emit(event);
      },
    };
    const loop = await runConversationLoop(c2, doc, structuredClone(doc), false, {
      systemOverride: `${p.systemPrompt}\n\n${p.context}`,
      allowedToolNames: p.tools,
      persist: false,
      deferFinalize: true,
      maxTurns: p.maxTurns ?? 6,
      callLabel: `maintenance:${p.role}`,
    });
    addUsage(usage, loop.usage);
    p.tokenBudget.remaining -= loop.usage.inputTokens + loop.usage.outputTokens;
    doc = loop.doc;
    docMutated = loop.docMutated;
    toolCalls = loop.toolCalls;
    loopAnalysis = loop.assistantText;
    truncated = loop.checkpointed;
  }

  // ── The structured verdict. Spend the LAST call on it if any room remains —
  //    a partial result beats none (graceful truncation). ──
  if (p.c.callBudget && p.c.callBudget.remaining <= 0) {
    return { ok: false, data: null, truncated: true, usage, toolCalls, transcript, doc, docMutated, error: "budget_exhausted" };
  }
  if (p.c.callBudget) p.c.callBudget.remaining -= 1;

  const verdictInput = [
    p.context,
    loopAnalysis ? `ANALYSIS FROM THE TOOL SESSION:\n${loopAnalysis}` : "",
    transcript.length
      ? `TOOL TRACE:\n${transcript.map((t) => `- ${t.tool}: ${t.summary}`).join("\n")}`
      : "",
    p.userMessage,
  ]
    .filter(Boolean)
    .join("\n\n");

  const verdict = await runStructuredCall(p.c.model, {
    system: p.systemPrompt,
    input: verdictInput,
    outputName: p.outputName,
    outputSchema: p.outputSchema,
    signal: p.c.signal,
  });
  addUsage(usage, verdict.usage);
  p.tokenBudget.remaining -= verdict.usage.inputTokens + verdict.usage.outputTokens;
  if (p.tokenBudget.remaining <= 0) truncated = true;

  return {
    ok: verdict.ok,
    data: verdict.data,
    truncated,
    usage,
    toolCalls,
    transcript,
    doc,
    docMutated,
    error: verdict.error,
  };
}
