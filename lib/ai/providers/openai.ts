/**
 * OpenAI Responses adapter — THE ONLY file that imports the `openai` SDK.
 *
 * Maps our provider-neutral ModelClient onto the Responses API: input items →
 * Responses items, tool definitions → strict function tools, and the streamed
 * events → our normalized ModelStreamEvent. The model id + reasoning effort are
 * env config, never hardcoded literals. Server-only: the API key never leaves
 * this process.
 */

import OpenAI from "openai";
import type {
  ModelClient,
  ModelErrorKind,
  ModelInputItem,
  ModelStreamEvent,
  ModelToolCall,
  ModelTurnParams,
  ModelTurnResult,
} from "../modelClient";

// NOTE: confirm the exact id against the OpenAI dashboard before relying on it;
// OPENAI_MODEL overrides at runtime.
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_EFFORT = "medium";
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
// The SDK retries 429/5xx/connection errors with exponential backoff and honors
// Retry-After itself — we just give it MORE headroom than its default of 2 so an
// occasional per-minute TPM burst rides out instead of surfacing as a failed
// turn. No hand-rolled backoff. Env-overridable.
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Whether the server is configured to talk to OpenAI. */
export function isOpenAIConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Concatenate the assistant text from a Responses API `output` array by reading
 * `message` items' `output_text` parts directly. The SDK's `output_text`
 * convenience getter comes back EMPTY for a reasoning + structured-output
 * (json_schema) response even though the JSON was produced — reading the parts
 * ourselves is the reliable path. Pure + duck-typed so it's unit-testable. */
export function messageTextFromOutput(output: readonly unknown[]): string {
  let text = "";
  for (const o of output) {
    const item = o as { type?: string; content?: unknown };
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const p of item.content) {
        const part = p as { type?: string; text?: unknown };
        if (part.type === "output_text" && typeof part.text === "string") text += part.text;
      }
    }
  }
  return text;
}

function toResponsesItem(item: ModelInputItem): OpenAI.Responses.ResponseInputItem {
  if ("role" in item) {
    return { role: item.role, content: item.content };
  }
  if (item.type === "function_call") {
    return { type: "function_call", call_id: item.callId, name: item.name, arguments: item.arguments };
  }
  return { type: "function_call_output", call_id: item.callId, output: item.output };
}

/** Categorize a thrown error so the agent logs transport timeouts SEPARATELY from
 *  model (API) errors — an empty timed-out response must never read as "invalid
 *  JSON". Uses the SDK's typed errors, with a message fallback. */
function classifyError(error: unknown): { kind: ModelErrorKind; message: string; status?: number } {
  const e = error as { status?: number; message?: string; error?: { message?: string; code?: string } };
  const body = e?.error?.message ?? e?.message ?? "OpenAI request failed";
  const message = e?.status ? `[${e.status}] ${body}` : body;
  if (error instanceof OpenAI.APIConnectionTimeoutError || /\btimed out\b|\btimeout\b/i.test(body)) {
    return { kind: "transport_timeout", message, status: e?.status };
  }
  if (typeof e?.status === "number") return { kind: "model_error", message, status: e.status };
  if (error instanceof OpenAI.APIConnectionError) return { kind: "transport", message };
  return { kind: "transport", message };
}

/** Pull the normalized result out of a finished Responses object (shared by the
 *  streaming, non-streaming, and background paths). */
function resultFromResponse(final: OpenAI.Responses.Response, streamedText: string): ModelTurnResult {
  const toolCalls: ModelToolCall[] = [];
  for (const o of final.output) {
    if (o.type === "function_call") toolCalls.push({ callId: o.call_id, name: o.name, arguments: o.arguments });
  }
  const text = messageTextFromOutput(final.output) || final.output_text || streamedText || "";
  const usage = final.usage;
  return {
    text,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : final.status === "incomplete" ? "incomplete" : "stop",
    usage: usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedTokens: usage.input_tokens_details?.cached_tokens,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
        }
      : undefined,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

export function createOpenAIModelClient(): ModelClient {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const maxRetries = Number(process.env.OPENAI_MAX_RETRIES) || DEFAULT_MAX_RETRIES;
  const timeout = Number(process.env.OPENAI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const client = new OpenAI({ apiKey, maxRetries, timeout });
  const defaultModel = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const defaultEffort = (process.env.OPENAI_REASONING_EFFORT ?? DEFAULT_EFFORT) as
    | "minimal"
    | "low"
    | "medium"
    | "high";
  const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS;

  return {
    model: defaultModel,
    async runTurn(
      params: ModelTurnParams,
      onEvent: (event: ModelStreamEvent) => void
    ): Promise<ModelTurnResult> {
      const model = params.model ?? defaultModel;
      const input = params.input.map(toResponsesItem);
      const tools = params.tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: true,
      }));

      const requestTimeout = params.timeoutMs ? { timeout: params.timeoutMs } : {};
      const body = {
        model,
        instructions: params.system,
        input,
        tools,
        reasoning: { effort: params.effort ?? defaultEffort },
        max_output_tokens: params.maxOutputTokens ?? maxOutputTokens,
        ...(params.responseFormat
          ? {
              text: {
                format: {
                  type: "json_schema" as const,
                  name: params.responseFormat.name,
                  strict: true,
                  schema: params.responseFormat.schema,
                },
              },
            }
          : {}),
      };

      try {
        // BACKGROUND mode: create then POLL — never hold one long HTTP request
        // open through the model's silent reasoning (which an idle proxy can drop).
        if (params.background) {
          const created = await client.responses.create(
            { ...body, store: true, background: true, stream: false },
            { signal: params.signal, ...requestTimeout }
          );
          const deadline = params.timeoutMs ?? maxOutputTokens; // ms budget for the poll loop
          const start = Date.now();
          let resp = created;
          while (resp.status === "queued" || resp.status === "in_progress") {
            if (Date.now() - start > Math.max(deadline, 120_000)) {
              onEvent({ type: "error", message: "Background plan timed out.", kind: "transport_timeout" });
              console.log(JSON.stringify({ tag: "openai_error", mode: "background", message: "poll deadline exceeded" }));
              return { text: "", toolCalls: [], finishReason: "error", errorKind: "transport_timeout" };
            }
            await sleep(2000, params.signal);
            resp = await client.responses.retrieve(resp.id);
          }
          if (resp.status === "failed" || resp.status === "cancelled") {
            const message = resp.error?.message ?? `Background plan ${resp.status}.`;
            onEvent({ type: "error", message, kind: "model_error" });
            console.log(JSON.stringify({ tag: "openai_error", mode: "background", status: resp.status, message }));
            return { text: "", toolCalls: [], finishReason: "error", errorKind: "model_error" };
          }
          return resultFromResponse(resp, "");
        }

        // NON-STREAMING: a one-shot structured plan doesn't need token streaming.
        if (params.stream === false) {
          const final = await client.responses.create(
            { ...body, store: false, stream: false },
            { signal: params.signal, ...requestTimeout }
          );
          return resultFromResponse(final, "");
        }

        // STREAMING (default): emit deltas + tool-call starts as they arrive.
        const stream = client.responses.stream(
          { ...body, store: false },
          { signal: params.signal, ...requestTimeout }
        );
        let streamedText = "";
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            streamedText += event.delta ?? "";
            onEvent({ type: "text_delta", delta: event.delta ?? "" });
          } else if (
            event.type === "response.output_item.added" &&
            event.item.type === "function_call"
          ) {
            onEvent({
              type: "tool_call",
              call: { callId: event.item.call_id, name: event.item.name, arguments: "" },
            });
          }
        }
        return resultFromResponse(await stream.finalResponse(), streamedText);
      } catch (error) {
        // Categorize: transport_timeout vs model_error vs transport — so the agent
        // logs/messages a timeout differently from an invalid-schema 400. Logged
        // server-side; a clean, categorized line goes to the user.
        const { kind, message, status } = classifyError(error);
        console.log(JSON.stringify({ tag: "openai_error", errorKind: kind, status, message }));
        onEvent({ type: "error", message, kind });
        return { text: "", toolCalls: [], finishReason: "error", errorKind: kind };
      }
    },
  };
}
