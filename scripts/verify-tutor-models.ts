/**
 * TUTOR-1 Wave 1.1 (part A) PURE verification — no key, no DB, no browser.
 * Run: `npx tsx scripts/verify-tutor-models.ts`
 *
 * Covers: the TUTOR_MODELS registry shape, the deny-list guard (via the exported
 * pure predicate), computeCostUsd goldens + clamp + unknown-model null, the mock's
 * deterministic embed (identity + distinctness + unit norm), the mock's responseId
 * echo + previousResponseId acceptance, runStructuredCall's additive model/effort
 * options landing on the recorded params, and a grep guard keeping the tutor model
 * literals confined to lib/ai/modelConfig.ts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertTutorModelAllowed,
  computeCostUsd,
  TUTOR_MODELS,
  type TutorJobModel,
} from "@/lib/ai/modelConfig";
import type { ReasoningEffort } from "@/lib/ai/modelClient";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { runStructuredCall } from "@/lib/ai/subagent";
import { z } from "zod";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const VALID_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const REPO_ROOT = new URL("..", import.meta.url).pathname;

/* ── 1. Registry shape ── */
function registryShape() {
  console.log("\n— TUTOR_MODELS registry —");
  const jobs = ["graph_extraction", "reconciliation", "embedding", "tutor_turn"] as const;
  for (const job of jobs) {
    const cfg = TUTOR_MODELS[job] as TutorJobModel;
    check(
      `${job}: all five fields present + typed`,
      typeof cfg.model === "string" &&
        cfg.model.length > 0 &&
        VALID_EFFORTS.includes(cfg.effort) &&
        typeof cfg.timeoutMs === "number" &&
        cfg.timeoutMs > 0 &&
        typeof cfg.maxRetries === "number" &&
        cfg.maxRetries >= 0 &&
        typeof cfg.maxOutputTokens === "number" &&
        cfg.maxOutputTokens >= 0,
      JSON.stringify(cfg)
    );
  }
  check(
    "exactly the four jobs are present",
    Object.keys(TUTOR_MODELS).sort().join(",") ===
      "embedding,graph_extraction,reconciliation,tutor_turn"
  );
  check(
    "embedding model is text-embedding-3-small",
    TUTOR_MODELS.embedding.model === "text-embedding-3-small"
  );
  check("graph_extraction defaults to gpt-5.6-terra", TUTOR_MODELS.graph_extraction.model === "gpt-5.6-terra");
  check("reconciliation defaults to gpt-5.6-terra", TUTOR_MODELS.reconciliation.model === "gpt-5.6-terra");
  check("tutor_turn defaults to gpt-5.6-luna", TUTOR_MODELS.tutor_turn.model === "gpt-5.6-luna");
  check(
    "graph_extraction defaults: medium / 180s / 1 retry / 32k tokens",
    TUTOR_MODELS.graph_extraction.effort === "medium" &&
      TUTOR_MODELS.graph_extraction.timeoutMs === 180_000 &&
      TUTOR_MODELS.graph_extraction.maxRetries === 1 &&
      TUTOR_MODELS.graph_extraction.maxOutputTokens === 32_000
  );
  check(
    "embedding defaults: low / 60s / 2 retries / 0 tokens",
    TUTOR_MODELS.embedding.effort === "low" &&
      TUTOR_MODELS.embedding.timeoutMs === 60_000 &&
      TUTOR_MODELS.embedding.maxRetries === 2 &&
      TUTOR_MODELS.embedding.maxOutputTokens === 0
  );
  check(
    "tutor_turn defaults: medium / 120s / 1 retry / 8k tokens",
    TUTOR_MODELS.tutor_turn.effort === "medium" &&
      TUTOR_MODELS.tutor_turn.timeoutMs === 120_000 &&
      TUTOR_MODELS.tutor_turn.maxRetries === 1 &&
      TUTOR_MODELS.tutor_turn.maxOutputTokens === 8_000
  );
}

/* ── 2. Deny-list guard (pure predicate) ── */
function denyList() {
  console.log("\n— deny-list guard —");
  const allows = (model: string) => {
    try {
      assertTutorModelAllowed(model, "graph_extraction");
      return true;
    } catch {
      return false;
    }
  };
  check("allows gpt-5.6-terra", allows("gpt-5.6-terra"));
  check("allows gpt-5.6-luna", allows("gpt-5.6-luna"));
  check("allows text-embedding-3-small", allows("text-embedding-3-small"));
  check("THROWS on gpt-5.6-sol (bare)", !allows("gpt-5.6-sol"));
  check("THROWS on gpt-5.6-sol-mini (dated snapshot)", !allows("gpt-5.6-sol-mini"));
  check("allows gpt-5.6-solstice (not a snapshot of sol)", allows("gpt-5.6-solstice"));
  check("case-exact: allows GPT-5.6-SOL (different case)", allows("GPT-5.6-SOL"));
  check(
    "the error names the job + the prohibition",
    (() => {
      try {
        assertTutorModelAllowed("gpt-5.6-sol", "reconciliation");
        return false;
      } catch (e) {
        const m = e instanceof Error ? e.message : "";
        return m.includes("reconciliation") && m.includes("gpt-5.6-sol");
      }
    })()
  );
}

/* ── 3. computeCostUsd goldens ── */
function pricing() {
  console.log("\n— computeCostUsd —");
  // terra: ((800*1.25)+(200*0.125)+(500*10))/1e6 = 0.006025
  check(
    "terra 1000 in / 200 cached / 500 out → 0.006025",
    computeCostUsd({ inputTokens: 1000, cachedTokens: 200, outputTokens: 500 }, "gpt-5.6-terra") === 0.006025
  );
  // luna zero-cached: (1000*0.25 + 500*2)/1e6 = 0.00125
  check(
    "luna 1000 in / 0 cached / 500 out → 0.00125",
    computeCostUsd({ inputTokens: 1000, cachedTokens: 0, outputTokens: 500 }, "gpt-5.6-luna") === 0.00125
  );
  // embedding output-free: (1000*0.02)/1e6 = 0.00002 (output priced at 0)
  check(
    "embedding 1000 in / 0 cached / 0 out → 0.00002",
    computeCostUsd({ inputTokens: 1000, cachedTokens: 0, outputTokens: 0 }, "text-embedding-3-small") === 0.00002
  );
  check(
    "unknown model → null",
    computeCostUsd({ inputTokens: 1000, cachedTokens: 0, outputTokens: 0 }, "gpt-9.9-mystery") === null
  );
  // cached > input clamps to input: all cached → (0*input + 1000*cached + 0)/1e6
  check(
    "cached > input clamps (all 1000 treated as cached)",
    computeCostUsd({ inputTokens: 1000, cachedTokens: 5000, outputTokens: 0 }, "gpt-5.6-terra") ===
      (1000 * 0.125) / 1_000_000
  );
  check(
    "negative cached clamps to 0",
    computeCostUsd({ inputTokens: 1000, cachedTokens: -50, outputTokens: 0 }, "gpt-5.6-terra") ===
      (1000 * 1.25) / 1_000_000
  );
}

/* ── 4. Grep guard: tutor model literals live ONLY in modelConfig.ts ── */
function grepGuard() {
  console.log("\n— grep guard (model literals confined) —");
  const literals = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "text-embedding-3-small"];
  const scriptAllowlist = new Set(["verify-tutor-models.ts", "smoke-tutor-models.ts", "verify-tutor-telemetry.ts"]);
  const offenders: Record<string, string[]> = { "gpt-5.6-terra": [], "gpt-5.6-luna": [], "gpt-5.6-sol": [], "text-embedding-3-small": [] };
  const solHits: string[] = [];

  function walk(dir: string, kind: "lib" | "app" | "scripts") {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full, kind);
        continue;
      }
      if (!/\.(ts|tsx|mts)$/.test(name)) continue;
      const rel = full.slice(REPO_ROOT.length);
      const isModelConfig = rel === "lib/ai/modelConfig.ts";
      const isAllowedScript = kind === "scripts" && scriptAllowlist.has(name);
      const text = readFileSync(full, "utf8");
      for (const lit of literals) {
        if (!text.includes(lit)) continue;
        if (isModelConfig || isAllowedScript) {
          // sol must appear only inside the deny-list in modelConfig.ts.
          if (lit === "gpt-5.6-sol" && isModelConfig) solHits.push(rel);
          continue;
        }
        offenders[lit].push(rel);
      }
    }
  }

  walk(join(REPO_ROOT, "lib"), "lib");
  walk(join(REPO_ROOT, "app"), "app");
  walk(join(REPO_ROOT, "scripts"), "scripts");

  for (const lit of literals) {
    check(`${lit} appears ONLY in modelConfig.ts (+ tutor scripts)`, offenders[lit].length === 0, offenders[lit].join(", "));
  }
  check("gpt-5.6-sol appears in modelConfig.ts (the deny-list)", solHits.includes("lib/ai/modelConfig.ts"));
}

/* ── 5. Mock embed determinism ── */
async function mockEmbed() {
  console.log("\n— mock embed determinism —");
  const client = createMockModelClient();
  if (!client.embed) {
    check("mock exposes embed()", false);
    return;
  }
  const a1 = await client.embed({ model: TUTOR_MODELS.embedding.model, inputs: ["concept: recursion"] });
  const a2 = await client.embed({ model: TUTOR_MODELS.embedding.model, inputs: ["concept: recursion"] });
  const b = await client.embed({ model: TUTOR_MODELS.embedding.model, inputs: ["concept: iteration"] });
  check("returns one 32-dim vector per input", a1.vectors.length === 1 && a1.vectors[0].length === 32);
  check(
    "same string twice → identical vectors",
    JSON.stringify(a1.vectors[0]) === JSON.stringify(a2.vectors[0])
  );
  check("different strings → different vectors", JSON.stringify(a1.vectors[0]) !== JSON.stringify(b.vectors[0]));
  const norm = Math.sqrt(a1.vectors[0].reduce((s, x) => s + x * x, 0));
  check("L2 norm ≈ 1", Math.abs(norm - 1) < 1e-9, `norm=${norm}`);
  check("usage.inputTokens = sum of ceil(len/4)", a1.usage.inputTokens === Math.ceil("concept: recursion".length / 4));
  const batch = await client.embed({ model: TUTOR_MODELS.embedding.model, inputs: ["x", "y", "z"] });
  check("batched: one call returns all vectors", batch.vectors.length === 3);
  check("embed calls are recorded", client.getEmbedCalls().length === 4);
}

/* ── 6. Mock responseId + previousResponseId ── */
async function mockResponseId() {
  console.log("\n— mock responseId / previousResponseId —");
  const client = createMockModelClient([{ text: "first" }, { text: "second" }], { finalText: "done" });
  const r0 = await client.runTurn(
    { system: "s", input: [{ role: "user", content: "hi" }], tools: [] },
    () => {}
  );
  const r1 = await client.runTurn(
    { system: "s", input: [{ role: "user", content: "hi" }], tools: [], previousResponseId: r0.responseId },
    () => {}
  );
  check("first turn echoes mock-resp-0", r0.responseId === "mock-resp-0");
  check("second turn echoes mock-resp-1", r1.responseId === "mock-resp-1");
  check("previousResponseId is accepted without error", r1.finishReason !== "error");
  check(
    "previousResponseId rode onto the recorded params",
    client.getCalls()[1].previousResponseId === "mock-resp-0"
  );
}

/* ── 7. runStructuredCall additive options ── */
async function structuredCallOptions() {
  console.log("\n— runStructuredCall model/effort/timeout/retries options —");
  const schema = z.object({ answer: z.string() });
  const client = createMockModelClient([], {
    structured: { tutor_probe: { answer: "ok" } },
  });
  const res = await runStructuredCall(client, {
    system: "s",
    input: "give an answer",
    outputName: "tutor_probe",
    outputSchema: schema,
    model: TUTOR_MODELS.graph_extraction.model,
    effort: TUTOR_MODELS.graph_extraction.effort,
    timeoutMs: TUTOR_MODELS.graph_extraction.timeoutMs,
    maxRetries: TUTOR_MODELS.graph_extraction.maxRetries,
  });
  check("structured call parses", res.ok && res.data?.answer === "ok");
  const recorded = client.getCalls()[0];
  check("model landed on the recorded params", recorded.model === "gpt-5.6-terra");
  check("effort landed on the recorded params", recorded.effort === "medium");
  check("timeoutMs landed on the recorded params", recorded.timeoutMs === 180_000);
  check("maxRetries landed on the recorded params", recorded.maxRetries === 1);

  // Byte-identical for existing callers: no options ⇒ none of the fields appear.
  const bare = createMockModelClient([], { structured: { tutor_probe: { answer: "ok" } } });
  await runStructuredCall(bare, {
    system: "s",
    input: "x",
    outputName: "tutor_probe",
    outputSchema: schema,
  });
  const bareParams = bare.getCalls()[0];
  check(
    "omitted options do NOT appear on params (byte-identical for existing callers)",
    !("model" in bareParams) && !("effort" in bareParams) && !("timeoutMs" in bareParams) && !("maxRetries" in bareParams)
  );
}

async function main() {
  registryShape();
  denyList();
  pricing();
  grepGuard();
  await mockEmbed();
  await mockResponseId();
  await structuredCallOptions();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
