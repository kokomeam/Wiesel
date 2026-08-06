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
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { CourseDocument } from "@/lib/course/types";
import {
  runConversationLoop,
  type LoopContext,
  type PhaseUsage,
} from "./agentLoop";
import type { ModelClient, ModelTurnParams, ReasoningEffort } from "./modelClient";
import { toStrictJsonSchema } from "./schema";
import { emitTutorModelCall } from "@/lib/tutor/telemetry";
import type { TutorJobType } from "@/lib/analytics/events";

/* ───────────────────────────── Semaphore ───────────────────────────────── */

/** An AbortError-shaped rejection: a DOMException-compatible `name` so callers can
 *  branch on `err.name === "AbortError"` uniformly (the fetch/AbortController idiom).
 *  We mint a plain Error rather than DOMException to stay isomorphic. */
function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** One queued waiter: its promise resolvers + the release fn it will inherit when a
 *  slot is HANDED to it (slot-transfer — the count never dips), plus its optional
 *  abort wiring so an aborted waiter can be removed from the queue without leaking. */
interface Waiter {
  /** Resolve the acquire() promise with the (inherited-slot) release fn. */
  wake: (release: () => void) => void;
  /** Reject the acquire() promise (abort). */
  fail: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A FIFO counting semaphore with EXPLICIT slot transfer + abortable waits.
 *
 * The KNOWN DEFECT this replaces: the old `acquire` had waiters resolve and THEN
 * re-increment `inFlightCount`, so between a release's `shift()` and the woken
 * waiter's increment a fresh `acquire` could observe `inFlightCount < max` and
 * BARGE — transient over-admission + queue-jumping. Fix: a release WITH waiters
 * HANDS its slot directly to the head waiter — `inFlightCount` never decrements,
 * so no window exists for a barger; a release with NO waiters decrements. Wake
 * order is strict FIFO (shift the head).
 */
export class Semaphore {
  private inFlightCount = 0;
  private waiters: Waiter[] = [];

  constructor(private readonly max: number) {}

  /** Slots currently held. */
  get inFlight(): number {
    return this.inFlightCount;
  }

  /** Waiters currently queued (not yet admitted). */
  get queued(): number {
    return this.waiters.length;
  }

  /** True iff the NEXT `acquire()` would have to QUEUE (all slots held). Lets a
   *  decorator compute a 1-based queue position atomically before it acquires,
   *  without exposing the private `max`. */
  get atCapacity(): boolean {
    return this.inFlightCount >= this.max;
  }

  /**
   * Acquire a slot, resolving to the single-use release fn. If a slot is free it's
   * taken synchronously; otherwise the caller queues FIFO until a holder hands one
   * over. An `AbortSignal` makes the WAIT cancellable: an already-aborted signal
   * rejects immediately (no queueing); aborting a queued waiter removes it and
   * rejects with an AbortError-shaped error, leaving its neighbours untouched.
   * Aborting a signal AFTER the slot was admitted does nothing (the holder still
   * owns the slot and must release normally).
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.inFlightCount < this.max) {
      this.inFlightCount += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        wake: (release) => {
          if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
          resolve(release);
        },
        fail: (err) => {
          if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
          reject(err);
        },
        signal,
      };
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1); // remove ONLY this waiter — neighbours keep their positions
          waiter.fail(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  /** Build a single-use release fn that either HANDS its slot to the head waiter
   *  (count unchanged — no dip, no barge window) or, with no waiters, decrements. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Slot transfer: the slot stays "in flight"; the woken waiter inherits it
        // with its OWN fresh release fn. inFlightCount is deliberately untouched.
        next.wake(this.makeRelease());
      } else {
        this.inFlightCount -= 1;
      }
    };
  }
}

/**
 * Per-principal concurrency pools (Amendment D-2 · Wave 3 §1). Pools are
 * PER-VERCEL-INSTANCE — a serverless instance's own in-memory cap, NOT a global
 * distributed limiter (the Amendment's recorded semantics; a fleet-wide cap would
 * need a shared store). Existing interactive creator surfaces stay UNPOOLED (out
 * of scope by design — only the tutor pipelines + learner turns route through here).
 */
export type PrincipalPool = "creator" | "learner";

/** The CREATOR pool — the SAME instance historically named `modelCallSemaphore`,
 *  so every existing `withSemaphore(client)` call site is behaviour-identical. Sized
 *  `AI_CREATOR_POOL_MAX ?? MAINTENANCE_MAX_CONCURRENT_MODEL_CALLS ?? 2` — the legacy
 *  env is kept as a fallback so existing deployments are unchanged. */
export const modelCallSemaphore = new Semaphore(
  Math.max(
    1,
    Number(process.env.AI_CREATOR_POOL_MAX) ||
      Number(process.env.MAINTENANCE_MAX_CONCURRENT_MODEL_CALLS) ||
      2
  )
);

/** The LEARNER pool — sized `AI_LEARNER_POOL_MAX ?? 8`. Interactive tutor turns run
 *  under this so a burst of learners can't starve creator (extraction/reconcile) work. */
export const learnerPool = new Semaphore(
  Math.max(1, Number(process.env.AI_LEARNER_POOL_MAX) || 8)
);

/** Resolve a principal pool to its Semaphore. `creator` IS `modelCallSemaphore`. */
export function poolFor(pool: PrincipalPool): Semaphore {
  return pool === "learner" ? learnerPool : modelCallSemaphore;
}

/* ─────────────────────── the pooled cost decorator ─────────────────────── */

/** The cost-emission binding for `withPooledModel`. When present, every gated model
 *  call (runTurn + embed) emits ONE `tutor_model_call` cost event. */
export interface PooledCostContext {
  supabase: SupabaseClient<Database>;
  courseId: string;
  /** The acting principal stamped as the row's user_id (extraction/reconcile pass the
   *  course author id). */
  emittedBy: string;
  jobType: TutorJobType | "practice_gen";
  /** The attribution learner (a tutor turn); null for author-run jobs. */
  learnerUserId?: string | null;
  /** When set, cost ids are `${runKey}:${seq}` (seq = a per-decorator monotonic
   *  counter) — DETERMINISTIC + retry-stable for the sequential Inngest pipelines, so
   *  an Inngest step retry re-emits as a no-op instead of double-counting. Unset (route
   *  turns, which run once) → `result.responseId ?? crypto.randomUUID()`. */
  runKey?: string;
}

export interface WithPooledModelOptions {
  /** The concurrency pool the gated calls hold. Defaults to `modelCallSemaphore`
   *  (the creator pool) so `withSemaphore` is a strict subset. */
  pool?: Semaphore;
  /** Called with the 1-based queue position when a call actually WAITS on the pool
   *  (used to emit the `queued` AgentEvent on the learner pool). */
  onQueued?: (position: number) => void;
  /** Cost-emission binding; omit to skip cost telemetry entirely. */
  cost?: PooledCostContext;
}

/**
 * THE single interception point (Wave 3 §1 · D-2): decorate a ModelClient so every
 * `runTurn` AND `embed` (embed was previously UNGATED — gating it is the one
 * deliberate behaviour change vs the old `withSemaphore`) holds the pool, reports a
 * queue position when it waits, and — when `cost` is present — emits ONE
 * `tutor_model_call` cost event with the call's usage + latency. The cost path NEVER
 * throws (telemetry must not break a turn). `generateImage`/`inspectImage` pass
 * through unchanged.
 *
 * This RETIRES the interim inline `emitTutorModelCall` calls in extraction.ts /
 * reconcile.ts: the pipelines keep ACCUMULATING usage but the decorator is the ONLY
 * production emitter.
 */
export function withPooledModel(
  base: ModelClient,
  opts: WithPooledModelOptions = {}
): ModelClient {
  const pool = opts.pool ?? modelCallSemaphore;
  const cost = opts.cost;
  // Per-decorator-instance monotonic counter → deterministic `${runKey}:${seq}` ids.
  let seq = 0;

  /** Acquire the pool, reporting a 1-based queue position iff this call actually
   *  QUEUES. Position = the waiters already ahead + this one, read atomically BEFORE
   *  the acquire (no other task runs between these synchronous statements). */
  async function acquireGated(signal?: AbortSignal): Promise<() => void> {
    if (pool.atCapacity) {
      opts.onQueued?.(pool.queued + 1);
    }
    return pool.acquire(signal);
  }

  /** Emit one cost event (never throws). `providerResponseId` is deterministic under a
   *  runKey, else the provider id / a fresh uuid. */
  async function emitCost(
    usage: { inputTokens: number; cachedTokens: number; outputTokens: number },
    latencyMs: number,
    providerResponseId: string,
    jobTypeOverride?: TutorJobType
  ): Promise<void> {
    if (!cost) return;
    const jobType = jobTypeOverride ?? cost.jobType;
    // Wave 6.6: `lesson_rationale` + `escalation_dossier` are now DB-checked job
    // types (migration 20260806160000 widened learning_events.job_type), so their
    // runTurn cost rows EMIT — closing the two deferred cost-tracking deviations.
    // `practice_gen` stays skipped: it is a SEPARATE luna precedent, never a DB
    // job_type, so a row under it would still fail the ingest CHECK. (Embeds always
    // emit under 'embedding' regardless of the run's jobType.)
    if (jobType === "practice_gen") return;
    try {
      await emitTutorModelCall(cost.supabase, {
        courseId: cost.courseId,
        learnerUserId: cost.learnerUserId ?? null,
        jobType,
        model: base.model,
        usage,
        latencyMs,
        providerResponseId,
        emittedBy: cost.emittedBy,
      });
    } catch {
      // Belt-and-braces: emitTutorModelCall already swallows, but never let cost
      // telemetry surface into the model path.
    }
  }

  function costId(providerResponseId: string | null | undefined): string {
    if (cost?.runKey) return `${cost.runKey}:${seq++}`;
    return providerResponseId ?? crypto.randomUUID();
  }

  return {
    model: base.model,
    async runTurn(params, onEvent) {
      const release = await acquireGated(params.signal);
      const t0 = Date.now();
      try {
        const result = await base.runTurn(params, onEvent);
        await emitCost(
          {
            inputTokens: result.usage?.inputTokens ?? 0,
            cachedTokens: result.usage?.cachedTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
          },
          Date.now() - t0,
          costId(result.responseId),
          // runTurn under a graph/reconcile/tutor cost context uses that jobType.
          undefined
        );
        return result;
      } finally {
        release();
      }
    },
    embed: base.embed
      ? async (params) => {
          const release = await acquireGated(params.signal);
          const t0 = Date.now();
          try {
            const result = await base.embed!(params);
            await emitCost(
              { inputTokens: result.usage.inputTokens, cachedTokens: 0, outputTokens: 0 },
              Date.now() - t0,
              costId(null),
              // Embeds ALWAYS emit under 'embedding' regardless of the run's jobType.
              "embedding"
            );
            return result;
          } finally {
            release();
          }
        }
      : undefined,
    generateImage: base.generateImage?.bind(base),
    inspectImage: base.inspectImage?.bind(base),
  };
}

/**
 * Backwards-compatible alias: `withSemaphore(base, sem)` is now `withPooledModel(base,
 * { pool: sem })`. Its behaviour is a strict SUBSET of the pooled decorator — with the
 * ONE deliberate change that `embed` is now POOLED too (it was previously ungated).
 */
export function withSemaphore(
  base: ModelClient,
  semaphore: Semaphore = modelCallSemaphore
): ModelClient {
  return withPooledModel(base, { pool: semaphore });
}

/* ─────────────────────── One-shot structured call ──────────────────────── */

export interface StructuredCallResult<T> {
  ok: boolean;
  data: T | null;
  usage: PhaseUsage;
  /** The provider's response id for the LAST attempt (null when the provider
   *  returned none). Tutor jobs use it as the cost-telemetry idempotency key
   *  (lib/tutor/telemetry.ts emitTutorModelCall). */
  responseId?: string | null;
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
    /** Per-call model/effort/deadline/retries (a tutor job passes its TUTOR_MODELS
     *  config). Each falls back to the provider's env default when omitted. */
    model?: string;
    effort?: ReasoningEffort;
    timeoutMs?: number;
    maxRetries?: number;
  }
): Promise<StructuredCallResult<T>> {
  const usage: PhaseUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  let lastResponseId: string | null = null;
  const params: ModelTurnParams = {
    system: args.system,
    input: [{ role: "user", content: args.input }],
    tools: [],
    stream: false,
    signal: args.signal,
    maxOutputTokens: args.maxOutputTokens ?? 8000,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
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
    lastResponseId = result.responseId ?? null;
    if (result.finishReason === "error") {
      return { ok: false, data: null, usage, responseId: lastResponseId, error: result.errorKind ?? "model error" };
    }
    try {
      const parsed = args.outputSchema.safeParse(JSON.parse(result.text || "{}"));
      if (parsed.success) return { ok: true, data: parsed.data, usage, responseId: lastResponseId };
    } catch {
      // fall through to the re-ask
    }
  }
  return { ok: false, data: null, usage, responseId: lastResponseId, error: "schema_parse_failed" };
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
