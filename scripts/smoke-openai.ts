/**
 * OpenAI transport smoke test — DIAGNOSTIC ONLY, not part of the app.
 *
 *   npm run smoke:openai            (full — Phase A waits out the ~75s direct hang)
 *   SMOKE_SKIP_A=1 npm run smoke:openai   (skip the slow direct-connection proof)
 *
 * Answers, with timings, the questions in the timeout RCA:
 *   - Can we reach api.openai.com at all from this machine WITHOUT the proxy?
 *     (Phase A — expected to hang ~75s = macOS net.inet.tcp.keepinit, because the
 *      OpenAI SDK's undici fetch ignores HTTPS_PROXY and connects directly.)
 *   - Does the SHIPPED fix work — the provider's OWN scoped proxy (from
 *     OPENAI_PROXY_URL/HTTPS_PROXY) while the global dispatcher stays DIRECT?
 *     (Phase C — proves Supabase/other fetch is untouched.)
 *
 * Needs `undici` (devDependency). Loads .env.local. No Supabase, no agent stack.
 */

import { readFileSync } from "node:fs";
import { setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { createOpenAIModelClient, resolveProxyUrl } from "@/lib/ai/providers/openai";

// ── load .env.local → process.env ──────────────────────────────────────────
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

// Single-attempt + short client timeout: don't let SDK retries multiply a
// transport timeout into minutes during the smoke test.
process.env.OPENAI_MAX_RETRIES = "0";
process.env.OPENAI_TIMEOUT_MS = process.env.OPENAI_TIMEOUT_MS || "90000";

const MODEL = process.env.SMOKE_MODEL || "gpt-5.4-mini";
const DEFAULT_DISPATCHER = getGlobalDispatcher(); // the no-proxy default

function log(o: Record<string, unknown>) {
  console.log(JSON.stringify(o));
}
async function timed<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ ok: boolean; ms: number; value?: T; err?: string }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - t0;
    log({ test: label, ok: true, ms });
    return { ok: true, ms, value };
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log({ test: label, ok: false, ms, error: err });
    return { ok: false, ms, err };
  }
}

async function rawModelsFetch(timeoutMs: number) {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return `HTTP ${res.status}`;
}

/** A tiny text call through OUR provider wrapper (the exact agent path). */
async function wrapperTinyCall() {
  const r = await createOpenAIModelClient().runTurn(
    {
      system: "You answer in one short word.",
      input: [{ role: "user", content: "Say hello." }],
      tools: [],
      model: MODEL,
      effort: "low",
      maxOutputTokens: 1000,
    },
    () => {}
  );
  if (r.finishReason === "error") throw new Error("provider returned finishReason=error");
  return r.text.slice(0, 40);
}

async function main() {
  console.log("=== OpenAI transport smoke test ===");
  const proxy = resolveProxyUrl();
  log({ env: "preflight", proxy: proxy || "(none)", model: MODEL, keyPresent: !!process.env.OPENAI_API_KEY, node: process.version });

  // ── PHASE A: direct connection, NO proxy (reproduces the ~75s hang) ──
  let a1: { ok: boolean; ms: number } = { ok: false, ms: 0 };
  if (process.env.SMOKE_SKIP_A) {
    console.log("\n--- PHASE A: skipped (SMOKE_SKIP_A) ---");
  } else {
    console.log("\n--- PHASE A: direct connection, NO proxy ---");
    setGlobalDispatcher(DEFAULT_DISPATCHER);
    a1 = await timed("A1 raw GET /v1/models (no proxy, 85s cap)", () => rawModelsFetch(85_000));
    if (!a1.ok) {
      console.log(
        `  → direct fetch failed after ${(a1.ms / 1000).toFixed(1)}s.` +
          (a1.ms > 60_000
            ? "  ~75s on a SINGLE attempt ⇒ macOS TCP keepinit (SYN unanswered)."
            : "  fast fail ⇒ connect refused/reset; either way direct is dead.")
      );
    } else {
      console.log("  → direct fetch SUCCEEDED — this machine reaches OpenAI without a proxy (root cause is elsewhere).");
    }
  }

  if (!proxy) {
    console.log("\nNo OPENAI_PROXY_URL/HTTPS_PROXY set — cannot test the proxied path. Stopping.");
    return;
  }

  // ── PHASE C: the SHIPPED fix — provider's OWN scoped proxy, global DIRECT ──
  // The global dispatcher stays default (no proxy); the provider reads the proxy
  // env and configures its OWN scoped fetch + dispatcher. Success here while the
  // global is direct proves the proxy is correctly scoped to the OpenAI client
  // (Supabase and every other fetch in the process are untouched).
  console.log(`\n--- PHASE C: provider scoped proxy via ${proxy} (global dispatcher = DIRECT) ---`);
  setGlobalDispatcher(DEFAULT_DISPATCHER);
  const c1 = await timed("C1 provider scoped-proxy tiny call", wrapperTinyCall);
  if (c1.value) console.log(`  → text: ${JSON.stringify(c1.value)} (proxy is scoped to the OpenAI client ✓)`);

  console.log("\n=== VERDICT ===");
  console.log(`A1 direct(no proxy): ${process.env.SMOKE_SKIP_A ? "skipped" : a1.ok ? "OK" : `FAILED @ ${(a1.ms / 1000).toFixed(1)}s`}`);
  console.log(`C1 scoped proxy:     ${c1.ok ? "OK" : "FAILED"}`);
  if (!process.env.SMOKE_SKIP_A && !a1.ok && c1.ok) {
    console.log("\n⇒ ROOT CAUSE CONFIRMED: direct (proxy-bypassing) connections hang; the provider's");
    console.log("  env-gated scoped proxy transport fixes it. The agent path is healthy.");
  }
}

void main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
