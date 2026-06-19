/**
 * OpenAI transport smoke test — DIAGNOSTIC ONLY, not part of the app.
 *
 *   npx tsx scripts/smoke-openai.ts
 *
 * Answers, with timings, the questions in the timeout RCA:
 *   - Can we reach api.openai.com at all from this machine WITHOUT the proxy?
 *     (Phase A — expected to hang ~75s = macOS net.inet.tcp.keepinit, because the
 *      OpenAI SDK's undici fetch ignores HTTPS_PROXY and connects directly.)
 *   - Does routing through the local Clash proxy fix it? (Phase B.)
 *   - Does our PROVIDER WRAPPER itself work once the transport is fixed?
 *     (tiny text · structured JSON @ gpt-5.4-mini/low · background create+poll)
 *
 * Needs `undici` (temp devDependency) for the ProxyAgent. Loads .env.local.
 * No Supabase, no agent stack — pure transport + provider-wrapper isolation.
 */

import { readFileSync } from "node:fs";
import { setGlobalDispatcher, getGlobalDispatcher, ProxyAgent } from "undici";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";

// ── load .env.local → process.env ──────────────────────────────────────────
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

// Single-attempt: don't let SDK retries multiply a transport timeout into minutes
// during the smoke test. (Successful calls are unaffected.)
process.env.OPENAI_MAX_RETRIES = "0";

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const MODEL = "gpt-5.4-mini"; // same as module planning — NOT gpt-5.5
const DEFAULT_DISPATCHER = getGlobalDispatcher(); // the no-proxy default, for Phase C

function log(o: Record<string, unknown>) {
  console.log(JSON.stringify(o));
}
async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; err?: string }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - t0;
    log({ test: label, ok: true, ms, result: "success" });
    return { ok: true, ms, value };
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log({ test: label, ok: false, ms, error: err });
    return { ok: false, ms, err };
  }
}

// A tiny structured-output schema (strict) — mirrors the shape a plan call forces.
const TINY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

async function rawModelsFetch(timeoutMs: number) {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return `HTTP ${res.status}`;
}

async function main() {
  console.log("=== OpenAI transport smoke test ===");
  log({ env: "preflight", proxy: PROXY || "(none)", model: MODEL, keyPresent: !!process.env.OPENAI_API_KEY, node: process.version });

  // ── PHASE A: NO proxy (reproduce the production-style direct connection) ──
  // This is how the shipped provider connects today: undici ignores HTTPS_PROXY.
  // Skippable (SMOKE_SKIP_A=1) once proven — it intentionally waits out the ~75s.
  let a1: { ok: boolean; ms: number } = { ok: false, ms: 0 };
  if (process.env.SMOKE_SKIP_A) {
    console.log("\n--- PHASE A: skipped (SMOKE_SKIP_A) ---");
  } else {
  console.log("\n--- PHASE A: direct connection, NO proxy (reproduces the ~75s hang) ---");
  setGlobalDispatcher(DEFAULT_DISPATCHER); // ensure default agent (no proxy)
  a1 = await timed("A1 raw GET /v1/models (no proxy, 85s cap)", () => rawModelsFetch(85_000));
  if (!a1.ok) {
    console.log(`  → direct fetch failed after ${(a1.ms / 1000).toFixed(1)}s.` +
      (a1.ms > 60_000
        ? "  ~75s on a SINGLE attempt ⇒ macOS TCP keepinit (SYN unanswered)."
        : "  fast fail ⇒ undici connectTimeout; the agent's ~75s is then retries×backoff."));
  } else {
    console.log("  → direct fetch SUCCEEDED — this machine reaches OpenAI without a proxy (root cause is elsewhere).");
  }

  // A2 — the EXACT agent path: our provider wrapper, no proxy, with SDK retries.
  // Reproduces the user's ~76s `transport_timeout`. (Skipped if A1 already proved
  // the direct path is dead and you want to save the wait — keep it for fidelity.)
  const a2 = await timed("A2 wrapper tiny call (no proxy — reproduces the agent failure)", async () => {
    const r = await createOpenAIModelClient().runTurn(
      { system: "Say hi.", input: [{ role: "user", content: "hi" }], tools: [], model: MODEL, effort: "low", maxOutputTokens: 500, stream: false, timeoutMs: 90_000 },
      () => {}
    );
    return { finishReason: r.finishReason, errorKind: r.errorKind };
  });
  if (a2.value) console.log(`  → wrapper returned: ${JSON.stringify(a2.value)} after ${(a2.ms / 1000).toFixed(1)}s`);
  }

  if (!PROXY) {
    console.log("\nNo HTTPS_PROXY set — cannot test the proxied path. Stopping.");
    return;
  }

  // ── PHASE B: route everything through the Clash proxy ──
  console.log(`\n--- PHASE B: routed through proxy ${PROXY} ---`);
  setGlobalDispatcher(new ProxyAgent(PROXY));

  await timed("B1 raw GET /v1/models (proxied)", () => rawModelsFetch(30_000));

  const client = createOpenAIModelClient();

  // B2 — tiny NON-STREAMING text call through OUR provider wrapper.
  const b2 = await timed("B2 wrapper tiny text (non-streaming, gpt-5.4-mini/low)", async () => {
    const r = await client.runTurn(
      { system: "You answer in one short word.", input: [{ role: "user", content: "Say hello." }], tools: [], model: MODEL, effort: "low", maxOutputTokens: 1000, stream: false, timeoutMs: 60_000 },
      () => {}
    );
    if (r.finishReason === "error") throw new Error(`provider error: ${r.errorKind}`);
    return r.text.slice(0, 40);
  });
  if (b2.value) console.log(`  → text: ${JSON.stringify(b2.value)}`);

  // B3 — STRUCTURED JSON call (exactly the module-plan shape: low effort + json_schema).
  const b3 = await timed("B3 wrapper structured JSON (gpt-5.4-mini/low, json_schema)", async () => {
    const r = await client.runTurn(
      {
        system: "Reply with JSON only.",
        input: [{ role: "user", content: "Put the word 'ready' in the answer field." }],
        tools: [],
        model: MODEL,
        effort: "low",
        maxOutputTokens: 2000,
        stream: false,
        timeoutMs: 60_000,
        responseFormat: { name: "tiny", schema: TINY_SCHEMA },
      },
      () => {}
    );
    if (r.finishReason === "error") throw new Error(`provider error: ${r.errorKind}`);
    JSON.parse(r.text); // must be valid JSON
    return r.text.slice(0, 80);
  });
  if (b3.value) console.log(`  → json: ${b3.value}`);

  // B4 — BACKGROUND create + poll through the wrapper (the module-fallback path).
  const b4 = await timed("B4 wrapper background create+poll (gpt-5.4-mini/low)", async () => {
    const r = await client.runTurn(
      {
        system: "Reply with JSON only.",
        input: [{ role: "user", content: "Put the word 'bg' in the answer field." }],
        tools: [],
        model: MODEL,
        effort: "low",
        maxOutputTokens: 2000,
        background: true,
        timeoutMs: 120_000,
        responseFormat: { name: "tiny", schema: TINY_SCHEMA },
      },
      () => {}
    );
    if (r.finishReason === "error") throw new Error(`provider error: ${r.errorKind}`);
    return r.text.slice(0, 80);
  });
  if (b4.value) console.log(`  → json: ${b4.value}`);

  // ── PHASE C: the SHIPPED fix — provider's OWN scoped proxy, global is DIRECT ──
  // Restore the default (no-proxy) GLOBAL dispatcher, then let the provider read
  // the proxy env and configure its OWN scoped fetchOptions.dispatcher. If this
  // call succeeds while the global dispatcher is direct, the proxy is correctly
  // scoped to the OpenAI client (Supabase/other fetch untouched).
  console.log("\n--- PHASE C: provider scoped proxy (global dispatcher = DIRECT) ---");
  setGlobalDispatcher(DEFAULT_DISPATCHER);
  const c1 = await timed("C1 provider scoped proxy (no global proxy) tiny call", async () => {
    const r = await createOpenAIModelClient().runTurn(
      { system: "Say hi.", input: [{ role: "user", content: "hi" }], tools: [], model: MODEL, effort: "low", maxOutputTokens: 500, stream: false, timeoutMs: 30_000 },
      () => {}
    );
    if (r.finishReason === "error") throw new Error(`provider error: ${r.errorKind}`);
    return r.text.slice(0, 40);
  });
  if (c1.value) console.log(`  → text: ${JSON.stringify(c1.value)} (proxy is scoped to the OpenAI client ✓)`);

  console.log("\n=== VERDICT ===");
  console.log(`A1 direct(no proxy): ${process.env.SMOKE_SKIP_A ? "skipped" : a1.ok ? "OK" : `FAILED @ ${(a1.ms / 1000).toFixed(1)}s`}`);
  console.log(`B2 wrapper text:     ${b2.ok ? "OK" : "FAILED"}`);
  console.log(`B3 wrapper struct:   ${b3.ok ? "OK" : "FAILED"}`);
  console.log(`B4 wrapper bg:       ${b4.ok ? "OK" : "FAILED"}`);
  console.log(`C1 scoped proxy:     ${c1.ok ? "OK" : "FAILED"}`);
  if (!process.env.SMOKE_SKIP_A && !a1.ok && b2.ok) {
    console.log("\n⇒ ROOT CAUSE CONFIRMED: the wrapper/agent is fine. Direct (proxy-bypassing) connections");
    console.log("  hang at the OS TCP-connect timeout (~75s); routing the OpenAI client through the");
    console.log("  Clash proxy fixes it. Fix = env-gated proxy dispatcher in providers/openai.ts.");
  }
}

void main().catch((e) => { console.error("FATAL", e); process.exit(1); });
