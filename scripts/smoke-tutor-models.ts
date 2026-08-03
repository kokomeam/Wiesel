/**
 * TUTOR-1 model registry LIVE smoke — DIAGNOSTIC ONLY, never CI (W1.1 item 7).
 *
 *   npx tsx scripts/smoke-tutor-models.ts
 *
 * MUST pass before the first real extraction run. Validates against the REAL
 * API (zero-cost-conscious — one trivial structured call + one tiny embed):
 *   1. the resolved TUTOR_MODELS registry (env overrides + deny-list applied)
 *   2. the graph_extraction model id accepts a trivial strict-JSON call at the
 *      registry's effort value (id + effort vocabulary validated together)
 *   3. computeCostUsd over the call's real usage (pricing wiring, actual USD)
 *   4. the embedding model returns sane vectors for a 2-string batch
 *
 * Loads .env.local (OPENAI_API_KEY + optional OPENAI_PROXY_URL — the provider
 * routes its own proxy; nothing global is touched). Exits nonzero on failure.
 */

import { readFileSync } from "node:fs";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { computeCostUsd, TUTOR_MODELS } from "@/lib/ai/modelConfig";

// ── load .env.local → process.env ──────────────────────────────────────────
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
// Fail fast: a dead transport should report, not spin through SDK retries.
process.env.OPENAI_MAX_RETRIES = "0";

function log(o: Record<string, unknown>) {
  console.log(JSON.stringify(o));
}

let failures = 0;
function verdict(name: string, ok: boolean, detail?: Record<string, unknown>) {
  log({ smoke: name, ok, ...(detail ?? {}) });
  if (!ok) failures += 1;
}

const TINY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { concept: { type: "string" } },
  required: ["concept"],
};

async function main() {
  // 1 — the resolved registry.
  log({ smoke: "registry", resolved: TUTOR_MODELS });

  if (!process.env.OPENAI_API_KEY) {
    verdict("api-key", false, { error: "OPENAI_API_KEY missing from .env.local" });
    process.exit(1);
  }
  const client = createOpenAIModelClient();

  // 2 + 3 — trivial structured call on the extraction model at the registry's
  // own effort (model id + effort vocabulary validated in one request).
  const job = TUTOR_MODELS.graph_extraction;
  const t0 = Date.now();
  try {
    const result = await client.runTurn(
      {
        system: "You extract concepts. Respond with ONLY the JSON object.",
        input: [{ role: "user", content: 'One-word concept taught by "2 + 2 = 4"?' }],
        tools: [],
        stream: false,
        model: job.model,
        effort: job.effort,
        maxOutputTokens: 2000,
        responseFormat: { name: "tiny_concept", schema: TINY_SCHEMA },
      },
      () => {}
    );
    const ms = Date.now() - t0;
    const parsed = (() => {
      try {
        return JSON.parse(result.text || "{}") as { concept?: string };
      } catch {
        return {};
      }
    })();
    const usage = {
      inputTokens: result.usage?.inputTokens ?? 0,
      cachedTokens: result.usage?.cachedTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    };
    const costUsd = computeCostUsd(usage, job.model);
    verdict("extraction-model-structured-call", result.finishReason !== "error" && typeof parsed.concept === "string", {
      model: job.model,
      effort: job.effort,
      ms,
      concept: parsed.concept ?? null,
      usage,
      costUsd,
      responseId: result.responseId ?? null,
    });
    verdict("cost-computed", costUsd !== null && costUsd > 0, { costUsd });
  } catch (e) {
    verdict("extraction-model-structured-call", false, {
      model: job.model,
      effort: job.effort,
      ms: Date.now() - t0,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }

  // 4 — embedding batch.
  const emb = TUTOR_MODELS.embedding;
  const t1 = Date.now();
  try {
    if (!client.embed) throw new Error("provider client has no embed()");
    const res = await client.embed({
      model: emb.model,
      inputs: ["supply and demand", "binary search trees"],
    });
    const dims = res.vectors.map((v) => v.length);
    const nonZero = res.vectors.every((v) => v.some((x) => x !== 0));
    const embCost = computeCostUsd(
      { inputTokens: res.usage.inputTokens, cachedTokens: 0, outputTokens: 0 },
      emb.model
    );
    verdict("embedding-batch", res.vectors.length === 2 && dims[0] === dims[1] && dims[0] > 0 && nonZero, {
      model: emb.model,
      ms: Date.now() - t1,
      dims,
      inputTokens: res.usage.inputTokens,
      costUsd: embCost,
    });
  } catch (e) {
    verdict("embedding-batch", false, {
      model: emb.model,
      ms: Date.now() - t1,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }

  log({ smoke: "done", failures });
  process.exit(failures === 0 ? 0 : 1);
}

void main();
