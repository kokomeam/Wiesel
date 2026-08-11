/**
 * TUTOR-1 — Amendment A4, Wave 1 · PURE suite (no DB, no key).
 *
 * Covers the pure pieces of lesson-scoped threading + compaction + chain-rebuild:
 *   • compaction thresholds + fold plan + summarizer input + summary clamp
 *   • the L4 assembly (summary + windowed replay; byte-identical to serializeHistory
 *     when there is no summary)                                                 [A4-4]
 *   • the runtime-event seam (tutor.chain.rebuilt sink + default log)
 *   • the LOOP chain-rebuild: a stale previous_response_id is recovered by
 *     rebuilding the textual replay + retrying once, transparently, emitting
 *     tutor.chain.rebuilt                                                       [A4-5]
 *   • the NO-AUTO-RESET source assertion: a thread is reset ONLY from the explicit
 *     Start-fresh control — never from navigation / refresh / tab lifecycle     [A4-6]
 *
 * Run: `npx tsx scripts/verify-tutor-threading.ts`
 */

import { readFileSync } from "node:fs";

import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import type {
  ModelClient,
  ModelStreamEvent,
  ModelTurnParams,
  ModelTurnResult,
} from "@/lib/ai/modelClient";
import type { Database } from "@/lib/database.types";
import type { PublicationSnapshot, PublishedLessonBlock } from "@/lib/course/publish/schemas";
import type { LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import { serializeHistory, HISTORY_MAX_TURNS, type HistoryTurn } from "@/lib/tutor/runtime/history";
import {
  assembleReplayWithSummary,
  buildCompactionInput,
  clampSummary,
  compactionConfig,
  compactionPlan,
  shouldCompact,
  COMPACTION_SUMMARY_LABEL,
} from "@/lib/tutor/runtime/compaction";
import {
  emitTutorRuntimeEvent,
  logTutorRuntimeEvent,
  type TutorRuntimeEvent,
} from "@/lib/tutor/runtime/runtimeEvents";
import { runTutorTurn } from "@/lib/tutor/runtime/loop";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const LUNA = TUTOR_MODELS.tutor_turn.model;
const COURSE = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const B1 = "bbbbbbbb-0000-4000-8000-000000000001";
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
      title: "Intro to Markets",
      plan: { outcomes: ["Understand supply and demand"], prerequisites: [] },
      theme: { name: "Editorial Warm", accent: "amber", slideDefaults: { layout: "title", themeId: "editorial-warm" } },
    },
    modules: [
      {
        id: "mod-1",
        type: "module",
        title: "Foundations",
        order: 0,
        lessons: [
          {
            id: L1,
            type: "lesson",
            title: "Supply and Demand",
            objective: "Explain how price emerges from supply and demand.",
            order: 0,
            blocks: [lectureBlock(B1, "The market", "Price is set where supply meets demand at equilibrium.")],
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

function charterRow(): Database["public"]["Tables"]["tutor_course_settings"]["Row"] {
  return {
    assessment_help: "concept_review_only",
    budget_limit_usd: null,
    course_canon: "strict",
    course_id: COURSE,
    created_at: "2026-08-10T00:00:00Z",
    current_charter_version_id: null,
    digest_cadence: "daily",
    digest_opt_out: false,
    enabled: true,
    escalation_sensitivity: "default",
    guidance_style: "guided_default",
    scope: "course_only",
    tone_notes: null,
    updated_at: "2026-08-10T00:00:00Z",
  };
}

function emptyLearnerClient() {
  return {
    rpc: async () => ({ data: [], error: null }),
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  } as unknown as Parameters<typeof runTutorTurn>[0]["learnerClient"];
}
function stubServiceClient() {
  return {
    from() {
      return { insert() { return { select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }; } };
    },
  } as unknown as Parameters<typeof runTutorTurn>[0]["serviceClient"];
}

/** A valid tutor_turn_output JSON string (short uncited prose → not flagged). */
function turnOutputJson(prose = "Sure — here's a quick recap."): string {
  return JSON.stringify({ proseWithSpanMarkers: prose, citations: [], rung: 2, evidence: [] });
}

/** A model that ERRORS (model_error) whenever it receives a previous_response_id
 *  (a stale/rejected chain anchor), and otherwise returns the structured turn.
 *  Records every call so a test can assert the retry dropped the chain. */
function errorOnChainMock(): ModelClient & { calls: ModelTurnParams[] } {
  const calls: ModelTurnParams[] = [];
  const client: ModelClient & { calls: ModelTurnParams[] } = {
    model: LUNA,
    calls,
    async runTurn(params: ModelTurnParams, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurnResult> {
      calls.push(params);
      const responseId = `mock-${calls.length}`;
      onEvent({ type: "started", responseId });
      if (params.previousResponseId) {
        onEvent({ type: "error", message: "previous response not found", kind: "model_error" });
        return { text: "", toolCalls: [], finishReason: "error", errorKind: "model_error", responseId };
      }
      const text = turnOutputJson();
      for (const chunk of text.match(/\S+\s*/g) ?? []) onEvent({ type: "text_delta", delta: chunk });
      return { text, toolCalls: [], finishReason: "stop", responseId };
    },
  } as ModelClient & { calls: ModelTurnParams[] };
  return client;
}

/* ─────────────────────────────── the suite ──────────────────────────────── */

function turns(n: number, contentLen = 20): HistoryTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    role: i % 2 === 0 ? "learner" : "assistant",
    content: "x".repeat(contentLen) + i,
  }));
}

async function main() {
  /* ── compaction thresholds + plan ── */
  console.log("\n— compaction thresholds + fold plan (A4-4) —");
  const cfg = { turnThreshold: 24, charThreshold: 24_000, keepRecent: 12, summaryMaxChars: 2_000 };

  check("no compaction below the keep window", !shouldCompact({ totalTurns: 10, totalChars: 100, compactedThroughTurn: 0 }, cfg));
  check(
    "no compaction between keepRecent and the turn threshold (nothing over the window yet past cursor)",
    !shouldCompact({ totalTurns: 20, totalChars: 100, compactedThroughTurn: 8 }, cfg),
    "20-8-12 = 0 eligible",
  );
  check("compacts at the turn threshold with an eligible fold range", shouldCompact({ totalTurns: 30, totalChars: 100, compactedThroughTurn: 0 }, cfg));
  check("compacts on the CHAR trigger even below the turn threshold", shouldCompact({ totalTurns: 16, totalChars: 30_000, compactedThroughTurn: 0 }, cfg));
  check("does NOT re-compact once folded up to the window", !shouldCompact({ totalTurns: 30, totalChars: 100, compactedThroughTurn: 18 }, cfg), "30-18-12=0");

  const plan = compactionPlan({ totalTurns: 30, totalChars: 0, compactedThroughTurn: 4 }, cfg);
  check("fold plan folds [cursor, total-keepRecent)", plan?.foldFrom === 4 && plan?.foldTo === 18, JSON.stringify(plan));
  check("fold plan is null when nothing new is eligible", compactionPlan({ totalTurns: 20, totalChars: 0, compactedThroughTurn: 8 }, cfg) === null);

  check("compactionConfig reads env defaults", compactionConfig().keepRecent === HISTORY_MAX_TURNS);

  /* ── summarizer input + clamp ── */
  console.log("\n— summarizer input + clamp —");
  const input = buildCompactionInput({ existingSummary: "prior notes", foldedTurns: turns(3), summaryMaxChars: 2000 });
  check("compaction input carries the prior summary", input.includes("prior notes"));
  check("compaction input renders folded turns oldest-first", input.includes("Learner:") && input.includes("Tutor:"));
  check("compaction input states the length cap", input.includes("2000"));
  check("clampSummary passes a short summary through", clampSummary("short", 2000) === "short");
  check("clampSummary truncates + ellipsizes an over-cap summary", (() => { const c = clampSummary("y".repeat(50), 10); return c.length === 10 && c.endsWith("…"); })());

  /* ── L4 assembly (A4-4) ── */
  console.log("\n— L4 replay assembly (A4-4) —");
  const recent = turns(6, 15);
  check(
    "no summary ⇒ byte-identical to serializeHistory (pre-A4 unchanged)",
    assembleReplayWithSummary(recent, null, 8000) === serializeHistory(recent, 8000),
  );
  const withSummary = assembleReplayWithSummary(recent, "the learner asked about equilibrium earlier", 8000);
  check("summary is prepended under the labeled block", withSummary.startsWith(COMPACTION_SUMMARY_LABEL));
  check("summary block precedes the verbatim replay", withSummary.indexOf("equilibrium earlier") < withSummary.indexOf("Learner:"));
  check("verbatim recent turns still present after the summary", withSummary.includes(recent[recent.length - 1].content));
  // The FOLD-OUT invariant: the model's window shows only recent turns; a folded
  // (older) turn's content is NOT in the replay window, though the summary stands.
  const longThread = turns(30, 12);
  const windowed = assembleReplayWithSummary(longThread, "summary of the first 18 turns", 8000);
  check(
    "an old (folded) turn is NOT in the model's window while the summary is",
    !windowed.includes(longThread[0].content) && windowed.includes("summary of the first 18 turns"),
    "oldest turn must fall outside the 12-turn window",
  );

  /* ── runtime-event seam ── */
  console.log("\n— runtime-event seam —");
  const captured: TutorRuntimeEvent[] = [];
  emitTutorRuntimeEvent({ name: "tutor.chain.rebuilt", fields: { reason: "model_error" } }, (e) => captured.push(e));
  check("emitTutorRuntimeEvent forwards to the sink", captured.length === 1 && captured[0].name === "tutor.chain.rebuilt");
  check("a throwing sink is swallowed", (() => { try { emitTutorRuntimeEvent({ name: "tutor.chain.rebuilt", fields: {} }, () => { throw new Error("boom"); }); return true; } catch { return false; } })());
  check("logTutorRuntimeEvent never throws", (() => { try { logTutorRuntimeEvent({ name: "tutor.retrieval.expanded", fields: { code: "x" } }); return true; } catch { return false; } })());

  /* ── chain rebuild through the loop (A4-5) ── */
  console.log("\n— chain rebuild through the loop (A4-5) —");
  const prevChaining = process.env.TUTOR_ENABLE_CHAINING;
  process.env.TUTOR_ENABLE_CHAINING = "true"; // turn chaining ON so a stale anchor is sent
  try {
    const model = errorOnChainMock();
    const events: TutorRuntimeEvent[] = [];
    const snapshot = buildSnapshot();
    const res = await runTutorTurn(
      {
        learnerClient: emptyLearnerClient(),
        serviceClient: stubServiceClient(),
        model,
        loadSnapshot: async () => ({ snapshot }),
        conceptNodes: CONCEPT_NODES,
        conceptEdges: CONCEPT_EDGES,
        onRuntimeEvent: (e) => events.push(e),
      },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: charterRow(),
        // A prior assistant turn with a stored response id → collapseToChaining
        // returns it → the first call carries previous_response_id.
        historyTurns: [
          { role: "learner", content: "earlier question" },
          { role: "assistant", content: "earlier answer", responseId: "resp-stale" },
        ],
        learnerMessage: "follow-up question",
      },
    );
    check("the turn SUCCEEDS despite the stale chain anchor", res.ok === true, JSON.stringify({ ok: res.ok, err: res.error }));
    check("chainRebuilt is stamped with the rejection reason", res.chainRebuilt?.reason === "model_error", JSON.stringify(res.chainRebuilt));
    check("tutor.chain.rebuilt was emitted with the reason", events.some((e) => e.name === "tutor.chain.rebuilt" && e.fields.reason === "model_error"));
    check("the FIRST call sent previous_response_id (the stale anchor)", model.calls[0]?.previousResponseId === "resp-stale");
    check("the RETRY dropped the chain anchor", model.calls.length >= 2 && model.calls[1]?.previousResponseId === undefined, `calls=${model.calls.length}`);
    check(
      "the retry re-materialized the textual replay (chained path had dropped it)",
      typeof model.calls[1]?.input !== "string" &&
        JSON.stringify(model.calls[1]?.input ?? "").includes("earlier answer"),
    );
  } finally {
    if (prevChaining === undefined) delete process.env.TUTOR_ENABLE_CHAINING;
    else process.env.TUTOR_ENABLE_CHAINING = prevChaining;
  }

  /* ── no-auto-reset source assertion (A4-6) ── */
  console.log("\n— no auto-reset on navigation / refresh / tab lifecycle (A4-6) —");
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const stream = read("lib/learn/useTutorStream.ts");
  const body = read("components/learn/tutor/TutorBody.tsx");
  const mount = read("components/learn/tutor/TutorMount.tsx");
  const frame = read("components/learn/tutor/TutorFrame.tsx");

  const archiveCount = (s: string) => (s.match(/archive_thread/g) ?? []).length;
  check("the archive_thread action lives ONLY in useTutorStream (startFresh)", archiveCount(stream) === 1);
  check("no archive_thread in TutorBody / TutorMount / TutorFrame", archiveCount(body) === 0 && archiveCount(mount) === 0 && archiveCount(frame) === 0);
  check(
    "NO tab-lifecycle listener exists in the tutor client (beforeunload/pagehide/unload/visibilitychange)",
    !/beforeunload|pagehide|\bunload\b|visibilitychange/.test(stream + body + mount + frame),
  );
  check("Start fresh is wired to an explicit onClick (the ONLY reset path)", body.includes("onClick={startFresh}"));
  check(
    "startFresh is NOT invoked from a useEffect / cleanup in TutorBody",
    // Negated classes ([^)] / [^}]) already span newlines — no dotAll flag needed.
    !/useEffect\([^)]*startFresh|return\s*\(\)\s*=>\s*\{[^}]*startFresh/.test(body),
  );

  /* ── done ── */
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
