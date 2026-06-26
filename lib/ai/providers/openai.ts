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
  ImageInspectParams,
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
// The GPT Image model returns base64; the caller stores it. Pinned to a DATED
// snapshot (not the floating `gpt-image-2` alias) so prod output can't shift under
// us; OPENAI_IMAGE_MODEL overrides (e.g. back to gpt-image-1 or a newer snapshot).
const DEFAULT_IMAGE_MODEL = "gpt-image-2-2026-04-21";
// Cheap vision model for reference-image verification. AI_VISION_MODEL overrides.
const DEFAULT_VISION_MODEL = "gpt-5.4-mini";

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
 * The ProxyAgent gets explicit SOCKET timeouts (`connectTimeout` / `headersTimeout`
 * / `bodyTimeout`) so a stuck tunnel or a silently-dropped response can't sit open
 * for minutes — the real-world failure that made a 180s "timeout" actually run
 * 11–18 min. These are a backstop UNDER the per-call AbortController deadline (the
 * precise enforcement); set generously so a legitimately long reasoning call isn't
 * cut, but finite so a dead socket dies.
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
 * A HARD per-call deadline: an AbortController that fires after `ms`, also forwarding
 * an upstream abort (the user's Stop). Returns the signal to hand the SDK plus a
 * `dispose` to clear the timer and a `timedOut()` flag so the caller can classify a
 * deadline-abort as `transport_timeout` (vs a user Stop).
 *
 * This is the actual fix for "configured timeoutMs 180000 ran for 1,093,703 ms":
 * the SDK's own `timeout` option was silently ignored by the proxied undici fetch,
 * and on a dead socket the SDK retried it 5×. Wiring our own controller to the fetch
 * `signal` guarantees the request — and every internal retry under it — is aborted
 * at the deadline. PURE + exported so it's unit-testable without a network.
 */
export function withTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  ms: number | undefined
): { signal: AbortSignal | undefined; dispose: () => void; timedOut: () => boolean } {
  // No finite deadline + no parent ⇒ nothing to wire (preserve the prior behavior).
  if ((!ms || ms <= 0) && !parentSignal) return { signal: undefined, dispose: () => {}, timedOut: () => false };
  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (ms && ms > 0) {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`Request exceeded its ${ms}ms deadline`));
    }, ms);
    // Don't keep the process alive just for this timer.
    (timer as { unref?: () => void }).unref?.();
  }
  const onParentAbort = () => controller.abort((parentSignal as { reason?: unknown })?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort((parentSignal as { reason?: unknown }).reason);
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => didTimeout,
  };
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
  // Socket-level backstop for the proxied transport (under the per-call deadline):
  // the connect timeout cuts a stuck tunnel; the headers/body ceiling cuts a dead
  // response. Set above the largest per-call deadline (the plan's 180s) so a real
  // long call isn't preempted, finite so a dead socket can't hang for minutes.
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
    const transport = makeProxyTransport(proxyUrl, { connectMs: undiciConnectMs, socketCeilingMs: undiciSocketCeilingMs });
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

      // HARD per-call deadline. The SDK `timeout` option alone is silently ignored
      // by the proxied undici fetch (calls ran 11–18 min on a configured 180s),
      // so we wire our own AbortController to the fetch `signal` — it aborts the
      // request AND every internal SDK retry under it at the deadline. Keyed on the
      // explicit per-call timeoutMs (the plan calls); other calls keep the upstream
      // signal + undici's socket ceiling as the backstop. maxRetries is per-call so
      // a dead plan socket isn't retried 5×.
      const deadline = withTimeoutSignal(params.signal, params.timeoutMs);
      const requestOpts = {
        signal: deadline.signal,
        ...(params.timeoutMs ? { timeout: params.timeoutMs } : {}),
        ...(params.maxRetries != null ? { maxRetries: params.maxRetries } : {}),
      };
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
              requestOpts
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
            await sleep(pollInterval, deadline.signal);
            try {
              resp = await client.responses.retrieve(resp.id, undefined, { signal: deadline.signal });
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
            requestOpts
          );
          return resultFromResponse(final, "");
        }

        // STREAMING (default): emit deltas + tool-call starts as they arrive.
        const stream = client.responses.stream(
          { ...body, store: false },
          requestOpts
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
        // logs/messages a timeout differently from an invalid-schema 400. If OUR
        // deadline fired, it's unambiguously a transport timeout (the abort beat the
        // SDK's own classification). Logged server-side; a clean line goes to the user.
        const classified = classifyError(error);
        const kind: ModelErrorKind = deadline.timedOut() ? "transport_timeout" : classified.kind;
        const message = deadline.timedOut()
          ? `Request exceeded its ${params.timeoutMs}ms deadline.`
          : classified.message;
        console.log(JSON.stringify({ tag: "openai_error", errorKind: kind, status: classified.status, message, deadlineHit: deadline.timedOut() }));
        onEvent({ type: "error", message, kind });
        return { text: "", toolCalls: [], finishReason: "error", errorKind: kind };
      } finally {
        deadline.dispose();
      }
    },

    async generateImage(params) {
      // Prefer the exact size (pinned by visualWeight); fall back to the coarse aspect.
      const size = params.size ?? aspectToImageSize(params.aspectRatio);
      const background = params.background ?? "auto";
      const quality = params.quality;
      // gpt-image-2 "thinking" mode: the exact param name is unconfirmed, so it is
      // ONLY sent when explicitly enabled (AI_IMAGE_THINKING_ENABLED=true) — an
      // unverified field must not 400 every reference image. Flip the env on once the
      // docs confirm the field (and rename `thinking` here if needed).
      const useThinking = params.thinking === true && process.env.AI_IMAGE_THINKING_ENABLED === "true";
      // Cast to the NON-streaming params type (an extra `thinking` key rides through
      // for gpt-image-2; the cast keeps the non-streaming overload → res.data typed).
      const body = {
        model: imageModel,
        prompt: params.prompt,
        size,
        background,
        n: 1,
        ...(quality ? { quality } : {}),
        ...(useThinking ? { thinking: true } : {}),
      } as OpenAI.Images.ImageGenerateParamsNonStreaming;
      const t0 = Date.now();
      try {
        const res = await client.images.generate(body, { signal: params.signal });
        const latencyMs = Date.now() - t0;
        const b64 = res.data?.[0]?.b64_json;
        if (!b64) {
          console.log(JSON.stringify({ tag: "openai_image", outcome: "empty", model: imageModel, size, background, quality, latencyMs }));
          return null;
        }
        const { width, height } = imageSizeDims(size);
        console.log(JSON.stringify({ tag: "openai_image", outcome: "ok", model: imageModel, size, background, quality, thinking: useThinking, bytes: b64.length, latencyMs }));
        return { base64: b64, mimeType: "image/png", width, height };
      } catch (error) {
        const latencyMs = Date.now() - t0;
        const { kind, message, status } = classifyError(error);
        console.log(JSON.stringify({ tag: "openai_image_error", errorKind: kind, status, message, model: imageModel, latencyMs }));
        return null;
      }
    },

    async inspectImage(params: ImageInspectParams) {
      const visionModel = process.env.AI_VISION_MODEL ?? DEFAULT_VISION_MODEL;
      const dataUrl = `data:${params.mimeType};base64,${params.base64}`;
      const t0 = Date.now();
      try {
        const res = await client.responses.create(
          {
            model: visionModel,
            reasoning: { effort: "low" },
            max_output_tokens: 600,
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: params.instruction },
                  { type: "input_image", image_url: dataUrl, detail: "low" },
                ],
              },
            ],
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
        const text = messageTextFromOutput(res.output) || res.output_text || "";
        console.log(JSON.stringify({ tag: "openai_image_inspect", outcome: "ok", model: visionModel, chars: text.length, latencyMs: Date.now() - t0 }));
        return { text };
      } catch (error) {
        const { kind, message, status } = classifyError(error);
        console.log(JSON.stringify({ tag: "openai_image_inspect_error", errorKind: kind, status, message, model: visionModel, latencyMs: Date.now() - t0 }));
        return null;
      }
    },
  };
}
