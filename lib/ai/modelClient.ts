/**
 * Provider-agnostic model client — THE seam between the agent and any LLM
 * provider. The agent loop, tools, streaming, and change-tracking are written
 * ENTIRELY against these types; a provider SDK (OpenAI) is imported in exactly
 * one place (providers/openai.ts). Swapping providers means writing one new
 * `ModelClient` — nothing else changes.
 *
 * The shapes mirror the subset of the OpenAI Responses API we depend on
 * (function-call items + function-call-output items), but contain nothing
 * provider-specific, so they map just as cleanly onto other tool-calling APIs.
 */

export type JsonSchema = Record<string, unknown>;

/** A tool the model may call. `parameters` is an OpenAI-strict-compatible JSON
 *  Schema generated from a Zod definition (see ./schema.ts). */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * One conversation item replayed to the model each turn. We manage history in
 * our own DB and replay it every turn, so we never depend on provider-side
 * session state (keeps the DB authoritative and the design provider-agnostic).
 */
export type ModelInputItem =
  | { role: "user" | "assistant" | "developer"; content: string }
  | { type: "function_call"; callId: string; name: string; arguments: string }
  | { type: "function_call_output"; callId: string; output: string };

/** A function call the model wants executed. `arguments` is a raw JSON string
 *  (parsed + Zod-validated by the tool before anything mutates). */
export interface ModelToolCall {
  callId: string;
  name: string;
  arguments: string;
}

/** Normalized streaming events emitted by a provider during one turn. */
export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ModelToolCall }
  | { type: "error"; message: string };

export type FinishReason = "stop" | "tool_calls" | "incomplete" | "error";

/** Reasoning effort, settable PER CALL (each phase passes its own; the provider
 *  falls back to the env default when omitted). */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Aggregated result of one model turn (what the loop inspects to decide
 *  whether to run tools and continue). */
export interface ModelTurnResult {
  text: string;
  toolCalls: ModelToolCall[];
  finishReason: FinishReason;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    /** Reasoning tokens billed within outputTokens (instrumentation). */
    reasoningTokens?: number;
  };
}

export interface ModelTurnParams {
  /** Stable system/developer instructions. Kept first + byte-identical across
   *  turns so the provider's automatic prompt cache hits on the loop's many
   *  calls. */
  system: string;
  /** Conversation history + the new user message + prior tool calls/outputs. */
  input: ModelInputItem[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** Per-call model (PLAN/CRITIQUE gpt-5.5 · GENERATE/classifier gpt-5.4-mini).
   *  Falls back to the provider's env default when omitted. */
  model?: string;
  /** Per-call reasoning effort (PLAN high · GENERATE medium · CRITIQUE high).
   *  Falls back to the provider's env default when omitted. */
  effort?: ReasoningEffort;
  /** When set, force a structured-output turn: the model returns JSON matching
   *  this strict JSON Schema as its text (used by the PLAN/classifier turns). */
  responseFormat?: { name: string; schema: JsonSchema };
}

/**
 * The single provider seam. Implementations:
 *   - providers/openai.ts — the real OpenAI Responses adapter (only file that
 *     imports the `openai` SDK).
 *   - providers/mock.ts — deterministic, runs with no API key (tests + the
 *     no-key path).
 */
export interface ModelClient {
  readonly model: string;
  /**
   * Run ONE model turn. Normalized events are delivered to `onEvent` as they
   * stream in; the returned promise resolves with the aggregated turn (final
   * text + the tool calls the model wants executed).
   */
  runTurn(
    params: ModelTurnParams,
    onEvent: (event: ModelStreamEvent) => void
  ): Promise<ModelTurnResult>;
}
