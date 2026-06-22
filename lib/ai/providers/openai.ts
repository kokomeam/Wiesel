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
// The image model for educational illustrations (the non-diagram visual path).
// gpt-image-1 returns base64; the caller stores it. OPENAI_IMAGE_MODEL overrides.
const DEFAULT_IMAGE_MODEL = "gpt-image-1";

/** Map a coarse aspect ratio to gpt-image-1's nearest supported size. */
function aspectToImageSize(aspect?: string): "1024x1024" | "1536x1024" | "1024x1536" {
  if (aspect === "1:1") return "1024x1024";
  if (aspect === "3:4" || aspect === "9:16") return "1024x1536";
  return "1536x1024"; // 4:3 / 16:9 / default — landscape suits a slide
}
function imageSizeDims(size: string): { width: number; height: number } {
  const [w, h] = size.split("x").map((n) => Number(n));
  return { width: w || 1536, height: h || 1024 };
}
// The SDK retries 429/5xx/connection errors with exponential backoff and honors
// Retry-After itself — we just give it MORE headroom than its default of 2 so an
// occasional per-minute TPM burst rides out instead of surfacing as a failed
// turn. No hand-rolled backoff. Env-overridable.
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 120_000;
// Background-mode poll loop (create → poll → retrieve). Generous overall budget
// (a backgrounded plan can take minutes) + a short poll interval. Env-overridable.
const DEFAULT_BG_POLL_TIMEOUT_MS = 300_000;
const DEFAULT_BG_POLL_INTERVAL_MS = 2_000;

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
 * `net.inet.tcp.keepinit`). That is the "module planning timed out at ~76s" bug.
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
 * Loaded via `createRequire` with a NON-LITERAL specifier so the Next bundler
 * never tries to resolve `undici` at build time — it's a devDependency, only
 * needed where a proxy env is set (local dev behind Clash); production never
 * reaches this (no proxy env) and never needs the package.
 */
function makeProxyTransport(proxyUrl: string): { fetch: unknown; dispatcher: unknown } | null {
  try {
    const req = createRequire(import.meta.url);
    const specifier = "undici"; // variable defeats bundler static analysis
    const { fetch, ProxyAgent } = req(specifier) as {
      fetch: unknown;
      ProxyAgent: new (u: string) => unknown;
    };
    return { fetch, dispatcher: new ProxyAgent(proxyUrl) };
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

  // Route through a proxy ONLY when one is configured. Scoped to THIS client via
  // its own undici fetch + dispatcher, so Supabase and every other fetch in the
  // process keep their direct connection — we never touch the global dispatcher.
  // No proxy env ⇒ no custom transport ⇒ direct connection (production default).
  const proxyUrl = resolveProxyUrl();
  let proxied = false;
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey, maxRetries, timeout };
  if (proxyUrl) {
    const transport = makeProxyTransport(proxyUrl);
    if (transport) {
      // Pass undici's fetch + dispatcher TOGETHER, scoped to this client only — the
      // global dispatcher (Supabase + every other fetch) is untouched and stays direct.
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
  const imageModel = process.env.OPENAI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
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
        // The CREATE call still has to connect (and is short), so its own timeout
        // applies; the long wait happens across cheap retrieve() polls, NOT one
        // held connection.
        if (params.background) {
          let created: OpenAI.Responses.Response;
          try {
            created = await client.responses.create(
              { ...body, store: true, background: true, stream: false },
              { signal: params.signal, ...requestTimeout }
            );
          } catch (createErr) {
            // The CREATE itself failed (couldn't even start the job) — log it
            // SEPARATELY from a poll failure so the two are distinguishable.
            const { kind, message, status } = classifyError(createErr);
            console.log(JSON.stringify({ tag: "openai_background", phase: "create", errorKind: kind, status, message }));
            onEvent({ type: "error", message, kind });
            return { text: "", toolCalls: [], finishReason: "error", errorKind: kind };
          }

          // ms budget for the WHOLE poll loop (not a token count — the prior bug
          // used maxOutputTokens here). Configurable; defaults generous for plans.
          const pollTimeout = Number(process.env.AI_BACKGROUND_POLL_TIMEOUT_MS) || params.timeoutMs || DEFAULT_BG_POLL_TIMEOUT_MS;
          const pollInterval = Number(process.env.AI_BACKGROUND_POLL_INTERVAL_MS) || DEFAULT_BG_POLL_INTERVAL_MS;
          console.log(JSON.stringify({ tag: "openai_background", phase: "create", responseId: created.id, status: created.status, pollTimeoutMs: pollTimeout, pollIntervalMs: pollInterval }));

          const start = Date.now();
          let resp = created;
          let prevStatus = resp.status;
          while (resp.status === "queued" || resp.status === "in_progress") {
            if (Date.now() - start > pollTimeout) {
              const message = "Background plan timed out while polling for the result.";
              onEvent({ type: "error", message, kind: "transport_timeout" });
              console.log(JSON.stringify({ tag: "openai_background", phase: "poll", outcome: "poll_timeout", responseId: resp.id, lastStatus: resp.status, waitedMs: Date.now() - start }));
              return { text: "", toolCalls: [], finishReason: "error", errorKind: "transport_timeout" };
            }
            await sleep(pollInterval, params.signal);
            try {
              resp = await client.responses.retrieve(resp.id);
            } catch (pollErr) {
              const { kind, message } = classifyError(pollErr);
              console.log(JSON.stringify({ tag: "openai_background", phase: "poll", outcome: "poll_failed", responseId: created.id, errorKind: kind, message }));
              onEvent({ type: "error", message, kind });
              return { text: "", toolCalls: [], finishReason: "error", errorKind: kind };
            }
            if (resp.status !== prevStatus) {
              console.log(JSON.stringify({ tag: "openai_background", phase: "poll", responseId: resp.id, status: resp.status, elapsedMs: Date.now() - start }));
              prevStatus = resp.status;
            }
          }
          // Terminal non-success states: failed / cancelled / (expired surfaces here too).
          if (resp.status !== "completed") {
            const message = resp.error?.message ?? `Background plan ${resp.status}.`;
            onEvent({ type: "error", message, kind: "model_error" });
            console.log(JSON.stringify({ tag: "openai_background", phase: "terminal", responseId: resp.id, status: resp.status, message }));
            return { text: "", toolCalls: [], finishReason: "error", errorKind: "model_error" };
          }
          console.log(JSON.stringify({ tag: "openai_background", phase: "terminal", responseId: resp.id, status: "completed", elapsedMs: Date.now() - start }));
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

    async generateImage(params) {
      const size = aspectToImageSize(params.aspectRatio);
      try {
        const res = await client.images.generate(
          { model: imageModel, prompt: params.prompt, size, n: 1 },
          { signal: params.signal }
        );
        const b64 = res.data?.[0]?.b64_json;
        if (!b64) {
          console.log(JSON.stringify({ tag: "openai_image", outcome: "empty", model: imageModel, size }));
          return null;
        }
        const { width, height } = imageSizeDims(size);
        console.log(JSON.stringify({ tag: "openai_image", outcome: "ok", model: imageModel, size, bytes: b64.length }));
        return { base64: b64, mimeType: "image/png", width, height };
      } catch (error) {
        const { kind, message, status } = classifyError(error);
        console.log(JSON.stringify({ tag: "openai_image_error", errorKind: kind, status, message, model: imageModel }));
        return null;
      }
    },
  };
}
