/**
 * TUTOR-1 concept-graph EXTRACTION live smoke — DIAGNOSTIC ONLY, never CI (W1.3).
 *
 *   npx tsx scripts/smoke-tutor-extraction.ts
 *
 * MUST pass before the first real creator-facing extraction. It seeds the tutor
 * fixture (the deterministic Microeconomics course), then runs the extraction
 * CORE with the REAL OpenAI model client + the ADMIN Supabase client — the exact
 * assembly the Inngest function uses — and prints the result: node/edge/
 * assumed-prior counts, flags, dropped edges, token usage + USD cost, and the
 * staged change-set id. Exits nonzero if the run !ok or produced ZERO nodes (a
 * live extraction that finds no concepts in a concept-rich course is a failure).
 *
 * Loads .env.local (OPENAI_API_KEY + optional OPENAI_PROXY_URL — the provider
 * routes its own proxy; nothing global is touched — and the privileged Supabase
 * key for the admin client). Uses real tokens: run sparingly.
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { withSemaphore } from "@/lib/ai/subagent";
import { runGraphExtraction } from "@/lib/tutor/graph/extraction";
import { seedTutorFixture } from "./seed-fixture-tutor";

dns.setDefaultResultOrder("ipv4first");

// ── load .env.local → process.env ──────────────────────────────────────────
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

function log(o: Record<string, unknown>) {
  console.log(JSON.stringify(o));
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !anon) {
    log({ smoke: "env", ok: false, error: "Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY" });
    process.exit(1);
  }
  if (!service) {
    log({ smoke: "env", ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY / SECRET_KEY (admin client)" });
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    log({ smoke: "env", ok: false, error: "OPENAI_API_KEY missing from .env.local" });
    process.exit(1);
  }

  // 1 — seed the deterministic fixture course (published, unlisted).
  const fx = await seedTutorFixture({ url, anon });
  log({
    smoke: "seed",
    ok: true,
    courseId: fx.courseId,
    publicationId: fx.publicationId,
    version: fx.version,
    lessons: fx.doc.modules.reduce((n, m) => n + m.lessons.length, 0),
  });

  // 2 — assemble admin client + real model, run the extraction core. runId is
  //     a fresh uuid (a real caller passes the agent_runs row id).
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const model = withSemaphore(createOpenAIModelClient());
  const runId = crypto.randomUUID();

  const t0 = Date.now();
  const result = await runGraphExtraction(
    { supabase: admin, model },
    { courseId: fx.courseId, publicationId: fx.publicationId, runId }
  );
  const ms = Date.now() - t0;

  log({
    smoke: "extraction",
    ok: result.ok,
    ms,
    alreadyPending: result.alreadyPending ?? false,
    nodeCount: result.nodeCount,
    edgeCount: result.edgeCount,
    assumedPriorCount: result.assumedPriorCount,
    droppedEdges: result.droppedEdges,
    flags: result.flags,
    changeSetId: result.changeSetId,
    findingId: result.findingId,
    checkpoint: result.checkpoint,
    usage: result.usage,
    costUsd: result.usage.costUsd,
  });

  const ok = result.ok && result.nodeCount > 0;
  log({ smoke: "done", ok, nodeCount: result.nodeCount });
  process.exit(ok ? 0 : 1);
}

void main();
