/**
 * TUTOR-1 Wave 3 (W3.5) — LIVE prompt-cache smoke — DIAGNOSTIC ONLY, never CI.
 *
 *   npx tsx scripts/smoke-tutor-cache.ts
 *
 * AC-T3.1 (re-scoped) + first-token/latency honesty. Drives `runTutorTurn`
 * DIRECTLY against the REAL pooled Luna client + a REAL hand-built snapshot (the
 * cheaper, equally-valid path per the re-scoped AC — no Supabase fixture needed):
 *
 *   • 10 turns at realistic cadence (2–8s think-time between turns — real sleeps,
 *     this smoke is MANUAL), INCLUDING one deliberate 300s gap between turns 6 and
 *     7 (the 5-minute cache-TTL probe).
 *   • Per turn print { turn, cachedTokens, inputTokens, ratio, latencyMs }.
 *     NOTE: the tutor turn is a STRUCTURED (non-streamed) call — there is no
 *     token-streaming, so there is NO honest first-token latency to report; we
 *     print total latencyMs and SAY SO plainly.
 *   • The L0/L1/L2 byte-stability STRUCTURAL assertion (assemble twice → identical).
 *   • A final table + { target: ratio ≥ 0.7 from turn 2, verdict, notes: the gap
 *     turn's ratio }.
 *
 * Exit 0 EVEN WHEN the ratio misses target (a below-target result is a WRITTEN
 * INVESTIGATION in the checkpoint, never an artificial fail); exit 1 ONLY on a
 * transport/API failure. Loads .env.local (smoke-tutor-models.ts conventions —
 * OPENAI_API_KEY + optional OPENAI_PROXY_URL; the provider routes its own proxy).
 */

import { readFileSync } from "node:fs";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import type { PublicationSnapshot, PublishedLessonBlock } from "@/lib/course/publish/schemas";
import type { Database } from "@/lib/database.types";

import { runTutorTurn } from "@/lib/tutor/runtime/loop";
import { assembleTutorPrompt } from "@/lib/tutor/runtime/promptLayers";
import { serializeCharter, resolveCharter } from "@/lib/tutor/runtime/charter";
import { assembleLessonContext, type LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import { assembleLearnerState } from "@/lib/tutor/runtime/learnerState";
import { TUTOR_MASTERY_THRESHOLD } from "@/lib/tutor/mastery/config";
import { LAYER_BUDGETS } from "@/lib/tutor/runtime/promptLayers";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import type { HistoryTurn } from "@/lib/tutor/runtime/history";
import type { TutorToolDeps } from "@/lib/tutor/runtime/tools";

// ── load .env.local → process.env (smoke-tutor-models.ts convention) ─────────
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
// Let the model client use its normal retry policy; a stuck transport reports.
process.env.OPENAI_MAX_RETRIES = process.env.OPENAI_MAX_RETRIES ?? "1";

function log(o: Record<string, unknown>) {
  console.log(JSON.stringify(o));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────── fixture ─────────────────────────────────── */

const COURSE = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const B1 = "bbbbbbbb-0000-4000-8000-000000000001";
const B2 = "bbbbbbbb-0000-4000-8000-000000000002";
const NODE_1 = "cccccccc-0000-4000-8000-000000000001";

function lectureBlock(id: string, title: string, text: string): PublishedLessonBlock {
  return {
    id,
    type: "lecture_text",
    title,
    order: 0,
    ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] },
    tone: "detailed",
    paragraphs: [{ id: `${id}-p1`, kind: "paragraph", text }],
  } as PublishedLessonBlock;
}

function buildSnapshot(): PublicationSnapshot {
  return {
    schemaVersion: 1,
    course: {
      id: COURSE,
      title: "Foundations of Microeconomics",
      plan: { outcomes: ["Understand supply and demand and market equilibrium"], prerequisites: [] },
      theme: { name: "Editorial Warm", accent: "amber", slideDefaults: { layout: "title", themeId: "editorial-warm" } },
    },
    modules: [
      {
        id: "mod-1",
        type: "module",
        title: "Markets",
        order: 0,
        lessons: [
          {
            id: L1,
            type: "lesson",
            title: "Supply and Demand",
            objective: "Explain how price emerges from supply and demand.",
            order: 0,
            blocks: [
              lectureBlock(
                B1,
                "Market equilibrium",
                "Market equilibrium is the price and quantity at which the amount buyers wish to purchase exactly equals the amount sellers wish to sell; at that price there is neither a shortage nor a surplus, so there is no pressure for the price to change."
              ),
              lectureBlock(
                B2,
                "Shortages and surpluses",
                "When the price sits below equilibrium, quantity demanded exceeds quantity supplied and a shortage pushes the price up; when the price sits above equilibrium, quantity supplied exceeds quantity demanded and a surplus pushes the price down."
              ),
            ],
          },
        ],
      },
    ],
  };
}

const CONCEPT_NODES: LessonConceptNode[] = [
  { id: NODE_1, title: "Equilibrium", description: "Where supply meets demand.", anchors: [{ lessonId: L1, blockId: B1 }] },
];
const CONCEPT_EDGES: EdgeLike[] = [];

const CHARTER_ROW: Database["public"]["Tables"]["tutor_course_settings"]["Row"] = {
  assessment_help: "concept_review_only",
  budget_limit_usd: null,
  course_canon: "strict",
  course_id: COURSE,
  created_at: "2026-08-04T00:00:00Z",
  current_charter_version_id: null,
  enabled: true,
  escalation_sensitivity: "default",
  guidance_style: "guided_default",
  scope: "course_only",
  tone_notes: null,
  updated_at: "2026-08-04T00:00:00Z",
};

/** An empty learner-scoped client (no mastery/queue rows) — the L3 block degrades
 *  to the "new" state; enough to drive the real turn. */
function emptyLearnerClient() {
  return {
    rpc: async () => ({ data: [], error: null }),
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  } as unknown as TutorToolDeps["learnerClient"];
}
function noopServiceClient() {
  return {
    from() {
      return { insert() { return { select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }; } };
    },
  } as unknown as TutorToolDeps["serviceClient"];
}

/** The 10 learner messages — a plausible tutoring conversation on equilibrium. */
const MESSAGES = [
  "I'm confused about what market equilibrium actually means.",
  "So is it just where the two curves cross on the graph?",
  "What happens if the price is set below the equilibrium price?",
  "Why does a shortage push the price up exactly?",
  "And above equilibrium — that's a surplus, right?",
  "Can you give me a concrete numeric example?",
  "Okay I'm back — remind me what a surplus does to price?",
  "How would a change in demand move the equilibrium?",
  "Does an increase in supply lower the price?",
  "Can you summarize the whole idea in two sentences?",
];

/* ─────────────────────────── byte-stability assert ───────────────────────── */

/** Assemble the L0/L1/L2 layers twice for the SAME (charter, publication, lesson)
 *  and assert byte-identity (only L3/L4/message may vary between real turns). */
function assertLayerStability(): { ok: boolean; systemLen: number; developerLen: number } {
  const snapshot = buildSnapshot();
  const charter = resolveCharter(CHARTER_ROW);
  const charterSerialized = serializeCharter(charter);
  const lessonContext = assembleLessonContext(snapshot, L1, CONCEPT_NODES, { budgetChars: LAYER_BUDGETS.l2Chars });
  const learnerState = assembleLearnerState(
    { reviewQueue: [], masteryRows: [], lessonNodeIds: [NODE_1], rootCauseNodeId: null, recentSynopsis: [] },
    { threshold: TUTOR_MASTERY_THRESHOLD, budgetChars: LAYER_BUDGETS.l3Chars }
  );
  const a = assembleTutorPrompt({ charterSerialized, lessonContext, learnerState, historyText: "", learnerMessage: "one" });
  const b = assembleTutorPrompt({ charterSerialized, lessonContext, learnerState, historyText: "", learnerMessage: "two" });
  const ok = a.system === b.system && a.developer === b.developer && a.input !== b.input;
  return { ok, systemLen: a.system.length, developerLen: a.developer.length };
}

/* ───────────────────────────────── main ─────────────────────────────────── */

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    log({ smoke: "cache", ok: false, error: "OPENAI_API_KEY missing from .env.local" });
    process.exit(1);
  }

  // L0/L1/L2 structural byte-stability (pure — never a transport concern).
  const stab = assertLayerStability();
  log({ smoke: "layer-byte-stability", ok: stab.ok, systemChars: stab.systemLen, developerChars: stab.developerLen });

  const snapshot = buildSnapshot();
  const model = withPooledModel(createOpenAIModelClient(), { pool: poolFor("learner") });

  const rows: Array<{
    turn: number;
    cachedTokens: number;
    inputTokens: number;
    ratio: number;
    latencyMs: number;
    ok: boolean;
    rung: number | null;
    gapBefore: string | null;
  }> = [];
  const history: HistoryTurn[] = [];
  let transportFailure = false;

  for (let i = 0; i < MESSAGES.length; i += 1) {
    // Realistic think-time BEFORE this turn (turns 2..10). Turn 7 (index 6) is
    // preceded by the deliberate 300s (5-minute) cache-TTL-probe gap.
    let gapNote: string | null = null;
    if (i === 6) {
      log({ smoke: "gap", note: "sleeping 300s (5-min cache-TTL probe) before turn 7" });
      await sleep(300_000);
      gapNote = "300s";
    } else if (i > 0) {
      const think = 2000 + Math.floor(Math.random() * 6000); // 2–8s
      await sleep(think);
      gapNote = `${Math.round(think / 1000)}s`;
    }

    const nowIso = new Date().toISOString();
    const t0 = Date.now();
    const res = await runTutorTurn(
      {
        learnerClient: emptyLearnerClient(),
        serviceClient: noopServiceClient(),
        model,
        loadSnapshot: async () => ({ snapshot }),
        conceptNodes: CONCEPT_NODES,
        conceptEdges: CONCEPT_EDGES,
        nowIso,
      },
      {
        userId: USER,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: CHARTER_ROW,
        historyTurns: [...history],
        learnerMessage: MESSAGES[i],
      }
    );
    const latencyMs = Date.now() - t0;

    if (res.error && (res.error === "transport_timeout" || res.error === "transport" || res.error === "model_error")) {
      transportFailure = true;
      log({ smoke: "turn", turn: i + 1, ok: false, error: res.error, latencyMs });
      break;
    }

    const inputTokens = res.usage.inputTokens;
    const cachedTokens = res.usage.cachedTokens;
    const ratio = inputTokens > 0 ? cachedTokens / inputTokens : 0;
    rows.push({ turn: i + 1, cachedTokens, inputTokens, ratio: Number(ratio.toFixed(3)), latencyMs, ok: res.ok, rung: res.rung, gapBefore: gapNote });
    log({
      smoke: "turn",
      turn: i + 1,
      gapBefore: gapNote,
      cachedTokens,
      inputTokens,
      ratio: Number(ratio.toFixed(3)),
      latencyMs,
      // NOT streamed → no honest first-token latency; total latency is what we have.
      note: "structured (non-streamed) call — latencyMs is TOTAL, not first-token",
      rung: res.rung,
      ok: res.ok,
      // Failure diagnostics — a bare ok:false is undiagnosable after the fact
      // (learned live: the first run's 10× ok:false needed a separate probe).
      ...(res.ok ? {} : { error: res.error ?? null, groundingFlags: res.groundingFlags }),
    });

    // Grow the history for the next turn (learner + assistant), carrying createdAt
    // so W3.5 session derivation runs on a REAL time series.
    history.push({ role: "learner", content: MESSAGES[i], createdAt: nowIso });
    if (res.output) {
      history.push({
        role: "assistant",
        content: res.output.prose,
        responseId: res.responseId,
        createdAt: new Date().toISOString(),
        grounding: { citations: res.output.citations, spans: res.output.spans, flags: res.groundingFlags, ...(res.sessionMarkers.length ? { sessionMarkers: res.sessionMarkers } : {}) },
      });
    }
  }

  // ── Final table + verdict. ──
  console.log("\nturn | gapBefore | inputTokens | cachedTokens | ratio | latencyMs | rung");
  console.log("-----|-----------|-------------|--------------|-------|-----------|-----");
  for (const r of rows) {
    console.log(
      `${String(r.turn).padStart(4)} | ${String(r.gapBefore ?? "-").padStart(9)} | ${String(r.inputTokens).padStart(11)} | ${String(r.cachedTokens).padStart(12)} | ${String(r.ratio).padStart(5)} | ${String(r.latencyMs).padStart(9)} | ${String(r.rung ?? "-").padStart(4)}`
    );
  }

  const fromTurn2 = rows.filter((r) => r.turn >= 2);
  const meetTarget = fromTurn2.length > 0 && fromTurn2.every((r) => r.ratio >= 0.7);
  const gapRow = rows.find((r) => r.turn === 7);
  const verdict = transportFailure ? "TRANSPORT_FAILURE" : meetTarget ? "MEETS_TARGET (ratio ≥ 0.7 from turn 2)" : "BELOW_TARGET — see investigation";

  log({
    smoke: "cache-summary",
    target: "ratio >= 0.7 from turn 2",
    verdict,
    turnsRun: rows.length,
    fromTurn2MinRatio: fromTurn2.length ? Math.min(...fromTurn2.map((r) => r.ratio)) : null,
    gapTurn7Ratio: gapRow ? gapRow.ratio : null,
    gapTurn7Note: gapRow ? "the 300s-gap turn's cache ratio (5-min TTL probe)" : "gap turn not reached",
    firstTokenLatency: "N/A — structured non-streamed call; latencyMs is total round-trip",
    layerByteStability: stab.ok,
  });

  // Exit 0 even below target (WRITTEN INVESTIGATION belongs in the checkpoint, not
  // an artificial fail); exit 1 ONLY on a transport/API failure.
  process.exit(transportFailure ? 1 : 0);
}

void main().catch((e) => {
  log({ smoke: "cache", ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  process.exit(1);
});
