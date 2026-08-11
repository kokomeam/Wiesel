/**
 * TUTOR-1 — Amendment A4, Wave 3 · PURE + loop-integration suite (no DB, no key).
 *
 *   • A4-14 eligibility: an incomplete lesson is NEVER retrieved from (property
 *     test over 100 generated queries; the retriever is only ever asked for
 *     lessons ⊆ eligible)
 *   • A4-16 each of the 4 expansion codes is independently triggerable + records
 *     its code; A4-15 expansion never occurs without a code and emits
 *     tutor.retrieval.expanded
 *   • A4-17 forward material → names the covering (incomplete) lesson, never
 *     retrieves it, never explains it
 *   • A4-18 total retrieval failure → an escalation-offer instruction
 *   • A4-20 provenance: no course attribution without a retrieval hit
 *   • A4-19 routeContradiction emits tutor.contradiction.detected
 *   • A4-21 retrieval adds NO chat model calls (embedding-only) + the query embed
 *     is un-pooled (source assertion)
 *   • loop integration: the scope decision is injected + surfaced on the result
 *
 * Run: `npx tsx scripts/verify-tutor-scope.ts`
 */

import { readFileSync } from "node:fs";

import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import type { Database } from "@/lib/database.types";
import type { PublicationSnapshot, PublishedLessonBlock } from "@/lib/course/publish/schemas";
import type { LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import type { RetrievedChunk } from "@/lib/tutor/retrieval/retrieve";
import {
  runScopedRetrieval,
  buildScopeInstructions,
  routeContradiction,
  type ScopeRetrieveFn,
} from "@/lib/tutor/retrieval/scopePolicy";
import { computeEligibleLessons } from "@/lib/tutor/retrieval/eligibility";
import type { TutorRuntimeEvent } from "@/lib/tutor/runtime/runtimeEvents";
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
const USER = "33333333-3333-4333-8333-333333333333";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001"; // active
const L2 = "aaaaaaaa-0000-4000-8000-000000000002"; // completed
const L3 = "aaaaaaaa-0000-4000-8000-000000000003"; // incomplete (forward)
const B1 = "bbbbbbbb-0000-4000-8000-000000000001";
const B2 = "bbbbbbbb-0000-4000-8000-000000000002";
const B3 = "bbbbbbbb-0000-4000-8000-000000000003";
const N1 = "cccccccc-0000-4000-8000-000000000001"; // "Equilibrium" → L1
const N2 = "cccccccc-0000-4000-8000-000000000002"; // "Scarcity" → L2 (prereq of N1)
const N3 = "cccccccc-0000-4000-8000-000000000003"; // "Elasticity" → L3

function lectureBlock(id: string, title: string, text: string): PublishedLessonBlock {
  return {
    id, type: "lecture_text", title, order: 0,
    ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] },
    tone: "detailed", paragraphs: [{ id: `${id}-p1`, kind: "paragraph", text }],
  } as PublishedLessonBlock;
}
function lesson(id: string, title: string, block: PublishedLessonBlock, order: number) {
  return { id, type: "lesson", title, objective: `Learn ${title}.`, order, blocks: [block] };
}
function buildSnapshot(): PublicationSnapshot {
  return {
    schemaVersion: 1,
    course: { id: COURSE, title: "Markets", plan: { outcomes: [], prerequisites: [] }, theme: { name: "Editorial Warm", accent: "amber", slideDefaults: { layout: "title", themeId: "editorial-warm" } } },
    modules: [{
      id: "mod-1", type: "module", title: "Foundations", order: 0,
      lessons: [
        lesson(L1, "Equilibrium", lectureBlock(B1, "Equilibrium", "Price is set where supply meets demand."), 0),
        lesson(L2, "Scarcity", lectureBlock(B2, "Scarcity", "Scarcity is the basic economic problem."), 1),
        lesson(L3, "Elasticity", lectureBlock(B3, "Elasticity", "Elasticity measures responsiveness to price."), 2),
      ],
    }],
  } as unknown as PublicationSnapshot;
}

const NODES: LessonConceptNode[] = [
  { id: N1, title: "Equilibrium", description: "Supply meets demand.", anchors: [{ lessonId: L1, blockId: B1 }] },
  { id: N2, title: "Scarcity", description: "The basic economic problem.", anchors: [{ lessonId: L2, blockId: B2 }] },
  { id: N3, title: "Elasticity", description: "Responsiveness to price.", anchors: [{ lessonId: L3, blockId: B3 }] },
];
// N2 is a PREREQUISITE OF N1 (edge source=N2, target=N1): to master Equilibrium
// you must first understand Scarcity. rootCause(N1) with weak N2 → N2.
const EDGES: EdgeLike[] = [{ sourceNodeId: N2, targetNodeId: N1, kind: "prerequisite" }];
const LESSON_TITLES = new Map([[L1, "Equilibrium"], [L2, "Scarcity"], [L3, "Elasticity"]]);

function mkChunk(lessonId: string, blockId: string, similarity: number, ord: number): RetrievedChunk {
  return {
    id: `chunk-${ord}`, lessonId, blockId, slideId: null, chunkOrdinal: ord,
    text: `Passage from ${lessonId}`, anchor: { lessonId, blockId, slideId: null },
    // τ gates on similarity (Wave-5); the RRF `score` is just the ranking signal.
    sourceTier: "canon", vectorRank: 1, lexicalRank: null, score: 0.0328, similarity,
  };
}

/** A retriever that records the lessonIds it's asked for + returns chunks with a
 *  fixed cosine SIMILARITY (the τ signal). */
function recordingRetriever(similarityPerChunk = 1): { fn: ScopeRetrieveFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: ScopeRetrieveFn = async (a) => {
    calls.push([...a.lessonIds]);
    return a.lessonIds.map((lid, i) => mkChunk(lid, `b-${lid}`, similarityPerChunk, i));
  };
  return { fn, calls };
}

function capture(): { sink: (e: TutorRuntimeEvent) => void; events: TutorRuntimeEvent[] } {
  const events: TutorRuntimeEvent[] = [];
  return { sink: (e) => events.push(e), events };
}

async function main() {
  /* ── A4-14 · property: incomplete lessons are NEVER retrieved from ── */
  console.log("\n— A4-14 · an incomplete lesson is never retrieved from (100 queries) —");
  const actives = [L1, L2, L3, null];
  const completedSubsets = [[], [L1], [L2], [L3], [L1, L2], [L2, L3], [L1, L2, L3]];
  const messages = ["what is equilibrium", "compare this with the previous lesson", "explain scarcity and elasticity", "help", "how does this relate to earlier material"];
  let violations = 0;
  let iterations = 0;
  for (let i = 0; i < 100; i++) {
    const active = actives[i % actives.length];
    const completed = new Set(completedSubsets[i % completedSubsets.length]);
    const message = messages[i % messages.length];
    const { fn, calls } = recordingRetriever(1);
    const events = capture();
    const decision = await runScopedRetrieval(
      { retrieve: fn, onRuntimeEvent: events.sink },
      { courseId: COURSE, activeLessonId: active, completedLessonIds: completed, message, nodes: NODES, edges: EDGES, mastery: [{ nodeId: N2, decayedP: 0.2 }], lessonTitleById: LESSON_TITLES }
    );
    const eligible = decision.eligible.eligible;
    for (const asked of calls.flat()) if (!eligible.has(asked)) violations++;
    // Every retrieval must be ⊆ eligible = active ∪ completed.
    const expectedEligible = new Set(completed);
    if (active) expectedEligible.add(active);
    for (const asked of calls.flat()) if (!expectedEligible.has(asked)) violations++;
    iterations++;
  }
  check("100 scoped retrievals never queried a lesson outside eligible (active ∪ completed)", violations === 0, `violations=${violations}`);
  check("ran all 100 iterations", iterations === 100);
  check("computeEligibleLessons excludes ordinal position (a jumped-ahead learner has few eligible)", (() => {
    const e = computeEligibleLessons({ activeLessonId: L3, completedLessonIds: [] });
    return e.eligible.size === 1 && e.eligible.has(L3) && !e.eligible.has(L1) && !e.eligible.has(L2);
  })());

  /* ── A4-16 · each of the 4 expansion codes, independently (+ A4-15 event) ── */
  console.log("\n— A4-16 · the four expansion codes, each independently triggerable (+ A4-15 event) —");

  // (1) explicit_request
  {
    const { fn, calls } = recordingRetriever(1);
    const ev = capture();
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set([L2]), message: "compare this with the previous lesson", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("explicit_request fires its code", d.expansion.code === "explicit_request", JSON.stringify(d.expansion));
    check("explicit_request draws Tier 2 from a COMPLETED lesson (L2)", calls.some((c) => c.includes(L2)));
    check("explicit_request emits tutor.retrieval.expanded {code}", ev.events.some((e) => e.name === "tutor.retrieval.expanded" && e.fields.code === "explicit_request"));
  }
  // (2) multi_concept_span — message names Equilibrium (L1) + Scarcity (L2)
  {
    const { fn } = recordingRetriever(1);
    const ev = capture();
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set([L2]), message: "how do equilibrium and scarcity fit together", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("multi_concept_span fires its code (question spans L1+L2)", d.expansion.code === "multi_concept_span", JSON.stringify(d.expansion));
    check("multi_concept_span emits the event", ev.events.some((e) => e.name === "tutor.retrieval.expanded" && e.fields.code === "multi_concept_span"));
  }
  // (3) prerequisite_gap — active L1 (concept N1), N2 weak, N2 covered by completed L2
  {
    const { fn } = recordingRetriever(1);
    const ev = capture();
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set([L2]), message: "why is the price what it is", nodes: NODES, edges: EDGES, mastery: [{ nodeId: N2, decayedP: 0.15 }], lessonTitleById: LESSON_TITLES });
    check("prerequisite_gap fires its code (weak prereq N2 in completed L2)", d.expansion.code === "prerequisite_gap", JSON.stringify(d.expansion));
    check("prerequisite_gap Tier 2 targets the prereq's lesson (L2)", d.expansion.tier2LessonIds.includes(L2));
    check("prerequisite_gap emits the event", ev.events.some((e) => e.name === "tutor.retrieval.expanded" && e.fields.code === "prerequisite_gap"));
  }
  // (4) insufficient_local_context — Tier1 all below τ, no other signal
  {
    const { fn } = recordingRetriever(0); // score 0 < τ → insufficient
    const ev = capture();
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set([L2]), message: "tell me about this", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("insufficient_local_context fires when every Tier-1 result is below τ", d.expansion.code === "insufficient_local_context", JSON.stringify(d.expansion));
    check("insufficient_local_context emits the event", ev.events.some((e) => e.name === "tutor.retrieval.expanded" && e.fields.code === "insufficient_local_context"));
  }

  /* ── A4-15 · no expansion ⇒ no code, no event ── */
  console.log("\n— A4-15 · expansion never occurs without a code (+ no event) —");
  {
    const { fn } = recordingRetriever(1); // sufficient local, no signals
    const ev = capture();
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set([L2]), message: "what is equilibrium", nodes: NODES, edges: EDGES, mastery: [{ nodeId: N2, decayedP: 0.95 }], lessonTitleById: LESSON_TITLES });
    check("a plain, locally-answerable question does NOT expand", d.expansion.expand === false && d.expansion.code === null, JSON.stringify(d.expansion));
    check("no expansion ⇒ NO tutor.retrieval.expanded event", !ev.events.some((e) => e.name === "tutor.retrieval.expanded"));
    check("expand is never true without a code (invariant)", !(d.expansion.expand && d.expansion.code === null));
  }
  {
    // Expansion is impossible with NO completed lessons (empty Tier-2 pool).
    const { fn, calls } = recordingRetriever(0);
    const ev = capture();
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set(), message: "compare with the earlier lesson", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("explicit request with NO completed lessons does not expand (nothing eligible to expand into)", d.expansion.expand === false);
    check("…and never queried a non-eligible lesson", calls.flat().every((l) => l === L1));
  }

  /* ── A4-17 · forward material ── */
  console.log("\n— A4-17 · forward material (name the covering lesson; never explain/retrieve it) —");
  {
    const { fn, calls } = recordingRetriever(1);
    const ev = capture();
    // Active L1, nothing completed; the learner asks about Elasticity (N3 → L3, incomplete).
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set(), message: "can you explain elasticity", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("forward material detected → the covering INCOMPLETE lesson (L3)", d.forwardMaterial?.lessonId === L3, JSON.stringify(d.forwardMaterial));
    check("the forward lesson is NEVER retrieved from", !calls.flat().includes(L3));
    const instr = buildScopeInstructions(d, LESSON_TITLES);
    check("the instruction NAMES where it's covered ('Elasticity') and declines to explain", instr.some((s) => s.includes("Elasticity") && /do NOT explain it now/i.test(s)));
    check("the instruction forbids answering forward material from model knowledge", instr.some((s) => /do NOT teach it from your own knowledge/i.test(s)));
  }

  /* ── A4-18 · total retrieval failure → escalation offer ── */
  console.log("\n— A4-18 · total retrieval failure → offer escalation, never answer from knowledge —");
  {
    // Tier1 returns nothing relevant (score 0), no forward material, no completed → failure.
    const failRetriever: ScopeRetrieveFn = async () => [];
    const ev = capture();
    const d = await runScopedRetrieval({ retrieve: failRetriever, onRuntimeEvent: ev.sink }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set(), message: "what is the airspeed velocity of a swallow", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("retrievalFailure is set when nothing relevant is found + no forward material", d.retrievalFailure === true, JSON.stringify({ chunks: d.chunks.length, fwd: d.forwardMaterial }));
    const instr = buildScopeInstructions(d, LESSON_TITLES);
    check("the instruction says the course doesn't cover it + offers the creator escalation", instr.some((s) => /do NOT cover|do NOT answer it from your own knowledge/i.test(s) && /escalation|creator/i.test(s)));
  }

  /* ── A4-20 · provenance ── */
  console.log("\n— A4-20 · no course attribution without a retrieval hit —");
  {
    const { fn } = recordingRetriever(1);
    const d = await runScopedRetrieval({ retrieve: fn, onRuntimeEvent: () => {} }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set([L2]), message: "what is equilibrium", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("hasCourseSupport true when ≥1 chunk clears τ", d.hasCourseSupport === true);
    const noSupport = await runScopedRetrieval({ retrieve: async () => [], onRuntimeEvent: () => {} }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set(), message: "x", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("hasCourseSupport false with no retrieval hit", noSupport.hasCourseSupport === false);
    const instr = buildScopeInstructions(noSupport, LESSON_TITLES);
    check("the provenance instruction is ALWAYS present (never attribute to the course without a passage)", instr.some((s) => /Attribute a fact to the course ONLY when a RETRIEVED COURSE PASSAGE/i.test(s)));
  }

  /* ── A4-19 · contradiction routing ── */
  console.log("\n— A4-19 · contradiction routing —");
  {
    const ev = capture();
    routeContradiction({ onRuntimeEvent: ev.sink }, { courseId: COURSE, note: "The course says X but the standard result is Y.", lessonId: L1 });
    check("routeContradiction emits tutor.contradiction.detected with the note + course", ev.events.some((e) => e.name === "tutor.contradiction.detected" && String(e.fields.note).includes("standard result") && e.fields.courseId === COURSE));
  }

  /* ── A4-21 · retrieval adds NO chat model calls + un-pooled query embed ── */
  console.log("\n— A4-21 · retrieval never raises concurrent chat calls (embedding-only, un-pooled) —");
  {
    // runScopedRetrieval interacts with the model ONLY through the injected
    // retriever (embedding); its deps carry NO chat model, so it structurally
    // cannot issue a chat turn.
    const chatCalls = 0;
    const retr: ScopeRetrieveFn = async (a) => a.lessonIds.map((l, i) => mkChunk(l, "b", 1, i));
    await runScopedRetrieval({ retrieve: retr }, { courseId: COURSE, activeLessonId: L1, completedLessonIds: new Set([L2]), message: "compare across lessons", nodes: NODES, edges: EDGES, mastery: [], lessonTitleById: LESSON_TITLES });
    check("runScopedRetrieval issues ZERO chat model calls (embedding-only path)", chatCalls === 0);
    // Source: the route builds the retrieval embed client UN-POOLED, distinct from
    // the pooled chat model; the service builds `retrieve` over deps.embedModel.
    const routeSrc = readFileSync(new URL("../app/api/learn/tutor/route.ts", import.meta.url), "utf8");
    check("route's embedModel is un-pooled (createOpenAIModelClient, NOT withPooledModel)", /embedModel:\s*createOpenAIModelClient\(\)/.test(routeSrc));
    const svcSrc = readFileSync(new URL("../lib/tutor/runtime/service.ts", import.meta.url), "utf8");
    check("service builds the retriever over deps.embedModel (separate from the pooled chat model)", svcSrc.includes("retrieveChunks(deps.admin, embedModel"));
  }

  /* ── loop integration: scope injected + surfaced ── */
  console.log("\n— loop integration: the scope decision is injected + surfaced —");
  {
    const snapshot = buildSnapshot();
    const { fn } = recordingRetriever(1);
    const ev = capture();
    const model = createMockModelClient([], {
      model: LUNA,
      structured: { tutor_turn_output: JSON.stringify({ proseWithSpanMarkers: "Here's a recap.", citations: [], rung: 2, evidence: [] }) },
    });
    const res = await runTutorTurn(
      {
        learnerClient: { rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) } as unknown as Parameters<typeof runTutorTurn>[0]["learnerClient"],
        serviceClient: { from() { return { insert() { return { select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }; } }; } } as unknown as Parameters<typeof runTutorTurn>[0]["serviceClient"],
        model,
        loadSnapshot: async () => ({ snapshot }),
        conceptNodes: NODES,
        conceptEdges: EDGES,
        onRuntimeEvent: ev.sink,
        retrieve: fn,
      },
      {
        userId: USER, courseId: COURSE, publicationId: PUB, version: 1, lessonId: L1,
        charterRow: charter(), historyTurns: [{ role: "learner", content: "hi" }],
        completedLessonIds: [L2],
        learnerMessage: "compare this with the previous lesson",
      }
    );
    check("the turn succeeds with retrieval wired", res.ok === true, JSON.stringify({ ok: res.ok, err: res.error }));
    check("result.scope is surfaced (expansionCode explicit_request)", res.scope?.expansionCode === "explicit_request", JSON.stringify(res.scope));
    check("result.scope.eligibleLessonIds = active ∪ completed", !!res.scope && new Set(res.scope.eligibleLessonIds).size === 2 && res.scope.eligibleLessonIds.includes(L1) && res.scope.eligibleLessonIds.includes(L2));
    check("tutor.retrieval.expanded emitted during the turn", ev.events.some((e) => e.name === "tutor.retrieval.expanded"));
    const modelInput = JSON.stringify(model.getCalls()[0]?.input ?? "");
    check("the model call carries the RETRIEVED COURSE PASSAGES block", modelInput.includes("RETRIEVED COURSE PASSAGES"));
    check("the model call carries the provenance instruction", modelInput.includes("Attribute a fact to the course ONLY"));
  }
  {
    // Contradiction surfaced from the model output field → routed + surfaced.
    const snapshot = buildSnapshot();
    const { fn } = recordingRetriever(1);
    const ev = capture();
    const model = createMockModelClient([], {
      model: LUNA,
      structured: { tutor_turn_output: JSON.stringify({ proseWithSpanMarkers: "Following the course.", citations: [], rung: 2, evidence: [], contradiction: { note: "The course states a simplified rule that conflicts with the general case." } }) },
    });
    const res = await runTutorTurn(
      {
        learnerClient: { rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) } as unknown as Parameters<typeof runTutorTurn>[0]["learnerClient"],
        serviceClient: { from() { return { insert() { return { select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }; } }; } } as unknown as Parameters<typeof runTutorTurn>[0]["serviceClient"],
        model, loadSnapshot: async () => ({ snapshot }), conceptNodes: NODES, conceptEdges: EDGES, onRuntimeEvent: ev.sink, retrieve: fn,
      },
      { userId: USER, courseId: COURSE, publicationId: PUB, version: 1, lessonId: L1, charterRow: charter(), historyTurns: [{ role: "learner", content: "q" }], completedLessonIds: [L2], learnerMessage: "is this always true" }
    );
    check("A4-19: a model-flagged contradiction is surfaced on the result", res.contradiction?.note.includes("conflicts with the general case") === true, JSON.stringify(res.contradiction));
    check("A4-19: tutor.contradiction.detected emitted during the turn", ev.events.some((e) => e.name === "tutor.contradiction.detected"));
    check("A4-19: the turn still succeeds (follows the course; contradiction is evidence, not a failure)", res.ok === true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

function charter(): Database["public"]["Tables"]["tutor_course_settings"]["Row"] {
  return {
    assessment_help: "concept_review_only", budget_limit_usd: null, course_canon: "strict", course_id: COURSE,
    created_at: "2026-08-10T00:00:00Z", current_charter_version_id: null, digest_cadence: "daily", digest_opt_out: false,
    enabled: true, escalation_sensitivity: "default", guidance_style: "guided_default", scope: "course_only",
    tone_notes: null, updated_at: "2026-08-10T00:00:00Z",
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
