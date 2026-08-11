/**
 * TUTOR-1 — Amendment A4, Wave 5 · τ CALIBRATION harness.
 *
 * τ (the retrieval relevance threshold that gates `insufficient_local_context`) is
 * calibrated against a labeled corpus of ≥30 questions run through the REAL hybrid
 * retrieval over a REAL embedded course (cs61b, the largest live course).
 *
 * For each corpus entry {query, activeLessonId, label}:
 *   • run Tier-1 retrieval (scoped to the active lesson) → the TOP fused RRF score
 *   • `sufficient` = the active lesson answers it (score should be ≥ τ)
 *   • `insufficient` = the active lesson does NOT answer it (score should be < τ)
 * Then sweep τ candidates and report, at each:
 *   • FALSE-expansion rate  = sufficient queries scored < τ (wrongly expand)
 *   • MISSED-expansion rate = insufficient queries scored ≥ τ (wrongly don't)
 * and pick the τ minimizing total error.
 *
 * Embeds cs61b's chunks REAL (once, ~$0.004), runs the corpus, prints the sweep,
 * then CLEANS UP the chunks (prod tutor behavior unchanged). Re-runnable on real
 * production transcripts once retrieval accumulates data.
 *
 * Run: `npx tsx scripts/calibrate-tutor-tau.ts` (needs OPENAI + service key).
 *      `npx tsx scripts/calibrate-tutor-tau.ts --mock` (structure-only, no key).
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

dns.setDefaultResultOrder("ipv4first");
const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fetch(input, init); } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); }
  }
  throw lastErr;
};

import type { Database } from "@/lib/database.types";
import { PublicationSnapshotSchema } from "@/lib/course/publish/schemas";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { embedAndStoreChunks } from "@/lib/tutor/retrieval/embedStore";
import { retrieveChunks } from "@/lib/tutor/retrieval/retrieve";

const CS61B_PUB = "e79889a5-17f3-473f-9cfa-8e49b3315fd1";
const CS61B_COURSE = "10b26d36-cc2a-41ed-b1d7-cabd2591dc9b";

// cs61b lesson ids (fetched 2026-08-11).
const L = {
  bigO: "573eafa3-7345-44b7-beba-4b7097660aa8",
  arrays: "27b96c3f-9784-4830-86a4-7607278ab860",
  linked: "4dc20dcc-2987-4a6b-bb54-089d4e5aa522",
  stacks: "1b362757-2380-4d9f-8c87-6968b446f4b9",
  bst: "768a73b4-1e86-4012-af1e-92808ab2f064",
  hashing: "926b3bea-8c48-41c2-817a-8c08849de5d4",
  heaps: "c71a07ab-978b-406c-a07a-72af63d2cfd3",
  mergesort: "1564fd47-2354-420b-ab41-0963eb5995f3",
  graphs: "e61a3255-2826-44a2-8003-ddd823896e88",
  shortest: "1f4289ac-3f6a-4381-a2ac-3d178830475a",
  balancing: "deadfe06-c185-41ec-881c-37e0b81a7faa",
  twoThree: "e7a744d5-3d4e-4769-ae0c-a54862770670",
} as const;

type Label = "sufficient" | "insufficient";
interface CorpusEntry { query: string; active: string; label: Label; }

/** ≥30 labeled questions. `sufficient` = the active lesson answers it; `insufficient`
 *  = the answer is in another lesson (active is unrelated) or off-topic. */
const CORPUS: CorpusEntry[] = [
  // ── sufficient: the active lesson answers it ──
  { query: "what is the difference between an array and an ArrayList", active: L.arrays, label: "sufficient" },
  { query: "how do I resize an array when it becomes full", active: L.arrays, label: "sufficient" },
  { query: "how does a binary search tree keep its elements ordered", active: L.bst, label: "sufficient" },
  { query: "how do you insert a new value into a binary search tree", active: L.bst, label: "sufficient" },
  { query: "what is a hash table and how does it store keys in buckets", active: L.hashing, label: "sufficient" },
  { query: "how does a hash function distribute keys across buckets", active: L.hashing, label: "sufficient" },
  { query: "how does merge sort divide and combine the list", active: L.mergesort, label: "sufficient" },
  { query: "what makes a 2-3 tree stay balanced on insertion", active: L.twoThree, label: "sufficient" },
  { query: "how are graphs represented with adjacency lists and matrices", active: L.graphs, label: "sufficient" },
  { query: "what is the difference between a stack and a queue", active: L.stacks, label: "sufficient" },
  { query: "how does a heap keep the highest priority element on top", active: L.heaps, label: "sufficient" },
  { query: "what does big-o notation measure about an algorithm", active: L.bigO, label: "sufficient" },
  { query: "how do I traverse a linked list with a current pointer", active: L.linked, label: "sufficient" },
  { query: "how does dijkstra's algorithm find the shortest path", active: L.shortest, label: "sufficient" },
  { query: "why do we need to keep a search tree balanced", active: L.balancing, label: "sufficient" },
  { query: "what is the time complexity of a hash table lookup", active: L.hashing, label: "sufficient" },

  // ── insufficient: the answer is elsewhere (active lesson is unrelated) ──
  { query: "how does dijkstra find the shortest path in a graph", active: L.arrays, label: "insufficient" },
  { query: "what happens on a hash collision and how is it handled", active: L.stacks, label: "insufficient" },
  { query: "walk me through how merge sort works step by step", active: L.graphs, label: "insufficient" },
  { query: "what is a 2-3 tree and how does it differ from a BST", active: L.linked, label: "insufficient" },
  { query: "how does a heap maintain the priority ordering", active: L.arrays, label: "insufficient" },
  { query: "which algorithm finds shortest paths from a source", active: L.hashing, label: "insufficient" },
  { query: "how do you rebalance a tree after an insertion", active: L.stacks, label: "insufficient" },
  { query: "how are adjacency lists used to represent a graph", active: L.heaps, label: "insufficient" },
  { query: "explain the mechanics of quicksort partitioning", active: L.arrays, label: "insufficient" },
  { query: "what is a priority queue and when would I use one", active: L.linked, label: "insufficient" },

  // ── insufficient: off-topic (not covered by the course at all) ──
  { query: "what is the capital of France", active: L.arrays, label: "insufficient" },
  { query: "how do I bake a sourdough loaf at home", active: L.hashing, label: "insufficient" },
  { query: "what is the meaning of life", active: L.bst, label: "insufficient" },
  { query: "who won the world cup in 2018", active: L.heaps, label: "insufficient" },
  { query: "recommend a good pizza place nearby", active: L.graphs, label: "insufficient" },
  { query: "what is the weather like tomorrow", active: L.stacks, label: "insufficient" },
];

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  // tsx does NOT auto-load .env.local — export the OpenAI env so
  // createOpenAIModelClient (which reads process.env at call time) is configured.
  if (env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  for (const k of ["OPENAI_PROXY_URL", "HTTPS_PROXY", "HTTP_PROXY", "OPENAI_TIMEOUT_MS"]) if (env[k]) process.env[k] = env[k];
  // This dev machine routes egress through Clash; the SDK's undici ignores it
  // without an explicit proxy. Default to the documented Clash port so real calls
  // don't hang on a direct-connection timeout (harmless if unset already).
  if (!process.env.OPENAI_PROXY_URL && !process.env.HTTPS_PROXY) process.env.OPENAI_PROXY_URL = "http://127.0.0.1:7890";
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY };
}

async function main() {
  const mock = process.argv.includes("--mock");
  const { url, service } = loadEnv();
  if (!url || !service) throw new Error("Missing Supabase env (need SUPABASE_SERVICE_ROLE_KEY)");
  const admin = createClient<Database>(url, service, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: retryingFetch } });

  const snapRow = await admin.from("course_publications").select("snapshot, version, content_hash").eq("id", CS61B_PUB).single();
  if (snapRow.error || !snapRow.data) throw new Error(`cs61b publication not found: ${snapRow.error?.message}`);
  const snapshot = PublicationSnapshotSchema.parse((snapRow.data as { snapshot: unknown }).snapshot);
  const embedClient = mock ? createMockModelClient([], {}) : createOpenAIModelClient();

  console.log(`# embedding cs61b chunks (${mock ? "MOCK" : "REAL"} embeddings)…`);
  try {
    const res = await embedAndStoreChunks(admin, embedClient, {
      courseId: CS61B_COURSE, publicationId: CS61B_PUB,
      version: (snapRow.data as { version: number }).version,
      contentHash: (snapRow.data as { content_hash: string }).content_hash,
      snapshot, force: true,
    });
    console.log(`# stored ${res.chunks} chunks`);

    console.log(`# running ${CORPUS.length} queries through Tier-1 retrieval…`);
    const scored: { entry: CorpusEntry; top: number }[] = [];
    for (const entry of CORPUS) {
      const chunks = await retrieveChunks(admin, embedClient, {
        publicationId: CS61B_PUB, queryText: entry.query, eligibleLessonIds: [entry.active],
        vectorLimit: 6, lexicalLimit: 6, resultLimit: 8,
      });
      // τ gates on cosine SIMILARITY (the Wave-5 finding: the RRF rank score does
      // not separate relevant from irrelevant; raw similarity does).
      const top = chunks.length > 0 ? Math.max(...chunks.map((c) => c.similarity)) : 0;
      scored.push({ entry, top });
    }

    const suff = scored.filter((s) => s.entry.label === "sufficient");
    const insuff = scored.filter((s) => s.entry.label === "insufficient");
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    console.log(`\n# top-RRF-score distribution`);
    console.log(`  sufficient   (n=${suff.length}): mean=${mean(suff.map((s) => s.top)).toFixed(4)} min=${Math.min(...suff.map((s) => s.top)).toFixed(4)} max=${Math.max(...suff.map((s) => s.top)).toFixed(4)}`);
    console.log(`  insufficient (n=${insuff.length}): mean=${mean(insuff.map((s) => s.top)).toFixed(4)} min=${Math.min(...insuff.map((s) => s.top)).toFixed(4)} max=${Math.max(...insuff.map((s) => s.top)).toFixed(4)}`);

    console.log(`\n# τ sweep (false-expansion = sufficient scored < τ; missed-expansion = insufficient scored ≥ τ)`);
    const candidates = [0.10, 0.15, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28, 0.30, 0.33, 0.36, 0.40, 0.45];
    let best = { tau: candidates[0], err: Infinity, fe: 1, me: 1 };
    for (const tau of candidates) {
      const falseExp = suff.filter((s) => s.top < tau).length / (suff.length || 1);
      const missedExp = insuff.filter((s) => s.top >= tau).length / (insuff.length || 1);
      const err = falseExp + missedExp;
      console.log(`  τ=${tau.toFixed(4)}  false-expansion=${(falseExp * 100).toFixed(1)}%  missed-expansion=${(missedExp * 100).toFixed(1)}%  total-error=${(err).toFixed(3)}`);
      if (err < best.err) best = { tau, err, fe: falseExp, me: missedExp };
    }
    console.log(`\n# CHOSEN τ = ${best.tau.toFixed(4)}  (false-expansion ${(best.fe * 100).toFixed(1)}%, missed-expansion ${(best.me * 100).toFixed(1)}%)`);
    console.log(`# set TUTOR_RETRIEVAL_TAU default = ${best.tau.toFixed(4)} in lib/tutor/retrieval/scopeConfig.ts`);
  } finally {
    console.log(`\n# cleaning up cs61b chunks (prod tutor behavior unchanged)…`);
    await admin.from("tutor_chunks").delete().eq("publication_id", CS61B_PUB);
    console.log("# done");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
