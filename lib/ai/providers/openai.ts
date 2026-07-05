/**
 * OpenAI Responses adapter — THE ONLY file that imports the `openai` SDK.
 *
 * Maps our provider-neutral ModelClient onto the Responses API: input items →
 * Responses items, tool definitions → strict function tools, and the streamed
 * events → our normalized ModelStreamEvent. The model id + reasoning effort are
 * env config, never hardcoded literals. Server-only: the API key never leaves
 * this process.
 */

import { createRequire } from "node:module";
import OpenAI from "openai";
import type {
  ModelClient,
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
 * The proxy URL the OpenAI client should tunnel through, or "" for a DIRECT
 * connection. An EXPLICIT `OPENAI_PROXY_URL` wins; otherwise the conventional
 * `HTTPS_PROXY`/`HTTP_PROXY` (what a local Clash/VPN sets) is honored.
 *
 * Why this exists: Node's built-in `fetch` (undici) — which the OpenAI SDK uses —
 * does NOT read `HTTPS_PROXY`, so on a machine where `api.openai.com` is only
 * reachable via a local proxy the SDK connects DIRECTLY, the socket never
 * establishes, and it dies at the OS TCP-connect timeout (~75s on macOS:
 * `net.inet.tcp.keepinit`). That is the "agent times out at ~76s" bug.
 *
 * PRODUCTION is unaffected: it sets no proxy env, so this returns "" and the
 * client connects directly exactly as before.
 */
export function resolveProxyUrl(): string {
  return (
    process.env.OPENAI_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ""
  );
}

/**
 * Build the proxy transport for `proxyUrl` — undici's `fetch` PLUS a `ProxyAgent`
 * dispatcher — or null if `undici` isn't installed. Both MUST come from the same
 * undici package: the OpenAI SDK's bundled fetch rejects a foreign dispatcher
 * ("Connection error … incompatible with the fetch implementation"), so we pass
 * undici's own `fetch` alongside the dispatcher (per the SDK's own guidance).
 *
 * The ProxyAgent gets explicit SOCKET timeouts (`connectTimeout` / `headersTimeout`
 * / `bodyTimeout`) so a stuck tunnel or a silently-dropped response can't sit open
 * for minutes. Set generously above the client timeout so a legitimately long
 * reasoning call isn't cut, but finite so a dead socket dies.
 *
 * Loaded via `createRequire` with a NON-LITERAL specifier so the Next bundler
 * never tries to resolve `undici` at build time — it's a devDependency, only
 * needed where a proxy env is set (local dev behind Clash); production never
 * reaches this (no proxy env) and never needs the package.
 */
function makeProxyTransport(
  proxyUrl: string,
  timeouts: { connectMs: number; socketCeilingMs: number }
): { fetch: unknown; dispatcher: unknown } | null {
  try {
    const req = createRequire(import.meta.url);
    const specifier = "undici"; // variable defeats bundler static analysis
    const { fetch, ProxyAgent } = req(specifier) as {
      fetch: unknown;
      ProxyAgent: new (opts: unknown) => unknown;
    };
    const dispatcher = new ProxyAgent({
      uri: proxyUrl,
      connect: { timeout: timeouts.connectMs },
      headersTimeout: timeouts.socketCeilingMs,
      bodyTimeout: timeouts.socketCeilingMs,
    });
    return { fetch, dispatcher };
  } catch {
    return null;
  }
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

export function createOpenAIModelClient(): ModelClient {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const maxRetries = Number(process.env.OPENAI_MAX_RETRIES) || DEFAULT_MAX_RETRIES;
  const timeout = Number(process.env.OPENAI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  // Socket-level backstop for the proxied transport: the connect timeout cuts a
  // stuck tunnel; the headers/body ceiling cuts a dead response. Set above the
  // client timeout so a real long call isn't preempted, finite so a dead socket
  // can't hang for minutes.
  const undiciConnectMs = Number(process.env.OPENAI_UNDICI_CONNECT_TIMEOUT_MS) || 30_000;
  const undiciSocketCeilingMs = Number(process.env.OPENAI_UNDICI_TIMEOUT_MS) || 210_000;

  // Route through a proxy ONLY when one is configured. Scoped to THIS client via
  // its own undici fetch + dispatcher, so Supabase and every other fetch in the
  // process keep their direct connection — we never touch the global dispatcher.
  // No proxy env ⇒ no custom transport ⇒ direct connection (production default).
  const proxyUrl = resolveProxyUrl();
  let proxied = false;
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey, maxRetries, timeout };
  if (proxyUrl) {
    const transport = makeProxyTransport(proxyUrl, {
      connectMs: undiciConnectMs,
      socketCeilingMs: undiciSocketCeilingMs,
    });
    if (transport) {
      clientOpts.fetch = transport.fetch as never;
      clientOpts.fetchOptions = { dispatcher: transport.dispatcher } as never;
      proxied = true;
    } else {
      console.warn(
        JSON.stringify({
          tag: "openai_proxy_unavailable",
          proxyUrl,
          message:
            "A proxy is configured (OPENAI_PROXY_URL/HTTPS_PROXY) but the 'undici' package isn't installed — the OpenAI SDK can't tunnel through it and will connect DIRECTLY (likely to time out). Run `npm i -D undici`.",
        })
      );
    }
  }
  const client = new OpenAI(clientOpts);

  // One line that states the ACTUAL transport config the SDK will use — so logs
  // show whether the proxy is engaged and what timeout/retries are really applied
  // (not just what we intended). Grep `openai_client_config`.
  console.log(
    JSON.stringify({
      tag: "openai_client_config",
      proxy: proxied ? "on" : "off",
      proxyUrl: proxied ? proxyUrl : undefined,
      transport: proxied ? "undici.fetch+ProxyAgent" : "default",
      clientTimeoutMs: timeout,
      maxRetries,
    })
  );
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

      try {
        const stream = client.responses.stream(
          {
            model,
            instructions: params.system,
            input,
            tools,
            reasoning: { effort: params.effort ?? defaultEffort },
            max_output_tokens: params.maxOutputTokens ?? maxOutputTokens,
            store: false,
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
          },
          { signal: params.signal }
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
            // Emit the tool's START as soon as it appears (args still streaming).
            onEvent({
              type: "tool_call",
              call: { callId: event.item.call_id, name: event.item.name, arguments: "" },
            });
          }
        }

        const final = await stream.finalResponse();
        const toolCalls: ModelToolCall[] = [];
        for (const o of final.output) {
          if (o.type === "function_call") {
            toolCalls.push({ callId: o.call_id, name: o.name, arguments: o.arguments });
          }
        }
        // `final.output_text` is empty for reasoning + structured output, so read
        // the message parts ourselves; fall back to the getter, then the deltas.
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
      } catch (error) {
        // Surface the real cause: OpenAI APIError carries a status + a body
        // `error.message` (e.g. an invalid-schema 400) — far more useful than the
        // generic SDK message. Logged server-side; a clean line goes to the user.
        const e = error as { status?: number; message?: string; error?: { message?: string; code?: string } };
        const body = e?.error?.message ?? e?.message ?? "OpenAI request failed";
        const message = e?.status ? `[${e.status}] ${body}` : body;
        console.log(JSON.stringify({ tag: "openai_error", status: e?.status, code: e?.error?.code, message: body }));
        onEvent({ type: "error", message });
        return { text: "", toolCalls: [], finishReason: "error" };
      }
    },
  };
}
