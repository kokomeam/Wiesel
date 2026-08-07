/**
 * TUTOR-1 Wave 3 (package C2) — the LIVE tutor runtime PURE suite (no key, no DB,
 * no browser). Drives the FIVE tools + the bounded tool loop + prompt assembly +
 * scaffolding + grounding over a hand-built snapshot fixture, with the mock
 * ModelClient's scripted/structured seam. Sections:
 *
 *   AC-T3.2  Prompt assembly — two DIFFERENT learners on the SAME (publication,
 *            lesson, charter) share BYTE-IDENTICAL system + developer; only the
 *            input (L3/L4/message) differs. TUTOR_L0 ≥ 4096 chars;
 *            TUTOR_PROMPT_VERSION === "tutor-v4" (A3 Wave 4: the tools bump —
 *            renderStructure / checkUnderstanding / sequenceTask in YOUR TOOLS +
 *            the FORMATTING ASCII ban now routes to renderStructure).
 *   A3-12/   Wave 4 — renderStructure survives a question turn (structures pass
 *   13/15/24 through, assessments forced []); checkUnderstanding schema rejects a
 *            missing-misconception distractor + a keyless item; sequenceTask
 *            permutation gate; the pure scoreSequence matrix; a malformed spec
 *            drops-and-flags (never throws); a downgraded checkUnderstanding on a
 *            question turn → an invitation naming checkUnderstanding; the R-2
 *            store:true chaining seam on the MAIN turn.
 *   A3-6..11 Invocation policy (Wave 3) — the seeded PROPERTY run (question
 *            turns NEVER retain practiceItems; ≤1 invitation; cooldown/A3-9
 *            guards), downgrade-to-invitation (pure + loop-level non-execution),
 *            the practice-request regex matrix, acceptance validation
 *            (fail-toward-question), and deriveInvitationState (offer/ignore/
 *            accept/reset counting, the 30-min window, immediately-prior-only).
 *   A3/D-6   Grounding ok-rule — a short citation-less turn (a greeting) is ok;
 *            only SUBSTANTIVE (>200 chars) citation-less prose without an
 *            escalation proposal flags `ungrounded`; the escalation escape;
 *            span_parse_error still fails ok (unchanged).
 *   A3/D-3   Citation dedup by jump-target identity (order-preserving) — incl.
 *            the downgrade-manufactured duplicate collapse.
 *   A3/D-6   Replay framing — the frozen dangling-question marker on unanswered
 *            learner lines; the ==-delimited per-turn input (byte-exact).
 *   AC-T3.3/ Scaffolding — applyScaffolding opening-turn clamps per style;
 *   AC-T3.4  detectJustShowMe positives/negatives; "just show me" forces rung 4
 *            in ALL THREE styles through a full runTutorTurn.
 *   AC-T3.5  Grounding — 20 scripted turns whose citations all resolve (flags
 *            empty); one unanswerable-question turn (escalation + zero citations
 *            → ok, no fabricated-citation flags); canon strict strips a ⟦s⟧ span
 *            (supplemental_suppressed, prose lacks the span text); canon open
 *            keeps it.
 *   AC-T3.6  Tools — TUTOR_TOOL_NAMES is exactly the five (order-insensitive);
 *            every tool's zod → toStrictJsonSchema without throw; emit_evidence
 *            with a capturing stub writes ZERO; propose_escalation inserts exactly
 *            one consent_pending-shaped row; generate_practice mints uuid refs +
 *            itemBankRef null + nodeId tags; a tool loop (get_lesson_context then
 *            answer) → toolTrace length 1 + a validated final output.
 *   HISTORY  13 turns → 12 (cap); budget drop-oldest.
 *   CHAINING off by default; collapse when TUTOR_ENABLE_CHAINING is flipped.
 *   GROUNDING span round-trip incl. span_parse_error on an unclosed marker.
 *
 * Run: `npx tsx scripts/verify-tutor-runtime.ts`
 */

// Deterministic env BEFORE any tutor import reads it.
delete process.env.TUTOR_ENABLE_CHAINING;

import { z } from "zod";
import { createMockModelClient, type MockTurn } from "@/lib/ai/providers/mock";
import type {
  ModelClient,
  ModelStreamEvent,
  ModelTurnParams,
  ModelTurnResult,
} from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import type { PublicationSnapshot, PublishedLessonBlock } from "@/lib/course/publish/schemas";
import type { Database } from "@/lib/database.types";

import {
  TUTOR_TOOL_NAMES,
  TUTOR_TOOLS,
  type TutorToolDeps,
  type MintedPracticeItem,
} from "@/lib/tutor/runtime/tools";
import { runTutorTurn } from "@/lib/tutor/runtime/loop";
import { TUTOR_TOOL_TIERS, tierOf } from "@/lib/tutor/runtime/toolTiers";
import {
  assembleTutorPrompt,
  TUTOR_L0,
  TUTOR_PROMPT_VERSION,
  LAYER_BUDGETS,
} from "@/lib/tutor/runtime/promptLayers";
import { serializeCharter, resolveCharter, type GuidanceStyle } from "@/lib/tutor/runtime/charter";
import { assembleLessonContext, type LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import { assembleLearnerState } from "@/lib/tutor/runtime/learnerState";
import {
  applyScaffolding,
  detectJustShowMe,
  resolveRungPolicy,
} from "@/lib/tutor/runtime/scaffolding";
import { buildSnapshotIndex, parseSpans, validateTurnOutput } from "@/lib/tutor/runtime/grounding";
import {
  serializeHistory,
  collapseToChaining,
  DANGLING_LEARNER_MARKER,
  type HistoryTurn,
} from "@/lib/tutor/runtime/history";
import { TUTOR_MASTERY_THRESHOLD } from "@/lib/tutor/mastery/config";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import {
  GROUNDED_OPEN,
  GROUNDED_CLOSE,
  SUPPLEMENTAL_OPEN,
  SUPPLEMENTAL_CLOSE,
  TurnOutputSchema,
  type TurnOutput,
  type TurnPracticeItem,
} from "@/lib/tutor/runtime/outputContract";
import {
  applyInvocationPolicy,
  deriveInvitationState,
  detectPracticeRequest,
  effectiveCooldown,
  invitationToolForRung,
  resolveInitiation,
  CLASS_A_TOOL_NAMES,
  INVITATION_COOLDOWN_IGNORES,
  INVITATION_LABELS,
  RUNG_INVITATION_TOOLS,
  type TurnInvitation,
} from "@/lib/tutor/runtime/invocationPolicy";
import type { SessionTurn } from "@/lib/tutor/runtime/session";
import {
  A3_WAVE4_TOOLS,
  scoreSequence,
  type AssessmentCard,
  type CheckUnderstandingCard,
  type RenderStructureCard,
  type SequenceTaskCard,
} from "@/lib/tutor/runtime/toolsA3";

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

/* ─────────────────────────────── fixture ids ────────────────────────────── */

/** The mock model NAME is cosmetic for these tests (routing is unaffected); we
 *  source it from TUTOR_MODELS so the model-literal drift guard (verify-tutor-
 *  models.ts) stays satisfied — model ids live only in modelConfig.ts. */
const LUNA = TUTOR_MODELS.tutor_turn.model;

const COURSE = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const B1 = "bbbbbbbb-0000-4000-8000-000000000001"; // lesson-1 lecture block
const B2 = "bbbbbbbb-0000-4000-8000-000000000002"; // lesson-2 lecture block
const NODE_1 = "cccccccc-0000-4000-8000-000000000001";
const NODE_2 = "cccccccc-0000-4000-8000-000000000002";

/* ─────────────────────────────── fixtures ───────────────────────────────── */

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
      theme: {
        name: "Editorial Warm",
        accent: "amber",
        slideDefaults: { layout: "title", themeId: "editorial-warm" },
      },
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
          {
            id: L2,
            type: "lesson",
            title: "Elasticity",
            objective: "Explain elasticity of demand.",
            order: 1,
            blocks: [lectureBlock(B2, "Elasticity", "Demand elasticity measures responsiveness to a price change.")],
          },
        ],
      },
    ],
  };
}

const CONCEPT_NODES: LessonConceptNode[] = [
  { id: NODE_1, title: "Equilibrium", description: "Where supply meets demand.", anchors: [{ lessonId: L1, blockId: B1 }] },
  { id: NODE_2, title: "Elasticity", description: "Responsiveness to price.", anchors: [{ lessonId: L2, blockId: B2 }] },
];

const CONCEPT_EDGES: EdgeLike[] = [
  { sourceNodeId: NODE_1, targetNodeId: NODE_2, kind: "prerequisite" },
];

const CHARTER_ROW = (
  style: GuidanceStyle,
  canon: "strict" | "open" = "strict"
): Database["public"]["Tables"]["tutor_course_settings"]["Row"] => ({
  assessment_help: "concept_review_only",
  budget_limit_usd: null,
  course_canon: canon,
  course_id: COURSE,
  created_at: "2026-08-04T00:00:00Z",
  current_charter_version_id: null,
  digest_cadence: "daily",
  digest_opt_out: false,
  enabled: true,
  escalation_sensitivity: "default",
  guidance_style: style,
  scope: "course_only",
  tone_notes: null,
  updated_at: "2026-08-04T00:00:00Z",
});

/* ──────────────── stub Supabase clients (capturing / degrading) ──────────── */

/** A learner-scoped stub that returns EMPTY reads (no mastery/queue) — the L3
 *  block degrades to the "new" state; enough to exercise the loop deterministically. */
function emptyLearnerClient() {
  return {
    rpc: async () => ({ data: [], error: null }),
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
    }),
  } as unknown as TutorToolDeps["learnerClient"];
}

/** A capturing service-role stub: records every insert; returns a fixed id. */
function capturingServiceClient() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return {
            select: () => ({ single: async () => ({ data: { id: "escalation-id-1" }, error: null }) }),
          };
        },
      };
    },
  } as unknown as TutorToolDeps["serviceClient"];
  return { client, inserts };
}

function baseToolDeps(overrides: Partial<TutorToolDeps> = {}): TutorToolDeps {
  const snapshot = buildSnapshot();
  return {
    learnerClient: emptyLearnerClient(),
    serviceClient: capturingServiceClient().client,
    snapshot,
    snapshotIndex: buildSnapshotIndex(snapshot),
    conceptNodes: CONCEPT_NODES,
    conceptEdges: CONCEPT_EDGES,
    charter: resolveCharter(CHARTER_ROW("guided_default")),
    ctx: { userId: USER_A, courseId: COURSE, publicationId: PUB, version: 1, lessonId: L1 },
    model: createMockModelClient([], { model: LUNA }),
    ...overrides,
  };
}

/** A structured turn-output JSON string for the mock's `structured` map. */
function turnOutputJson(o: Partial<TurnOutput>): string {
  const full: TurnOutput = {
    proseWithSpanMarkers: o.proseWithSpanMarkers ?? "Let me help.",
    citations: o.citations ?? [],
    rung: o.rung ?? 2,
    evidence: o.evidence ?? [],
    practiceItems: o.practiceItems,
    escalationProposal: o.escalationProposal ?? null,
  };
  return JSON.stringify(full);
}

/** Build a loop `deps` bound to a mock whose tutor_turn_output is a fixed struct
 *  (no tools requested). loadSnapshot is injected so no DB is touched. */
function loopDepsWithStructured(
  turnOutput: Partial<TurnOutput>,
  extraStructured: Record<string, unknown> = {}
) {
  const snapshot = buildSnapshot();
  const model = createMockModelClient([], {
    model: LUNA,
    structured: { tutor_turn_output: turnOutputJson(turnOutput), ...extraStructured },
  });
  return {
    deps: {
      learnerClient: emptyLearnerClient(),
      serviceClient: capturingServiceClient().client,
      model,
      loadSnapshot: async () => ({ snapshot }),
      conceptNodes: CONCEPT_NODES,
      conceptEdges: CONCEPT_EDGES,
    },
    model,
  };
}

/* ───────────────────────────────── main ─────────────────────────────────── */

async function main() {
  /* ───────────────────────── AC-T3.2 · prompt assembly ─────────────────── */
  console.log("\n— AC-T3.2 prompt assembly (byte-stable prefix) —");

  const snapshot = buildSnapshot();
  const charter = resolveCharter(CHARTER_ROW("guided_default"));
  const charterSerialized = serializeCharter(charter);
  const lessonContext = assembleLessonContext(snapshot, L1, CONCEPT_NODES, { budgetChars: LAYER_BUDGETS.l2Chars });

  // Two different learners → different L3.
  const stateA = assembleLearnerState(
    {
      reviewQueue: [{ nodeId: NODE_1, title: "Equilibrium", rank: 1 }],
      masteryRows: [{ nodeId: NODE_1, title: "Equilibrium", decayedP: 0.3 }],
      lessonNodeIds: [NODE_1],
      rootCauseNodeId: null,
      recentSynopsis: ["L: what is equilibrium"],
    },
    { threshold: TUTOR_MASTERY_THRESHOLD, budgetChars: LAYER_BUDGETS.l3Chars }
  );
  const stateB = assembleLearnerState(
    {
      reviewQueue: [{ nodeId: NODE_2, title: "Elasticity", rank: 1 }],
      masteryRows: [{ nodeId: NODE_2, title: "Elasticity", decayedP: 0.9 }],
      lessonNodeIds: [NODE_1],
      rootCauseNodeId: null,
      recentSynopsis: ["L: I get it"],
    },
    { threshold: TUTOR_MASTERY_THRESHOLD, budgetChars: LAYER_BUDGETS.l3Chars }
  );

  const promptA = assembleTutorPrompt({ charterSerialized, lessonContext, learnerState: stateA, historyText: "", learnerMessage: "help" });
  const promptB = assembleTutorPrompt({ charterSerialized, lessonContext, learnerState: stateB, historyText: "", learnerMessage: "thanks" });

  check("system byte-identical across learners", promptA.system === promptB.system);
  check("developer byte-identical across learners", promptA.developer === promptB.developer);
  check("input differs across learners", promptA.input !== promptB.input);
  check("TUTOR_L0 ≥ 4096 chars", TUTOR_L0.length >= 4096, `len=${TUTOR_L0.length}`);
  check("TUTOR_PROMPT_VERSION === tutor-v4 (A3 Wave 4 bump)", TUTOR_PROMPT_VERSION === "tutor-v4");
  check("system IS TUTOR_L0 verbatim", promptA.system === TUTOR_L0);

  /* ───────────── AC-T3.3/T3.4 · scaffolding goldens ────────────────────── */
  console.log("\n— AC-T3.3/T3.4 scaffolding —");

  // Opening-turn clamps: model over-shoots rung 4; each style clamps to its cap.
  const styles: GuidanceStyle[] = ["socratic_strict", "guided_default", "answer_forward"];
  const expectedCap: Record<GuidanceStyle, number> = { socratic_strict: 1, guided_default: 2, answer_forward: 3 };
  for (const s of styles) {
    const clamped = applyScaffolding(
      { proseWithSpanMarkers: "x", citations: [], rung: 4, evidence: [] },
      { style: s, isOpeningTurn: true, justShowMe: false }
    );
    check(`opening clamp ${s} → ${expectedCap[s]}`, clamped.rung === expectedCap[s], `got ${clamped.rung}`);
    check(`resolveRungPolicy ${s} maxOpeningRung`, resolveRungPolicy(s).maxOpeningRung === expectedCap[s]);
  }
  // A non-opening turn is NOT clamped.
  check(
    "non-opening turn keeps rung 4",
    applyScaffolding({ proseWithSpanMarkers: "x", citations: [], rung: 4, evidence: [] }, {
      style: "socratic_strict",
      isOpeningTurn: false,
      justShowMe: false,
    }).rung === 4
  );

  // detectJustShowMe positives / negatives.
  for (const p of ["just show me", "Give me the answer", "TELL ME THE ANSWER now", "stop hinting"]) {
    check(`detectJustShowMe + "${p}"`, detectJustShowMe(p));
  }
  for (const n of ["can you help", "I don't get it", "what's next", "show me an example of a graph"]) {
    check(`detectJustShowMe − "${n}"`, !detectJustShowMe(n));
  }

  // "just show me" forces rung 4 in ALL THREE styles through a full runTutorTurn.
  // The model scripts a LOWER rung; the override lifts it to 4 regardless of style.
  // A rung-4 full answer IS grounded, so it carries a resolving citation.
  for (const s of styles) {
    const { deps } = loopDepsWithStructured({
      rung: 1,
      proseWithSpanMarkers: `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
      citations: [{ lessonId: L1, blockId: B1, slideId: null }],
    });
    const res = await runTutorTurn(
      { ...deps },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: CHARTER_ROW(s),
        historyTurns: [{ role: "learner", content: "prior" }], // non-opening so only justShowMe drives it
        learnerMessage: "just show me the answer",
      }
    );
    check(`just-show-me → rung 4 (${s})`, res.ok && res.rung === 4, `ok=${res.ok} rung=${res.rung} err=${res.error ?? ""}`);
  }

  /* ─────────────────── AC-T3.5 · grounding over 20 turns ───────────────── */
  console.log("\n— AC-T3.5 grounding —");

  // 20 scripted turns; every citation resolves → flags empty on each.
  let allClean = true;
  for (let i = 0; i < 20; i += 1) {
    const { deps } = loopDepsWithStructured({
      proseWithSpanMarkers: `${GROUNDED_OPEN}Price is set at equilibrium.${GROUNDED_CLOSE}`,
      citations: [{ lessonId: L1, blockId: B1, slideId: null }],
      rung: 2,
    });
    const res = await runTutorTurn(
      { ...deps },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: CHARTER_ROW("guided_default"),
        historyTurns: [{ role: "learner", content: "q" }],
        learnerMessage: `question ${i}`,
      }
    );
    if (!res.ok || res.groundingFlags.length !== 0) allClean = false;
  }
  check("20 grounded turns: every citation resolves, flags empty", allClean);

  // Unanswerable question: escalation proposal + ZERO citations → ok, no fabricated
  // flags. The tutor's meta reply is supplemental (its own words, not a course
  // claim), so a zero-citation escalation turn is grounded-clean, not `ungrounded`.
  {
    const { deps } = loopDepsWithStructured({
      proseWithSpanMarkers: `${SUPPLEMENTAL_OPEN}This deserves your instructor's answer — I've drafted it for your consent.${SUPPLEMENTAL_CLOSE}`,
      citations: [],
      rung: 1,
      escalationProposal: { learnerQuestion: "What about crypto?", nodeIds: [NODE_1], proposedAnswer: "Out of course scope." },
    });
    const res = await runTutorTurn(
      { ...deps },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        // OPEN canon keeps the supplemental meta text so the reply survives; strict
        // would suppress it — either way `ok` holds (no grounded span, no citation).
        charterRow: CHARTER_ROW("guided_default", "open"),
        historyTurns: [{ role: "learner", content: "q" }],
        learnerMessage: "explain crypto trading please",
      }
    );
    check(
      "escalation turn: ok with zero citations, no ungrounded/fabricated flags",
      res.ok &&
        !res.groundingFlags.includes("ungrounded") &&
        !res.groundingFlags.includes("span_parse_error") &&
        !res.groundingFlags.includes("citation_dropped") &&
        !res.groundingFlags.includes("anchor_downgraded") &&
        !!res.output?.escalationProposal,
      `ok=${res.ok} flags=${res.groundingFlags.join(",")} escProp=${JSON.stringify(res.output?.escalationProposal ?? null)}`
    );
  }

  // Canon STRICT strips a supplemental span; prose lacks the span text.
  {
    const supText = "In finance more broadly this is arbitrage.";
    const { deps } = loopDepsWithStructured({
      proseWithSpanMarkers: `${GROUNDED_OPEN}Price meets at equilibrium.${GROUNDED_CLOSE} ${SUPPLEMENTAL_OPEN}${supText}${SUPPLEMENTAL_CLOSE}`,
      citations: [{ lessonId: L1, blockId: B1, slideId: null }],
      rung: 2,
    });
    const res = await runTutorTurn(
      { ...deps },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: CHARTER_ROW("guided_default", "strict"),
        historyTurns: [{ role: "learner", content: "q" }],
        learnerMessage: "tell me more",
      }
    );
    check(
      "canon strict: supplemental_suppressed + prose lacks the span text",
      res.ok &&
        res.groundingFlags.includes("supplemental_suppressed") &&
        !!res.output &&
        !res.output.prose.includes(supText),
      `flags=${res.groundingFlags.join(",")} prose="${res.output?.prose ?? ""}"`
    );
  }

  // Canon OPEN keeps the supplemental span text.
  {
    const supText = "In finance more broadly this is arbitrage.";
    const { deps } = loopDepsWithStructured({
      proseWithSpanMarkers: `${GROUNDED_OPEN}Price meets at equilibrium.${GROUNDED_CLOSE} ${SUPPLEMENTAL_OPEN}${supText}${SUPPLEMENTAL_CLOSE}`,
      citations: [{ lessonId: L1, blockId: B1, slideId: null }],
      rung: 2,
    });
    const res = await runTutorTurn(
      { ...deps },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: CHARTER_ROW("guided_default", "open"),
        historyTurns: [{ role: "learner", content: "q" }],
        learnerMessage: "tell me more",
      }
    );
    check(
      "canon open: supplemental span kept in prose",
      res.ok && !!res.output && res.output.prose.includes(supText),
      `prose="${res.output?.prose ?? ""}"`
    );
  }

  /* ─────────────────────────── AC-T3.6 · tools ─────────────────────────── */
  console.log("\n— AC-T3.6 tools —");

  check(
    "TUTOR_TOOL_NAMES is exactly the EIGHT (Wave-3 five + A3 Wave-4 three, order-insensitive)",
    new Set(TUTOR_TOOL_NAMES).size === 8 &&
      [
        "get_lesson_context",
        "get_mastery_summary",
        "generate_practice",
        "emit_evidence",
        "propose_escalation",
        "renderStructure",
        "checkUnderstanding",
        "sequenceTask",
      ].every((n) => (TUTOR_TOOL_NAMES as readonly string[]).includes(n)),
    TUTOR_TOOL_NAMES.join(",")
  );

  // Every tool's zod → toStrictJsonSchema without throw AND with a top-level
  // `type: "object"`. The OpenAI function-calling API rejects a `parameters`
  // schema whose top type isn't object (a top-level discriminatedUnion converts
  // to bare `anyOf` → "got type: None", a live-only 400 the mock never sees —
  // caught by the Wave-4 live smoke, now pinned here).
  let schemaOk = true;
  let topTypeOk = true;
  for (const name of TUTOR_TOOL_NAMES) {
    try {
      const js = toStrictJsonSchema(TUTOR_TOOLS[name].params as z.ZodType) as Record<string, unknown>;
      if (js.type !== "object") {
        topTypeOk = false;
        console.log(`  … ${name} top-level type is ${JSON.stringify(js.type)} (needs "object")`);
      }
    } catch {
      schemaOk = false;
    }
  }
  check("all eight tool param schemas convert to strict JSON schema", schemaOk);
  check("every tool's params is a top-level type:object (OpenAI-valid)", topTypeOk);

  // emit_evidence with a CAPTURING stub performs ZERO writes.
  {
    const svc = capturingServiceClient();
    const deps = baseToolDeps({ serviceClient: svc.client });
    const evidencePayload = { nodeId: NODE_1, direction: "positive", strength: "moderate", turnRef: "turn-1" } as const;
    const out = await TUTOR_TOOLS.emit_evidence.execute({ items: [evidencePayload] } as never, deps);
    const data = out.data as { items: unknown[] };
    check("emit_evidence returns the items", data.items.length === 1);
    check("emit_evidence performs ZERO writes", svc.inserts.length === 0, `inserts=${svc.inserts.length}`);
  }

  // propose_escalation inserts exactly one consent_pending-shaped row.
  {
    const svc = capturingServiceClient();
    const deps = baseToolDeps({ serviceClient: svc.client });
    const out = await TUTOR_TOOLS.propose_escalation.execute(
      { learnerQuestion: "Why is the sky blue?", nodeIds: [NODE_1], proposedAnswer: "Rayleigh scattering." } as never,
      deps
    );
    const data = out.data as { consentRequired: boolean; candidateId: string | null };
    check("propose_escalation returns consentRequired + candidateId", data.consentRequired === true && data.candidateId === "escalation-id-1");
    check("propose_escalation inserts exactly one row", svc.inserts.length === 1 && svc.inserts[0].table === "tutor_escalation_candidates");
    const row = svc.inserts[0]?.row as Record<string, unknown>;
    check(
      "escalation row is consent_pending-shaped (no status set, learner+course pinned)",
      !!row &&
        row.status === undefined &&
        row.user_id === USER_A &&
        row.course_id === COURSE &&
        row.learner_question === "Why is the sky blue?" &&
        Array.isArray(row.anchors) &&
        (row.anchors as unknown[]).length === 0
    );
  }

  // generate_practice mints uuid refs + itemBankRef null + nodeId tags + keys.
  {
    const model = createMockModelClient([], {
      model: LUNA,
      structured: {
        tutor_practice_gen: JSON.stringify({
          items: [
            {
              nodeId: NODE_1,
              kind: "mc",
              prompt: "Where does price settle?",
              choices: ["Below", "Above", "At equilibrium", "Never"],
              correctChoiceIndex: 2,
              explanation: "Equilibrium is where supply meets demand.",
            },
            {
              nodeId: NODE_2,
              kind: "short",
              prompt: "Define elasticity.",
              acceptedAnswers: ["responsiveness", "sensitivity to price"],
              explanation: "Elasticity measures responsiveness to a price change.",
            },
          ],
        }),
      },
    });
    const deps = baseToolDeps({ model });
    const out = await TUTOR_TOOLS.generate_practice.execute({ nodeIds: [NODE_1, NODE_2] } as never, deps);
    const items = (out.data as { items: MintedPracticeItem[] }).items;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    check("generate_practice mints 2 items", items.length === 2);
    check("practiceItemRefs are uuids", items.every((it) => uuidRe.test(it.practiceItemRef)));
    check("practiceItemRefs are distinct", new Set(items.map((it) => it.practiceItemRef)).size === 2);
    check("itemBankRef is null on every item", items.every((it) => it.itemBankRef === null));
    check("nodeId tags carried through", items[0].nodeId === NODE_1 && items[1].nodeId === NODE_2);
    check("mc item carries 4 choices; short item has null choices", items[0].choices?.length === 4 && items[1].choices === null);
    // W4 (Contract 5): the item carries its own key when the mock supplies one.
    check(
      "mc item carries correctChoiceIndex; short's is null",
      items[0].correctChoiceIndex === 2 && items[1].correctChoiceIndex === null
    );
    check(
      "short item carries acceptedAnswers; mc's is null",
      items[1].acceptedAnswers?.length === 2 && items[0].acceptedAnswers === null
    );
    check("both items carry a one-line explanation", !!items[0].explanation && !!items[1].explanation);
  }

  // A keyless item (the model omitted the key) mints with null key fields —
  // nullable accepted, never fabricated.
  {
    const model = createMockModelClient([], {
      model: LUNA,
      structured: {
        tutor_practice_gen: JSON.stringify({
          items: [{ nodeId: NODE_1, kind: "mc", prompt: "Pick one.", choices: ["a", "b", "c", "d"] }],
        }),
      },
    });
    const deps = baseToolDeps({ model });
    const out = await TUTOR_TOOLS.generate_practice.execute({ nodeIds: [NODE_1] } as never, deps);
    const items = (out.data as { items: MintedPracticeItem[] }).items;
    check(
      "keyless mc item → null key fields (nullable accepted, no fabrication)",
      items[0].correctChoiceIndex === null && items[0].acceptedAnswers === null && items[0].explanation === null
    );
  }

  // A tool loop: model requests get_lesson_context, then answers → toolTrace length 1.
  {
    const snapshotFx = buildSnapshot();
    const script: MockTurn[] = [
      // Round 1: request get_lesson_context for lesson 2.
      { toolCalls: [{ name: "get_lesson_context", arguments: { lessonId: L2 } }] },
      // Round 2: answer with a valid structured turn (no tools).
      {
        text: turnOutputJson({
          proseWithSpanMarkers: `${GROUNDED_OPEN}Elasticity measures responsiveness.${GROUNDED_CLOSE}`,
          citations: [{ lessonId: L2, blockId: B2, slideId: null }],
          rung: 2,
        }),
      },
    ];
    // NB: tutor_turn_output is NOT in `structured` here, so the mock runs the SCRIPT
    // (tool call → answer). The final answer text IS a tutor_turn_output JSON.
    const model = createMockModelClient(script, { model: LUNA });
    const res = await runTutorTurn(
      {
        learnerClient: emptyLearnerClient(),
        serviceClient: capturingServiceClient().client,
        model,
        loadSnapshot: async () => ({ snapshot: snapshotFx }),
        conceptNodes: CONCEPT_NODES,
        conceptEdges: CONCEPT_EDGES,
      },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: CHARTER_ROW("guided_default"),
        historyTurns: [{ role: "learner", content: "q" }],
        learnerMessage: "how does elasticity work",
      }
    );
    check(
      "tool loop: toolTrace length 1 (get_lesson_context)",
      res.toolTrace.length === 1 && res.toolTrace[0].tool === "get_lesson_context",
      `trace=${JSON.stringify(res.toolTrace)}`
    );
    check("tool loop: final output validated + ok", res.ok && !!res.output, `ok=${res.ok} err=${res.error ?? ""}`);
  }

  /* ───────────── live-conformance regressions (first live smoke) ────────── */
  console.log("\n— live-conformance regressions —");

  // 1. practiceItems: null must PARSE (the strict JSON-schema converter makes
  //    optionals nullable on the wire — the live model emits null, and the Zod
  //    side rejecting it cost every turn of the first smoke).
  {
    const nullPractice = TurnOutputSchema.safeParse({
      proseWithSpanMarkers: "ok",
      citations: [],
      rung: 1,
      evidence: [],
      practiceItems: null,
      escalationProposal: null,
    });
    check("practiceItems: null parses", nullPractice.success, JSON.stringify(nullPractice.success ? "" : nullPractice.error.issues));
  }

  // 2. A non-resolving evidence nodeId is DROPPED + FLAGGED — never a
  //    whole-turn schema_parse_failed (the live model referenced a concept it
  //    had only seen by title before L2 carried nodeId tags).
  {
    const { deps } = loopDepsWithStructured({
      rung: 2,
      proseWithSpanMarkers: `${GROUNDED_OPEN}Equilibrium balances supply and demand.${GROUNDED_CLOSE}`,
      citations: [{ lessonId: L1, blockId: B1, slideId: null }],
      evidence: [
        { nodeId: NODE_1, direction: "positive", strength: "weak", turnRef: "turn" },
        { nodeId: "Equilibrium", direction: "positive", strength: "weak", turnRef: "turn" },
      ],
    });
    const res = await runTutorTurn(
      { ...deps },
      {
        userId: USER_A,
        courseId: COURSE,
        publicationId: PUB,
        version: 1,
        lessonId: L1,
        charterRow: CHARTER_ROW("guided_default"),
        historyTurns: [{ role: "learner", content: "prior" }],
        learnerMessage: "so it balances?",
      }
    );
    check("mangled evidence nodeId → turn still ok", res.ok, `err=${res.error ?? ""}`);
    check("resolving evidence item survives", res.evidence.length === 1 && res.evidence[0].nodeId === NODE_1);
    check("evidence_dropped flagged", res.groundingFlags.includes("evidence_dropped"));
  }

  // 3. L2 exposes the citeable/evidence ids (title-only context forced the
  //    live model to cite by title — grounding correctly dropped every one).
  {
    const l2 = assembleLessonContext(buildSnapshot(), L1, CONCEPT_NODES, { budgetChars: LAYER_BUDGETS.l2Chars });
    check("L2 lesson header carries lessonId", l2.includes(`(lessonId: ${L1})`));
    check("L2 block headers carry blockId", l2.includes(`(blockId: ${B1})`));
    check("L2 concept lines carry nodeId", l2.includes(`(nodeId: ${NODE_1})`));
    check("L2 carries the cite-by-id instruction", l2.includes("exact lessonId/blockId values"));
  }

  /* ───────────────────────────── history bounds ────────────────────────── */
  console.log("\n— history bounds —");
  {
    const turns: HistoryTurn[] = Array.from({ length: 13 }, (_, i) => ({
      role: i % 2 === 0 ? "learner" : "assistant",
      content: `turn ${i} ${"x".repeat(20)}`,
    }));
    const text = serializeHistory(turns, 100_000);
    const emitted = text.split("\n\n").length;
    check("13 turns → 12 (hard cap)", emitted === 12, `emitted=${emitted}`);

    // Budget drop-oldest: a tight budget drops the oldest whole turns. (Budget
    // 100, not the pre-A3 60: the fixture's TRAILING learner line now carries
    // the 31-char dangling marker — the last line alone is 68 chars.)
    const tight = serializeHistory(turns, 100);
    check("tight budget drops oldest whole turns", tight.length <= 100 && tight.includes("turn 12"), `len=${tight.length}`);
    check("tight budget dropped the oldest turn", !tight.includes("turn 1 "), tight);
  }

  /* ──────────────────────────── chaining seam ──────────────────────────── */
  console.log("\n— chaining seam —");
  {
    const turns: HistoryTurn[] = [
      { role: "learner", content: "q" },
      { role: "assistant", content: "a", responseId: "resp-abc" },
    ];
    delete process.env.TUTOR_ENABLE_CHAINING;
    check("chaining OFF by default → null", collapseToChaining(turns) === null);
    process.env.TUTOR_ENABLE_CHAINING = "true";
    const collapsed = collapseToChaining(turns);
    check("chaining ON → previousResponseId", collapsed?.previousResponseId === "resp-abc");
    delete process.env.TUTOR_ENABLE_CHAINING;
    check("chaining OFF again after unset", collapseToChaining(turns) === null);
  }

  /* ──────────────────────── grounding parse round-trip ─────────────────── */
  console.log("\n— grounding span parse —");
  {
    const clean = parseSpans(`${GROUNDED_OPEN}A${GROUNDED_CLOSE} ${SUPPLEMENTAL_OPEN}B${SUPPLEMENTAL_CLOSE}`);
    check("balanced spans parse without error", !clean.parseError && clean.spans.length >= 2);
    const grounded = clean.spans.filter((s) => s.kind === "grounded").map((s) => s.text.trim());
    const supplemental = clean.spans.filter((s) => s.kind === "supplemental").map((s) => s.text.trim());
    check("grounded/supplemental classified correctly", grounded.includes("A") && supplemental.includes("B"));

    const unclosed = parseSpans(`${GROUNDED_OPEN}A never closed`);
    check("unclosed marker → span_parse_error", unclosed.parseError);
  }

  /* ─────────────── A3/D-6 · the grounding ok-rule (Wave 1) ─────────────── */
  console.log("\n— A3/D-6 grounding ok-rule —");
  {
    const idx = buildSnapshotIndex(buildSnapshot());
    const mkOut = (o: Partial<TurnOutput>): TurnOutput => ({
      proseWithSpanMarkers: o.proseWithSpanMarkers ?? "",
      citations: o.citations ?? [],
      rung: o.rung ?? 1,
      evidence: o.evidence ?? [],
      practiceItems: o.practiceItems ?? null,
      escalationProposal: o.escalationProposal ?? null,
    });
    // Deterministically > 200 cleaned chars (55 × 5 − trim = 274).
    const longProse = "The equilibrium price balances supply and demand here. ".repeat(5).trim();

    // (a) A short citation-less GROUNDED-span greeting → ok:true, NO ungrounded
    //     flag (a greeting is not a claim — the D-6 precondition killer).
    const greeting = validateTurnOutput(
      mkOut({ proseWithSpanMarkers: `${GROUNDED_OPEN}Hi! What would you like to review today?${GROUNDED_CLOSE}` }),
      idx,
      { courseCanon: "strict" }
    );
    check("greeting (short, citation-less, grounded span) → ok:true", greeting.ok === true, `flags=${greeting.flags.join(",")}`);
    check("greeting carries NO ungrounded flag", !greeting.flags.includes("ungrounded"), `flags=${greeting.flags.join(",")}`);

    // Bare-text variant (no markers at all) — also ok, zero flags.
    const bare = validateTurnOutput(
      mkOut({ proseWithSpanMarkers: "Happy to help — where shall we start?" }),
      idx,
      { courseCanon: "strict" }
    );
    check("bare short citation-less text → ok:true, zero flags", bare.ok === true && bare.flags.length === 0, `flags=${bare.flags.join(",")}`);

    // (b) SUBSTANTIVE (>200 chars) citation-less, no escalation → ok:false +
    //     ungrounded (the substantive rule — UNCHANGED).
    const substantive = validateTurnOutput(
      mkOut({ proseWithSpanMarkers: `${GROUNDED_OPEN}${longProse}${GROUNDED_CLOSE}` }),
      idx,
      { courseCanon: "strict" }
    );
    check(
      "substantive citation-less, no escalation → ok:false + ungrounded",
      substantive.ok === false && substantive.flags.includes("ungrounded"),
      `ok=${substantive.ok} flags=${substantive.flags.join(",")}`
    );

    // (c) Substantive citation-less WITH an escalationProposal → ok:true (the
    //     documented escape — previously broken by the blunt rule).
    const escaped = validateTurnOutput(
      mkOut({
        proseWithSpanMarkers: `${GROUNDED_OPEN}${longProse}${GROUNDED_CLOSE}`,
        escalationProposal: { learnerQuestion: "q", nodeIds: [NODE_1], proposedAnswer: "a" },
      }),
      idx,
      { courseCanon: "strict" }
    );
    check(
      "substantive citation-less WITH escalation proposal → ok:true (the escape)",
      escaped.ok === true && !escaped.flags.includes("ungrounded"),
      `ok=${escaped.ok} flags=${escaped.flags.join(",")}`
    );

    // (d) span_parse_error still fails ok (UNCHANGED — the deliberate Wave-1
    //     decision: relaxing it could leak supplemental under strict canon).
    const malformed = validateTurnOutput(
      mkOut({ proseWithSpanMarkers: `${GROUNDED_OPEN}never closed` }),
      idx,
      { courseCanon: "strict" }
    );
    check(
      "span_parse_error still fails ok (unchanged)",
      malformed.ok === false && malformed.flags.includes("span_parse_error"),
      `ok=${malformed.ok} flags=${malformed.flags.join(",")}`
    );
  }

  /* ──────────── A3/D-3 · citation dedup (jump-target identity) ─────────── */
  console.log("\n— A3/D-3 citation dedup —");
  {
    const idx = buildSnapshotIndex(buildSnapshot());
    const mkCite = (citations: TurnOutput["citations"]): TurnOutput => ({
      proseWithSpanMarkers: `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
      citations,
      rung: 2,
      evidence: [],
      practiceItems: null,
      escalationProposal: null,
    });

    // Byte-identical duplicates collapse to ONE (no flag — dedup is a cleanup).
    const dup = validateTurnOutput(
      mkCite([
        { lessonId: L1, blockId: B1, slideId: null },
        { lessonId: L1, blockId: B1, slideId: null },
      ]),
      idx,
      { courseCanon: "strict" }
    );
    check(
      "byte-identical duplicates collapse to one, no flag",
      dup.ok === true && dup.cleaned.citations.length === 1 && dup.flags.length === 0,
      `n=${dup.cleaned.citations.length} flags=${dup.flags.join(",")}`
    );

    // Downgrade-manufactured duplicates: two unresolvable slideIds on ONE block
    // both become {block, slideId:null} → dedup collapses them to ONE survivor.
    const downgraded = validateTurnOutput(
      mkCite([
        { lessonId: L1, blockId: B1, slideId: "dddddddd-0000-4000-8000-00000000000a" },
        { lessonId: L1, blockId: B1, slideId: "dddddddd-0000-4000-8000-00000000000b" },
      ]),
      idx,
      { courseCanon: "strict" }
    );
    check(
      "downgrade-manufactured duplicates collapse to ONE {block, slideId:null}",
      downgraded.ok === true &&
        downgraded.cleaned.citations.length === 1 &&
        downgraded.cleaned.citations[0].blockId === B1 &&
        downgraded.cleaned.citations[0].slideId === null,
      `n=${downgraded.cleaned.citations.length} cites=${JSON.stringify(downgraded.cleaned.citations)}`
    );
    check("downgrade still flags anchor_downgraded", downgraded.flags.includes("anchor_downgraded"));

    // Two DIFFERENT blocks both survive — dedup never over-collapses, and the
    // first-seen order is preserved.
    const distinct = validateTurnOutput(
      mkCite([
        { lessonId: L2, blockId: B2, slideId: null },
        { lessonId: L1, blockId: B1, slideId: null },
        { lessonId: L2, blockId: B2, slideId: null }, // repeat of the first
      ]),
      idx,
      { courseCanon: "strict" }
    );
    check(
      "two different blocks survive, order-preserving (first-seen wins)",
      distinct.cleaned.citations.length === 2 &&
        distinct.cleaned.citations[0].blockId === B2 &&
        distinct.cleaned.citations[1].blockId === B1,
      `cites=${JSON.stringify(distinct.cleaned.citations)}`
    );
  }

  /* ─────────── A3/D-6 · replay framing (dangling-question marker) ────────── */
  console.log("\n— A3/D-6 replay framing —");
  {
    const turns: HistoryTurn[] = [
      { role: "learner", content: "what is equilibrium?" }, // answered → no marker
      { role: "assistant", content: "let's find out together." },
      { role: "learner", content: "why is my curve flat?" }, // next is learner → marker
      { role: "learner", content: "hello" }, // trailing learner line → marker
    ];
    const lines = serializeHistory(turns, 100_000).split("\n\n");
    check("frozen marker bytes", DANGLING_LEARNER_MARKER === " [no tutor reply was delivered]");
    check("answered learner line carries NO marker", lines[0] === "Learner: what is equilibrium?", lines[0]);
    check("assistant line untouched", lines[1] === "Tutor: let's find out together.", lines[1]);
    check(
      "dangling learner line (next is learner) carries the frozen marker",
      lines[2] === `Learner: why is my curve flat?${DANGLING_LEARNER_MARKER}`,
      lines[2]
    );
    check(
      "trailing learner line carries the frozen marker",
      lines[3] === `Learner: hello${DANGLING_LEARNER_MARKER}`,
      lines[3]
    );

    // A learner line answered by an INSTRUCTOR reply is NOT dangling.
    const instr = serializeHistory(
      [
        { role: "learner", content: "q1" },
        { role: "instructor", content: "the instructor answered" },
      ],
      100_000
    ).split("\n\n");
    check("learner line answered by instructor → no marker", instr[0] === "Learner: q1", instr[0]);
  }

  /* ────── A3/D-6 · per-turn input delimiters + the tutor-v2 L0 bump ──────── */
  console.log("\n— A3/D-6 prompt delimiters + L0 —");
  {
    const parts = { charterSerialized: "C", lessonContext: "LC", learnerState: "LS" };
    const withHist = assembleTutorPrompt({ ...parts, historyText: "Learner: earlier", learnerMessage: "hello" });
    check(
      "input WITH history is byte-exact (SO FAR + CURRENT MESSAGE)",
      withHist.input === "LS\n\n== CONVERSATION SO FAR ==\nLearner: earlier\n\n== CURRENT MESSAGE ==\nLearner: hello",
      JSON.stringify(withHist.input)
    );
    const noHist = assembleTutorPrompt({ ...parts, historyText: "", learnerMessage: "hello" });
    check(
      "input WITHOUT history is byte-exact (no SO FAR block)",
      noHist.input === "LS\n\n== CURRENT MESSAGE ==\nLearner: hello",
      JSON.stringify(noHist.input)
    );
    check("empty history omits the SO FAR header", !noHist.input.includes("== CONVERSATION SO FAR =="));

    // L0: the two NEW sections exist, teach the right rules, and the section
    // inventory is EXACTLY the pre-A3 set + the two additions.
    check("L0 has == FORMATTING ==", TUTOR_L0.includes("\n== FORMATTING ==\n"));
    check("L0 has == THE CURRENT MESSAGE ==", TUTOR_L0.includes("\n== THE CURRENT MESSAGE ==\n"));
    check("L0 formatting bans tables/links/images/raw HTML", TUTOR_L0.includes("NEVER tables, links, images, or raw HTML"));
    check("L0 bans ASCII/monospace diagrams", TUTOR_L0.includes("NEVER ASCII or monospace diagrams"));
    check(
      "L0 current-message rule names the frozen headers + marker",
      TUTOR_L0.includes('"== CURRENT MESSAGE =="') &&
        TUTOR_L0.includes('"== CONVERSATION SO FAR =="') &&
        TUTOR_L0.includes('"[no tutor reply was delivered]"')
    );
    const expectedSections = [
      "== WHO YOU ARE TALKING TO ==",
      "== THE CURRENT MESSAGE ==",
      "== PEDAGOGY ==",
      "== THE SCAFFOLDING LADDER (rungs 0–4) ==",
      "== GROUNDING (non-negotiable) ==",
      "== ASSESSMENT INTEGRITY ==",
      "== YOUR TOOLS ==",
      "== OUTPUT CONTRACT (every turn) ==",
      "== PRACTICE & INVITATIONS ==",
      "== FORMATTING ==",
      "== SAFETY ==",
    ];
    const headerLines = TUTOR_L0.match(/^== .+ ==$/gm) ?? [];
    check(
      "L0 section inventory UNCHANGED across the A3-Wave-4 bump (same 11 headers)",
      expectedSections.every((s) => TUTOR_L0.includes(s)) && headerLines.length === expectedSections.length,
      `headers=${headerLines.join(" | ")}`
    );
    // The tutor-v3 section teaches offer-not-impose + deliver-on-ask (invocation
    // policy is enforced in CODE — this is the model-facing framing only). A3
    // Wave 4 KEEPS this line verbatim.
    check(
      "L0 practice section: never attach unasked practice + deliver immediately on ask/accept",
      TUTOR_L0.includes("Never attach practice to an answer the learner did not ask for") &&
        TUTOR_L0.includes("quiet invitation") &&
        TUTOR_L0.includes("deliver it immediately")
    );
    // A3 Wave 4 — the three new tools appear in the YOUR TOOLS capability list with
    // their teaching lines.
    check(
      "L0 YOUR TOOLS lists renderStructure / checkUnderstanding / sequenceTask",
      TUTOR_L0.includes("\n  renderStructure —") &&
        TUTOR_L0.includes("\n  checkUnderstanding —") &&
        TUTOR_L0.includes("\n  sequenceTask —")
    );
    check(
      "L0 teaches: renderStructure for tree/graph/timeline/axes; every wrong option names its misconception",
      TUTOR_L0.includes("tree, graph, timeline, or coordinate axes") &&
        TUTOR_L0.includes("EVERY wrong option MUST name the misconception it represents")
    );
    // The FORMATTING ASCII ban now points at renderStructure (not "no channel yet").
    check(
      "L0 FORMATTING: the ASCII ban routes tree/graph/timeline/plot to renderStructure",
      TUTOR_L0.includes("NEVER ASCII or monospace diagrams") &&
        TUTOR_L0.includes("use the renderStructure tool")
    );
  }

  /* ──────────────────── A2: early chain-id capture ─────────────────────── */
  console.log("\n— A2: early chain-id capture —");
  {
    const snapshotFx = buildSnapshot();
    // A valid, grounded structured turn (so the loop settles ok) — the fake model's
    // final text. A resolving citation into the snapshot makes grounding clean.
    const validTurnText = turnOutputJson({
      proseWithSpanMarkers: `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
      citations: [{ lessonId: L1, blockId: B1, slideId: null }],
      rung: 2,
    });

    /** A fake ModelClient whose runTurn synchronously emits ONE `started` event
     *  (with `startedId`) FIRST, then either returns a structured turn (whose final
     *  responseId is `finalId`) or THROWS `throwErr` after the emit. */
    function fakeModel(opts: {
      startedId: string | null;
      finalId?: string | null;
      throwErr?: Error;
    }): ModelClient {
      return {
        model: LUNA,
        async runTurn(
          _params: ModelTurnParams,
          onEvent: (ev: ModelStreamEvent) => void
        ): Promise<ModelTurnResult> {
          // `started` FIRST — before any output token — exactly like a real provider.
          onEvent({ type: "started", responseId: opts.startedId });
          if (opts.throwErr) throw opts.throwErr;
          // A little streamed text, then the structured final (mirrors the real path).
          onEvent({ type: "text_delta", delta: "…" });
          return {
            text: validTurnText,
            toolCalls: [],
            finishReason: "stop",
            ...(opts.finalId !== undefined ? { responseId: opts.finalId } : {}),
          };
        },
      };
    }

    function loopDepsFor(model: ModelClient, onModelEvent?: (ev: ModelStreamEvent) => void) {
      return {
        learnerClient: emptyLearnerClient(),
        serviceClient: capturingServiceClient().client,
        model,
        loadSnapshot: async () => ({ snapshot: snapshotFx }),
        conceptNodes: CONCEPT_NODES,
        conceptEdges: CONCEPT_EDGES,
        ...(onModelEvent ? { onModelEvent } : {}),
      };
    }

    const ctxBase = {
      userId: USER_A,
      courseId: COURSE,
      publicationId: PUB,
      version: 1,
      lessonId: L1,
      charterRow: CHARTER_ROW("guided_default"),
      historyTurns: [{ role: "learner" as const, content: "prior" }],
      learnerMessage: "why does a wash stay transparent?",
    };

    // (a) onModelEvent receives the `started` event FIRST; when the final omits a
    //     responseId, the turn's responseId is the started id (resp-early-1).
    {
      const seen: ModelStreamEvent[] = [];
      const model = fakeModel({ startedId: "resp-early-1" }); // finalId omitted
      const res = await runTutorTurn(loopDepsFor(model, (ev) => seen.push(ev)), ctxBase);
      check(
        "onModelEvent received the `started` event FIRST",
        seen.length > 0 && seen[0].type === "started" && (seen[0] as { responseId: string | null }).responseId === "resp-early-1",
        `first=${JSON.stringify(seen[0])}`
      );
      check(
        "final omits responseId → turn responseId is the started id",
        res.ok && res.responseId === "resp-early-1",
        `ok=${res.ok} responseId=${res.responseId} err=${res.error ?? ""}`
      );
    }

    // (b) When the final result CARRIES a responseId, it WINS over the started id.
    {
      const model = fakeModel({ startedId: "resp-early-2", finalId: "resp-final-2" });
      const res = await runTutorTurn(loopDepsFor(model), ctxBase);
      check(
        "final responseId WINS over the started id",
        res.ok && res.responseId === "resp-final-2",
        `ok=${res.ok} responseId=${res.responseId}`
      );
    }

    // (c) A fake that emits `started` then THROWS AbortError: the loop's NEVER-THROWS
    //     contract catches it → ok:false — and the hoisted lastResponseId means the
    //     turn still surfaces the id it captured before the throw (resp-early-1).
    {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      const seen: ModelStreamEvent[] = [];
      const model = fakeModel({ startedId: "resp-early-1", throwErr: abortErr });
      const res = await runTutorTurn(loopDepsFor(model, (ev) => seen.push(ev)), ctxBase);
      check(
        "throw-after-started: turn settles NOT-ok (loop never throws)",
        res.ok === false && res.output === null,
        `ok=${res.ok} output=${res.output !== null}`
      );
      check(
        "throw-after-started: responseId is the pre-throw captured id (resp-early-1)",
        res.responseId === "resp-early-1",
        `responseId=${res.responseId}`
      );
      check(
        "throw-after-started: onModelEvent still saw the `started` event",
        seen.some((ev) => ev.type === "started"),
        `events=${seen.map((e) => e.type).join(",")}`
      );
    }

    // (d) A hook that THROWS does not break the turn (best-effort observability).
    {
      const model = fakeModel({ startedId: "resp-early-3", finalId: "resp-final-3" });
      const res = await runTutorTurn(
        loopDepsFor(model, () => {
          throw new Error("hook boom");
        }),
        ctxBase
      );
      check(
        "a throwing onModelEvent hook does not break the turn",
        res.ok && res.responseId === "resp-final-3",
        `ok=${res.ok} responseId=${res.responseId} err=${res.error ?? ""}`
      );
    }
  }

  /* ──────────────── A2: tool tiers (fail-closed approval gate) ─────────────── */
  console.log("\n— A2: tool tiers (fail-closed approval gate) —");
  {
    // A2-10 (the CI check — `npm test` IS CI here): the tier table is EXHAUSTIVE
    // over TUTOR_TOOL_NAMES — every tool name has a row, and there is NO extra key.
    // A new tool that lands unclassified fails this AND is a TypeScript error.
    const tierKeys = Object.keys(TUTOR_TOOL_TIERS);
    check(
      "A2-10: every TUTOR_TOOL_NAMES member has an explicit tier row",
      TUTOR_TOOL_NAMES.every((name) => name in TUTOR_TOOL_TIERS),
      `names=${TUTOR_TOOL_NAMES.join(",")} keys=${tierKeys.join(",")}`
    );
    check(
      "A2-10: the tier table has NO extra keys beyond TUTOR_TOOL_NAMES",
      tierKeys.length === TUTOR_TOOL_NAMES.length &&
        tierKeys.every((k) => (TUTOR_TOOL_NAMES as readonly string[]).includes(k)),
      `keys=${tierKeys.join(",")}`
    );

    // tierOf returns each known tool's declared row (read/reversible today).
    check(
      "tierOf known names: the four reads are 'read'",
      tierOf("get_lesson_context") === "read" &&
        tierOf("get_mastery_summary") === "read" &&
        tierOf("generate_practice") === "read" &&
        tierOf("emit_evidence") === "read"
    );
    check("tierOf propose_escalation === 'reversible'", tierOf("propose_escalation") === "reversible");

    // FAIL CLOSED: an unclassified/unknown name is treated as irreversible.
    check('tierOf("wipe_all_data") === "irreversible" (fail closed)', tierOf("wipe_all_data") === "irreversible");
    check('tierOf("") === "irreversible" (fail closed)', tierOf("") === "irreversible");

    // A2-9 (synthetic irreversible tool): a fake ModelClient whose FIRST turn
    // requests a tool call named "wipe_all_data" — a name in NO registry, so
    // tier-less ⇒ irreversible ⇒ the gate HALTS. We assert the loop made EXACTLY
    // ONE model call (no second round with a function_call_output — the model was
    // never re-asked), the result is a completed-but-gated shape, and NO tool ran.
    {
      const snapshotFx = buildSnapshot();
      let callCount = 0;
      // Records the input of every runTurn so we can prove round 2 (a
      // function_call_output feed-back) NEVER happened.
      const inputs: unknown[] = [];
      const gatingModel: ModelClient = {
        model: LUNA,
        async runTurn(params: ModelTurnParams, onEvent: (ev: ModelStreamEvent) => void): Promise<ModelTurnResult> {
          callCount += 1;
          inputs.push(params.input);
          onEvent({ type: "started", responseId: "resp-gate-1" });
          // Round 1 (and the ONLY round that should happen): request the forbidden
          // tool. If the loop wrongly continued, a 2nd call would arrive — the test
          // would catch the callCount ≥ 2. We answer with a tool call every time so
          // that a (wrongly) continued loop can't accidentally settle ok.
          return {
            text: "",
            toolCalls: [
              { callId: "call-wipe", name: "wipe_all_data", arguments: JSON.stringify({ scope: "everything" }) },
            ],
            finishReason: "tool_calls",
            responseId: "resp-gate-1",
          };
        },
      };

      const res = await runTutorTurn(
        {
          learnerClient: emptyLearnerClient(),
          serviceClient: capturingServiceClient().client,
          model: gatingModel,
          loadSnapshot: async () => ({ snapshot: snapshotFx }),
          conceptNodes: CONCEPT_NODES,
          conceptEdges: CONCEPT_EDGES,
        },
        {
          userId: USER_A,
          courseId: COURSE,
          publicationId: PUB,
          version: 1,
          lessonId: L1,
          charterRow: CHARTER_ROW("guided_default"),
          historyTurns: [{ role: "learner", content: "q" }],
          learnerMessage: "delete everything please",
        }
      );

      check(
        "A2-9: gate HALTED after exactly ONE model call (no ToolError round-trip)",
        callCount === 1,
        `callCount=${callCount}`
      );
      check(
        "A2-9: approvalRequired.toolName === 'wipe_all_data'",
        res.approvalRequired?.toolName === "wipe_all_data",
        `approvalRequired=${JSON.stringify(res.approvalRequired ?? null)}`
      );
      check("A2-9: gated turn is ok:false (nothing FAILED — nothing RAN)", res.ok === false, `ok=${res.ok}`);
      check("A2-9: gated turn output === null", res.output === null, `output=${res.output !== null}`);
      check("A2-9: no tool executed → empty toolTrace + no evidence", res.toolTrace.length === 0 && res.evidence.length === 0);
      // The model was NEVER re-asked with a function_call_output item (no round 2).
      // Only the initial conversation ([developer, user]) was ever sent.
      check(
        "A2-9: the model was never fed a function_call_output (no second round)",
        inputs.length === 1 &&
          Array.isArray(inputs[0]) &&
          !(inputs[0] as unknown[]).some(
            (i) => i != null && typeof i === "object" && (i as Record<string, unknown>).type === "function_call_output"
          ),
        `inputsLen=${inputs.length}`
      );

      // A gated turn persists NOTHING assistant-side: the RESULT shape guarantees it.
      // service.ts step (6): `if (!turn.ok || !turn.output) { ...assistant: null, evidenceEmitted: 0 }`
      // — ok:false + output:null matches that skip exactly, so no assistant row + no
      // evidence is ever written for a gated turn.
      check(
        "A2-9: result shape guarantees zero assistant persistence (service step-6 skip)",
        res.ok === false && res.output === null,
        `ok=${res.ok} output=${res.output !== null}`
      );
    }

    // The gate NEVER fires for a legitimate read/reversible tool: a get_lesson_context
    // loop still runs to a validated answer (regression guard that the gate is
    // surgical — the AC-T3.6 tool loop already covers this, re-asserted here in the
    // A2 lens: a 'read'-tier tool is executed, approvalRequired stays absent).
    {
      const snapshotFx = buildSnapshot();
      const script: MockTurn[] = [
        { toolCalls: [{ name: "get_lesson_context", arguments: { lessonId: L2 } }] },
        {
          text: turnOutputJson({
            proseWithSpanMarkers: `${GROUNDED_OPEN}Elasticity measures responsiveness.${GROUNDED_CLOSE}`,
            citations: [{ lessonId: L2, blockId: B2, slideId: null }],
            rung: 2,
          }),
        },
      ];
      const model = createMockModelClient(script, { model: LUNA });
      const res = await runTutorTurn(
        {
          learnerClient: emptyLearnerClient(),
          serviceClient: capturingServiceClient().client,
          model,
          loadSnapshot: async () => ({ snapshot: snapshotFx }),
          conceptNodes: CONCEPT_NODES,
          conceptEdges: CONCEPT_EDGES,
        },
        {
          userId: USER_A,
          courseId: COURSE,
          publicationId: PUB,
          version: 1,
          lessonId: L1,
          charterRow: CHARTER_ROW("guided_default"),
          historyTurns: [{ role: "learner", content: "q" }],
          learnerMessage: "how does elasticity work",
        }
      );
      check(
        "read-tier tool executes normally; approvalRequired stays absent",
        res.ok && !!res.output && (res.approvalRequired === undefined || res.approvalRequired === null),
        `ok=${res.ok} approvalRequired=${JSON.stringify(res.approvalRequired ?? null)}`
      );
    }
  }

  /* ══════════════ A3 Wave 3 · invocation policy (pure) ══════════════════ */

  // Shared: a minimal, schema-valid practice item for policy inputs.
  const policyItem = (nodeId: string): TurnPracticeItem => ({
    nodeId,
    practiceItemRef: `ref-${nodeId}`,
    kind: "mc",
    prompt: "Pick one.",
    choices: ["a", "b", "c", "d"],
    correctChoiceIndex: 0,
    acceptedAnswers: null,
    explanation: null,
    itemBankRef: null,
  });
  const policyOutput = (o: Partial<TurnOutput>): TurnOutput => ({
    proseWithSpanMarkers: o.proseWithSpanMarkers ?? "Here's the idea.",
    citations: o.citations ?? [],
    rung: o.rung ?? 2,
    evidence: o.evidence ?? [],
    practiceItems: o.practiceItems,
    escalationProposal: o.escalationProposal ?? null,
  });

  /* ───────── A3-6 · PROPERTY: question turns never retain practice ───────── */
  console.log("\n— A3-6 · applyInvocationPolicy PROPERTY (seeded, 120 turns) —");
  {
    // Deterministic LCG (the verify-social.ts precedent — no Math.random).
    const makeLcg = (seed: number) => {
      let s = seed >>> 0;
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
    };
    const rnd = makeLcg(0xa3c0ffee);

    const RUNS = 120;
    let retained = 0; // question outputs that kept practiceItems
    let inviteWithItems = 0; // invitation coexisting with surviving items (A3-9)
    let inviteDuringCooldown = 0; // invitation under cooldown (A3-10)
    let malformedInvites = 0; // anything but ONE well-formed invitation or null
    let inviteCount = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const nItems = rnd() < 0.5 ? 0 : 1 + Math.floor(rnd() * 3);
      const items =
        nItems === 0
          ? rnd() < 0.5
            ? null
            : undefined
          : Array.from({ length: nItems }, (_, k) => policyItem(`node-${i}-${k}`));
      const rung = Math.floor(rnd() * 5) as TurnOutput["rung"];
      const cooldownActive = rnd() < 0.35;
      const pendingDowngrade =
        rnd() < 0.35 ? { toolName: "generate_practice", nodeId: `dg-${i}` } : null;
      const res = applyInvocationPolicy({
        output: policyOutput({ rung, practiceItems: items }),
        initiation: { kind: "question" },
        pendingDowngrade,
        cooldownActive,
      });
      const survived = res.output.practiceItems?.length ?? 0;
      if (survived > 0) retained += 1;
      if (res.invitation && survived > 0) inviteWithItems += 1;
      if (res.invitation && cooldownActive) inviteDuringCooldown += 1;
      if (res.invitation) {
        inviteCount += 1;
        const inv = res.invitation;
        if (
          typeof inv.toolName !== "string" ||
          typeof inv.nodeId !== "string" ||
          typeof inv.label !== "string"
        ) {
          malformedInvites += 1;
        }
      }
    }
    check(`A3-6: ZERO of ${RUNS} question outputs retain practiceItems`, retained === 0, `retained=${retained}`);
    check("A3-6: invitation never coexists with surviving items (A3-9)", inviteWithItems === 0, String(inviteWithItems));
    check("A3-6: invitation never offered under cooldown (A3-10)", inviteDuringCooldown === 0, String(inviteDuringCooldown));
    check("A3-6: every offered invitation is ONE well-formed {toolName,nodeId,label}", malformedInvites === 0, String(malformedInvites));
    check("A3-6: the property run is not vacuous (some invitations offered)", inviteCount > 0, `n=${inviteCount}`);

    // Paths 1/2 leave items intact + invitation null (A3-8).
    const twoItems = [policyItem("n1"), policyItem("n2")];
    const p1 = applyInvocationPolicy({
      output: policyOutput({ practiceItems: twoItems }),
      initiation: { kind: "practice_request" },
      pendingDowngrade: null,
      cooldownActive: false,
    });
    check("A3-8: Path 1 (practice_request) — items intact + invitation null", p1.output.practiceItems?.length === 2 && p1.invitation === null);
    const p2 = applyInvocationPolicy({
      output: policyOutput({ practiceItems: twoItems }),
      initiation: { kind: "invitation_accepted", toolName: "generate_practice", nodeId: "n1" },
      pendingDowngrade: null,
      cooldownActive: false,
    });
    check("A3-8: Path 2 (invitation_accepted) — items intact + invitation null", p2.output.practiceItems?.length === 2 && p2.invitation === null);
    // Cooldown never touches Paths 1/2 (the learner initiated).
    const p1cd = applyInvocationPolicy({
      output: policyOutput({ practiceItems: twoItems }),
      initiation: { kind: "practice_request" },
      pendingDowngrade: null,
      cooldownActive: true,
    });
    check("A3-8: Path 1 under cooldown — items STILL intact", p1cd.output.practiceItems?.length === 2 && p1cd.invitation === null);
  }

  /* ───────── A3-7 · downgrade-to-invitation (pure + loop-level) ─────────── */
  console.log("\n— A3-7 · downgrade-to-invitation —");
  {
    // Pure: the loop-recorded tool-call downgrade converts (toolName + nodeId
    // preserved, label correct) and WINS over a stripped model item.
    const winner = applyInvocationPolicy({
      output: policyOutput({ practiceItems: [policyItem("item-node")] }),
      initiation: { kind: "question" },
      pendingDowngrade: { toolName: "generate_practice", nodeId: "call-node" },
      cooldownActive: false,
    });
    check(
      "A3-7: tool-call downgrade wins over the stripped item (toolName + nodeId preserved)",
      winner.invitation?.toolName === "generate_practice" && winner.invitation?.nodeId === "call-node",
      JSON.stringify(winner.invitation)
    );
    check("A3-7: downgrade label is the directive copy", winner.invitation?.label === "Try a practice problem");
    check("A3-7: items stripped alongside the downgrade", (winner.output.practiceItems?.length ?? 0) === 0);

    // No tool-call downgrade → the FIRST stripped item's nodeId seeds it.
    const fromItem = applyInvocationPolicy({
      output: policyOutput({ practiceItems: [policyItem("first-node"), policyItem("second-node")] }),
      initiation: { kind: "question" },
      pendingDowngrade: null,
      cooldownActive: false,
    });
    check(
      "A3-7: the FIRST stripped item's nodeId becomes the invitation",
      fromItem.invitation?.nodeId === "first-node" && fromItem.invitation?.toolName === "generate_practice",
      JSON.stringify(fromItem.invitation)
    );

    // The rung→invitation-tool map (ruling R-6) is FULL data; today every rung
    // resolves to generate_practice (the only implemented Class-A surface).
    check(
      "R-6: RUNG_INVITATION_TOOLS is the full 0–4 map",
      RUNG_INVITATION_TOOLS[0].includes("checkUnderstanding") &&
        RUNG_INVITATION_TOOLS[0].includes("predictThenReveal") &&
        RUNG_INVITATION_TOOLS[2].includes("sequenceTask") &&
        RUNG_INVITATION_TOOLS[2].includes("fadedExample") &&
        RUNG_INVITATION_TOOLS[3].includes("fadedExample") &&
        RUNG_INVITATION_TOOLS[4].includes("checkUnderstanding")
    );
    check(
      "R-6: rungs 0–1 & 4 → checkUnderstanding, rung 2 → sequenceTask (mapped tools now implemented)",
      invitationToolForRung(0) === "checkUnderstanding" &&
        invitationToolForRung(1) === "checkUnderstanding" &&
        invitationToolForRung(2) === "sequenceTask" &&
        invitationToolForRung(4) === "checkUnderstanding",
      [0, 1, 2, 3, 4].map((r) => `${r}:${invitationToolForRung(r)}`).join(" ")
    );
    check(
      "R-6: rung 3 falls back to generate_practice (fadedExample is Wave 5, not yet active)",
      invitationToolForRung(3) === "generate_practice"
    );
    check(
      "CLASS_A_TOOL_NAMES = {generate_practice, checkUnderstanding, sequenceTask}; every member has a label",
      CLASS_A_TOOL_NAMES.size === 3 &&
        CLASS_A_TOOL_NAMES.has("generate_practice") &&
        CLASS_A_TOOL_NAMES.has("checkUnderstanding") &&
        CLASS_A_TOOL_NAMES.has("sequenceTask") &&
        [...CLASS_A_TOOL_NAMES].every((t) => typeof INVITATION_LABELS[t] === "string")
    );

    // LOOP-LEVEL: a scripted generate_practice call on a QUESTION turn is NOT
    // executed — no tutor_practice_gen structured call, no toolTrace entry, the
    // synthetic function_call_output fed back, invitation surfaced, downgrade
    // logged. The structured map DOES carry tutor_practice_gen, so if the loop
    // wrongly executed the tool it would SUCCEED (not error) — non-execution is
    // proven by the absence of the call.
    {
      const snapshotFx = buildSnapshot();
      const script: MockTurn[] = [
        { toolCalls: [{ name: "generate_practice", arguments: { nodeIds: [NODE_1] } }] },
        {
          text: turnOutputJson({
            proseWithSpanMarkers: `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
            citations: [{ lessonId: L1, blockId: B1, slideId: null }],
            rung: 1,
          }),
        },
      ];
      const model = createMockModelClient(script, {
        model: LUNA,
        structured: {
          tutor_practice_gen: JSON.stringify({
            items: [{ nodeId: NODE_1, kind: "mc", prompt: "?", choices: ["a", "b", "c", "d"], correctChoiceIndex: 0 }],
          }),
        },
      });
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      };
      let res!: Awaited<ReturnType<typeof runTutorTurn>>;
      try {
        res = await runTutorTurn(
          {
            learnerClient: emptyLearnerClient(),
            serviceClient: capturingServiceClient().client,
            model,
            loadSnapshot: async () => ({ snapshot: snapshotFx }),
            conceptNodes: CONCEPT_NODES,
            conceptEdges: CONCEPT_EDGES,
          },
          {
            userId: USER_A,
            courseId: COURSE,
            publicationId: PUB,
            version: 1,
            lessonId: L1,
            charterRow: CHARTER_ROW("guided_default"),
            historyTurns: [{ role: "learner", content: "prior" }],
            learnerMessage: "why does price settle there?",
            // initiation omitted → defaults to { kind: "question" }
          }
        );
      } finally {
        console.log = origLog;
      }
      check(
        "A3-7 loop: generate_practice NOT executed on a question turn (no tutor_practice_gen call)",
        model.getCalls().every((c) => c.responseFormat?.name !== "tutor_practice_gen"),
        model.getCalls().map((c) => c.responseFormat?.name ?? "-").join(",")
      );
      check("A3-7 loop: no generate_practice in toolTrace (downgraded, not executed)", res.toolTrace.every((t) => t.tool !== "generate_practice"));
      check(
        "A3-7 loop: invitation surfaced {generate_practice, NODE_1, label}",
        res.invitation?.toolName === "generate_practice" &&
          res.invitation?.nodeId === NODE_1 &&
          res.invitation?.label === "Try a practice problem",
        JSON.stringify(res.invitation ?? null)
      );
      check(
        "A3-7 loop: settled output + side channel carry ZERO practiceItems",
        (res.output?.practiceItems?.length ?? 0) === 0 && res.practiceItems.length === 0
      );
      check("A3-7 loop: the turn is ok — downgraded, never blocked (no approvalRequired)", res.ok === true && !res.approvalRequired, `ok=${res.ok} err=${res.error ?? ""}`);
      check(
        "A3-7 loop: tutor_tool_downgraded logged with toolName + nodeId + courseId",
        logs.some(
          (l) =>
            l.includes('"tag":"tutor_tool_downgraded"') &&
            l.includes('"toolName":"generate_practice"') &&
            l.includes(NODE_1) &&
            l.includes(COURSE)
        ),
        logs.filter((l) => l.includes("tutor_tool_downgraded")).join(" | ")
      );
      // Round 2 saw the synthetic function_call_output (the model was told to
      // finish its prose turn, not re-asked to run the tool).
      const round2Input = model.getCalls()[1]?.input;
      const sawSynthetic =
        Array.isArray(round2Input) &&
        round2Input.some(
          (it) =>
            it != null &&
            typeof it === "object" &&
            (it as Record<string, unknown>).type === "function_call_output" &&
            String((it as Record<string, unknown>).output ?? "").includes("Converted to a quiet invitation")
        );
      check("A3-7 loop: the synthetic function_call_output was fed back to round 2", sawSynthetic);
    }

    // LOOP-LEVEL Path 2: an invitation_accepted turn EXECUTES the tool and the
    // acceptance instruction rides the per-turn input (never L0).
    {
      const snapshotFx = buildSnapshot();
      const script: MockTurn[] = [
        { toolCalls: [{ name: "generate_practice", arguments: { nodeIds: [NODE_1] } }] },
        {
          text: turnOutputJson({
            proseWithSpanMarkers: `${GROUNDED_OPEN}Here's your practice.${GROUNDED_CLOSE}`,
            citations: [{ lessonId: L1, blockId: B1, slideId: null }],
            rung: 2,
          }),
        },
      ];
      const model = createMockModelClient(script, {
        model: LUNA,
        structured: {
          tutor_practice_gen: JSON.stringify({
            items: [{ nodeId: NODE_1, kind: "mc", prompt: "Where does price settle?", choices: ["a", "b", "c", "d"], correctChoiceIndex: 2 }],
          }),
        },
      });
      const res = await runTutorTurn(
        {
          learnerClient: emptyLearnerClient(),
          serviceClient: capturingServiceClient().client,
          model,
          loadSnapshot: async () => ({ snapshot: snapshotFx }),
          conceptNodes: CONCEPT_NODES,
          conceptEdges: CONCEPT_EDGES,
        },
        {
          userId: USER_A,
          courseId: COURSE,
          publicationId: PUB,
          version: 1,
          lessonId: L1,
          charterRow: CHARTER_ROW("guided_default"),
          historyTurns: [{ role: "learner", content: "prior" }],
          learnerMessage: "Yes, let's try one.",
          initiation: { kind: "invitation_accepted", toolName: "generate_practice", nodeId: NODE_1 },
        }
      );
      check("A3-7 loop: acceptance turn EXECUTES the tool (item minted)", res.practiceItems.length === 1 && res.practiceItems[0].nodeId === NODE_1, `n=${res.practiceItems.length} err=${res.error ?? ""}`);
      check("A3-7 loop: acceptance turn carries NO invitation", (res.invitation ?? null) === null);
      const userItem = (model.getCalls()[0]?.input as unknown[]).find(
        (it) => it != null && typeof it === "object" && (it as Record<string, unknown>).role === "user"
      ) as Record<string, unknown> | undefined;
      check(
        "A3-7 loop: the acceptance instruction rides the per-turn input",
        String(userItem?.content ?? "").includes(
          "The learner accepted your invitation: Try a practice problem on this concept. Deliver it now (call generate_practice for that concept)."
        )
      );
      check("A3-7 loop: system prompt is STILL byte-stable L0 (instruction never in L0)", model.getCalls()[0]?.system === TUTOR_L0);
    }

    // LOOP-LEVEL cooldown: a question turn under an active cooldown carries the
    // suppression instruction, and a model-attached practice strips to NO
    // invitation (A3-10 at the loop surface).
    {
      const { deps, model } = loopDepsWithStructured({
        proseWithSpanMarkers: `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
        citations: [{ lessonId: L1, blockId: B1, slideId: null }],
        rung: 2,
        practiceItems: [policyItem(NODE_1)],
      });
      const res = await runTutorTurn(
        { ...deps },
        {
          userId: USER_A,
          courseId: COURSE,
          publicationId: PUB,
          version: 1,
          lessonId: L1,
          charterRow: CHARTER_ROW("guided_default"),
          historyTurns: [{ role: "learner", content: "prior" }],
          learnerMessage: "and what about elasticity?",
          initiation: { kind: "question" },
          // Two ignored offers already persisted this session → cooldown.
          invitationState: { priorInvitation: null, consecutiveIgnored: 2, cooldownActive: true },
        }
      );
      check("A3-10 loop: cooldown question turn — items stripped AND invitation null", (res.output?.practiceItems?.length ?? 0) === 0 && (res.invitation ?? null) === null, JSON.stringify(res.invitation ?? null));
      const userItem = (model.getCalls()[0]?.input as unknown[]).find(
        (it) => it != null && typeof it === "object" && (it as Record<string, unknown>).role === "user"
      ) as Record<string, unknown> | undefined;
      check(
        "A3-10 loop: the cooldown instruction rides the per-turn input",
        String(userItem?.content ?? "").includes("Do not offer or attach practice this turn.")
      );
    }
  }

  /* ───────── A3-8 · resolveInitiation matrix (regex + acceptance) ────────── */
  console.log("\n— A3-8 · resolveInitiation matrix —");
  {
    // Practice-request regex POSITIVES (unmistakable asks only).
    const positives = [
      "quiz me",
      "Quiz me on this lesson", // the suggestion chip — MUST match
      "test me",
      "give me a practice problem",
      "give me a practice question",
      "give me practice exercises",
      "give me another practice problem",
      "can I practice",
      "let me try one",
      "let me try another",
      "practice this",
    ];
    for (const p of positives) {
      check(`detectPracticeRequest + "${p}"`, detectPracticeRequest(p));
    }
    // NEGATIVES (near-misses stay questions — false-negative bias).
    const negatives = [
      "I practiced yesterday",
      "what is deliberate practice?",
      "is this best practice",
      "how do I test merge conflicts",
      "the quiz merchants of venice",
      "give me the answer",
      "can I practise my English with you", // British spelling deliberately NOT caught (conservative)
      "should I practice more often",
      "what does the practice problem mean",
    ];
    for (const n of negatives) {
      check(`detectPracticeRequest − "${n}"`, !detectPracticeRequest(n));
    }

    // Acceptance validation — matching accepted; mismatched/stale → question.
    const prior: TurnInvitation = { toolName: "generate_practice", nodeId: NODE_1, label: "Try a practice problem" };
    const claim = (toolName: string, nodeId: string) =>
      ({ kind: "invitation_accepted", toolName, nodeId }) as const;

    const okRes = resolveInitiation({ claimed: claim("generate_practice", NODE_1), message: "Yes", priorInvitation: prior });
    check(
      "matching claim → invitation_accepted (toolName + nodeId carried)",
      okRes.kind === "invitation_accepted" && okRes.nodeId === NODE_1 && okRes.toolName === "generate_practice"
    );

    const badTool = resolveInitiation({ claimed: claim("checkUnderstanding", NODE_1), message: "Yes", priorInvitation: prior });
    check("mismatched toolName → question", badTool.kind === "question");

    const badNode = resolveInitiation({ claimed: claim("generate_practice", NODE_2), message: "Yes", priorInvitation: prior });
    check("mismatched nodeId → question", badNode.kind === "question");

    const stale = resolveInitiation({ claimed: claim("generate_practice", NODE_1), message: "Yes", priorInvitation: null });
    check("stale claim (no prior invitation) → question", stale.kind === "question");

    // A claimed acceptance NEVER falls through to practice-request detection —
    // an invalid claim fails toward question even when the message says "quiz me".
    const staleQuiz = resolveInitiation({ claimed: claim("generate_practice", NODE_2), message: "quiz me", priorInvitation: prior });
    check("invalid claim + 'quiz me' message → STILL question (claims never fall through)", staleQuiz.kind === "question");

    const noClaimQuiz = resolveInitiation({ claimed: null, message: "Quiz me on this lesson", priorInvitation: prior });
    check("no claim + chip message → practice_request", noClaimQuiz.kind === "practice_request");

    const plain = resolveInitiation({ claimed: null, message: "what is elasticity?", priorInvitation: prior });
    check("no claim + plain question → question", plain.kind === "question");
  }

  /* ───── A3-9/10/11 · deriveInvitationState (offer/ignore/accept/window) ─── */
  console.log("\n— A3-9/10/11 · deriveInvitationState —");
  {
    const BASE = Date.parse("2026-08-07T12:00:00Z");
    const at = (min: number) => new Date(BASE + min * 60_000).toISOString();
    const INV: TurnInvitation = { toolName: "generate_practice", nodeId: NODE_1, label: "Try a practice problem" };
    const ACCEPT = { kind: "invitation_accepted", toolName: "generate_practice", nodeId: NODE_1 };
    const learnerT = (min: number, initiation?: unknown): SessionTurn => ({
      role: "learner",
      content: "m",
      createdAt: at(min),
      grounding: initiation ? { initiation } : {},
    });
    const assistantT = (min: number, invitation?: TurnInvitation): SessionTurn => ({
      role: "assistant",
      content: "a",
      createdAt: at(min),
      grounding: invitation ? { invitation } : {},
    });

    // (1) offered → ignored by the next learner turn; prior null (learner after).
    const s1 = deriveInvitationState([learnerT(0), assistantT(1, INV), learnerT(2)], at(3));
    check("offer ignored by the next learner turn → consecutiveIgnored 1", s1.consecutiveIgnored === 1 && !s1.cooldownActive, JSON.stringify(s1));
    check("ignored offer is NOT the priorInvitation (learner turn between)", s1.priorInvitation === null);

    // (2) pending trailing offer: not counted, IS the priorInvitation; the
    //     effective cooldown folds it in on a question turn (0 persisted + 1
    //     pending = 1 < 2 → still no cooldown).
    const s2 = deriveInvitationState([learnerT(0), assistantT(1, INV)], at(2));
    check("pending trailing offer → priorInvitation set, count 0", s2.priorInvitation?.nodeId === NODE_1 && s2.consecutiveIgnored === 0, JSON.stringify(s2));
    check("effectiveCooldown: 0 persisted + 1 pending on a question turn → false", effectiveCooldown(s2, { kind: "question" }) === false);
    check("effectiveCooldown: acceptance resets (never cooldown on Path 2)", effectiveCooldown(s2, { kind: "invitation_accepted", toolName: "generate_practice", nodeId: NODE_1 }) === false);

    // (3) two ignored + a pending third → persisted cooldown ACTIVE at 2, and
    //     the effective view (question) is 3.
    const s3 = deriveInvitationState(
      [assistantT(0, INV), learnerT(1), assistantT(2, INV), learnerT(3), assistantT(4, INV)],
      at(5)
    );
    check("two ignored offers → cooldownActive (threshold 2)", s3.consecutiveIgnored === 2 && s3.cooldownActive === true, JSON.stringify(s3));
    check("pending third offer is the priorInvitation", s3.priorInvitation?.nodeId === NODE_1);
    check("INVITATION_COOLDOWN_IGNORES === 2", INVITATION_COOLDOWN_IGNORES === 2);

    // (3b) the SECOND brush-off happens on the CURRENT message: 1 persisted
    //      ignore + 1 pending offer + a question message → effective cooldown.
    const s3b = deriveInvitationState(
      [assistantT(0, INV), learnerT(1), assistantT(2, INV)],
      at(3)
    );
    check(
      "1 ignored + 1 pending + question message → EFFECTIVE cooldown (suppressed THIS turn, not one late)",
      s3b.consecutiveIgnored === 1 && effectiveCooldown(s3b, { kind: "question" }) === true,
      JSON.stringify(s3b)
    );

    // (4) acceptance RESETS the run (trailing-run semantics).
    const s4 = deriveInvitationState(
      [assistantT(0, INV), learnerT(1), assistantT(2, INV), learnerT(3, ACCEPT), assistantT(4, INV), learnerT(5)],
      at(6)
    );
    check("ignored → accepted → ignored ⇒ trailing run is 1 (acceptance reset)", s4.consecutiveIgnored === 1 && !s4.cooldownActive, JSON.stringify(s4));

    // (5) an explicit practice_request RESETS the run.
    const s5 = deriveInvitationState(
      [assistantT(0, INV), learnerT(1), assistantT(2, INV), learnerT(3), learnerT(4, { kind: "practice_request" })],
      at(5)
    );
    check("learner practice_request resets the ignore run to 0", s5.consecutiveIgnored === 0 && !s5.cooldownActive, JSON.stringify(s5));

    // (6) the 30-min session window: a silent thread is an EMPTY session — the
    //     lifecycle (incl. the prior offer) resets like every session behavior.
    const s6 = deriveInvitationState([assistantT(0, INV)], at(31));
    check("newest turn ≥30 min old → empty session: no prior offer, count 0", s6.priorInvitation === null && s6.consecutiveIgnored === 0, JSON.stringify(s6));
    // A ≥30-min gap INSIDE the thread excludes everything before it.
    const s7 = deriveInvitationState([assistantT(0, INV), learnerT(40), assistantT(41, INV)], at(42));
    check(
      "a ≥30-min gap excludes pre-gap offers; the in-session pending offer stands",
      s7.consecutiveIgnored === 0 && s7.priorInvitation?.nodeId === NODE_1,
      JSON.stringify(s7)
    );

    // (7) A3-11 discard: acceptance validates against the IMMEDIATELY-prior
    //     turn only — an offer with a learner turn after it is unclaimable.
    const s8 = deriveInvitationState([assistantT(0, INV), learnerT(1)], at(2));
    const discarded = resolveInitiation({
      claimed: { kind: "invitation_accepted", toolName: "generate_practice", nodeId: NODE_1 },
      message: "actually about that invitation...",
      priorInvitation: s8.priorInvitation,
    });
    check("A3-11: an offer answered by ANY learner message is unclaimable → question", s8.priorInvitation === null && discarded.kind === "question");
    // ...and an intervening assistant turn WITHOUT an invitation also clears it.
    const s9 = deriveInvitationState([assistantT(0, INV), learnerT(1), assistantT(2)], at(3));
    check("A3-11: a later assistant turn without an offer → priorInvitation null", s9.priorInvitation === null, JSON.stringify(s9));
  }

  /* ────────── A3 Wave 4 · renderStructure / checkUnderstanding / sequenceTask ── */
  console.log("\n— A3 Wave 4 · structure + assessment tools —");
  {
    const deps = baseToolDeps();

    /* ── A3-13 · checkUnderstanding schema REJECTS a missing-misconception distractor
     *    and ACCEPTS a fully-labeled one. ── */
    const cuTool = A3_WAVE4_TOOLS.checkUnderstanding;
    const badCheck = {
      conceptSlug: NODE_1,
      stem: "Where does price settle?",
      options: [
        { id: "a", text: "At equilibrium", correct: true, feedback: "Right — supply meets demand." },
        // A wrong option with NO misconceptionId → A3-13 must reject at parse.
        { id: "b", text: "Above equilibrium", correct: false, feedback: "Not quite." },
        { id: "c", text: "Below equilibrium", correct: false, misconceptionId: "confuses-shortage", feedback: "Think about surplus." },
      ],
    };
    check("A3-13: checkUnderstanding schema REJECTS a wrong option with no misconceptionId", !cuTool.params.safeParse(badCheck).success);

    const goodCheck = {
      conceptSlug: NODE_1,
      stem: "Where does price settle?",
      options: [
        { id: "a", text: "At equilibrium", correct: true, feedback: "Right — supply meets demand." },
        { id: "b", text: "Above equilibrium", correct: false, misconceptionId: "price-only-rises", feedback: "That would create a surplus." },
        { id: "c", text: "Below equilibrium", correct: false, misconceptionId: "price-only-falls", feedback: "That would create a shortage." },
      ],
      collectConfidence: true,
    };
    check("A3-13: checkUnderstanding schema ACCEPTS a fully-labeled item", cuTool.params.safeParse(goodCheck).success);

    // Executing a good check mints a cardId + carries the answer key + every wrong
    // option's misconceptionId; a correct option's misconceptionId is null.
    const cuOut = await cuTool.execute(cuTool.params.parse(goodCheck) as never, deps);
    const cuCard = (cuOut.data as { assessment: CheckUnderstandingCard }).assessment;
    check(
      "A3-13: checkUnderstanding card mints a cardId + preserves the key + wrong-option misconceptions",
      typeof cuCard.cardId === "string" &&
        cuCard.cardId.length > 0 &&
        cuCard.toolName === "checkUnderstanding" &&
        cuCard.conceptSlug === NODE_1 &&
        cuCard.options.find((o) => o.id === "a")?.misconceptionId === null &&
        cuCard.options.find((o) => o.id === "b")?.misconceptionId === "price-only-rises",
      JSON.stringify(cuCard.options.map((o) => [o.id, o.misconceptionId]))
    );

    // A check with NO correct option is rejected (unusable key).
    const noKey = {
      conceptSlug: NODE_1,
      stem: "?",
      options: [
        { id: "a", text: "x", correct: false, misconceptionId: "m1", feedback: "f" },
        { id: "b", text: "y", correct: false, misconceptionId: "m2", feedback: "f" },
        { id: "c", text: "z", correct: false, misconceptionId: "m3", feedback: "f" },
      ],
    };
    check("A3-13: checkUnderstanding schema REJECTS an item with no correct option", !cuTool.params.safeParse(noKey).success);

    /* ── sequenceTask schema: correctOrder must be a permutation of item ids. ── */
    const seqTool = A3_WAVE4_TOOLS.sequenceTask;
    const goodSeq = {
      conceptSlug: NODE_1,
      prompt: "Order the steps.",
      items: [
        { id: "s1", text: "Read input" },
        { id: "s2", text: "Process" },
        { id: "s3", text: "Write output" },
      ],
      correctOrder: ["s1", "s2", "s3"],
      partialCreditRule: "adjacent-pairs" as const,
    };
    check("sequenceTask schema ACCEPTS a valid permutation", seqTool.params.safeParse(goodSeq).success);
    check(
      "sequenceTask schema REJECTS correctOrder that isn't a permutation of item ids",
      !seqTool.params.safeParse({ ...goodSeq, correctOrder: ["s1", "s2", "s2"] }).success &&
        !seqTool.params.safeParse({ ...goodSeq, correctOrder: ["s1", "s2"] }).success &&
        !seqTool.params.safeParse({ ...goodSeq, correctOrder: ["s1", "s2", "sX"] }).success
    );
    const seqOut = await seqTool.execute(seqTool.params.parse(goodSeq) as never, deps);
    const seqCard = (seqOut.data as { assessment: SequenceTaskCard }).assessment;
    check(
      "sequenceTask card mints a cardId + carries items + correctOrder + rule",
      typeof seqCard.cardId === "string" &&
        seqCard.toolName === "sequenceTask" &&
        seqCard.items.length === 3 &&
        seqCard.correctOrder.join(",") === "s1,s2,s3" &&
        seqCard.partialCreditRule === "adjacent-pairs"
    );

    /* ── A3-15 · the pure scoreSequence scorer matrix. ── */
    const CO = ["a", "b", "c", "d"];
    check("A3-15: exact all-right → demonstrated", scoreSequence(CO, ["a", "b", "c", "d"], "exact") === "demonstrated");
    check("A3-15: exact one swap → not_demonstrated (no partial for exact)", scoreSequence(CO, ["b", "a", "c", "d"], "exact") === "not_demonstrated");
    check("A3-15: adjacent-pairs all-right → demonstrated", scoreSequence(CO, ["a", "b", "c", "d"], "adjacent-pairs") === "demonstrated");
    check(
      "A3-15: adjacent-pairs one misplaced (2/3 pairs) → partial",
      scoreSequence(CO, ["a", "b", "d", "c"], "adjacent-pairs") === "partial",
      scoreSequence(CO, ["a", "b", "d", "c"], "adjacent-pairs")
    );
    check("A3-15: adjacent-pairs reversed → not_demonstrated", scoreSequence(CO, ["d", "c", "b", "a"], "adjacent-pairs") === "not_demonstrated");
    // The middle-transposition case that split the server/client scorers before
    // consolidation: b,c swapped keeps 2/3 relative orders → partial (NOT the
    // adjacency metric's total failure). This pins the relative-order definition
    // that AGREES with the client twin scoreSequenceCard.
    check(
      "A3-15: adjacent-pairs middle transposition a,c,b,d → partial (relative-order metric)",
      scoreSequence(CO, ["a", "c", "b", "d"], "adjacent-pairs") === "partial",
      scoreSequence(CO, ["a", "c", "b", "d"], "adjacent-pairs")
    );
    // A non-permutation submission never passes.
    check("A3-15: a non-permutation submission → not_demonstrated", scoreSequence(CO, ["a", "b", "c"], "adjacent-pairs") === "not_demonstrated");

    /* ── renderStructure: each kind builds + validates; the built diagram ships. ── */
    const rsTool = A3_WAVE4_TOOLS.renderStructure;
    const treeArgs = {
      kind: "tree" as const,
      title: "Recursion",
      caption: "The recursion tree",
      tree: { root: { label: "f(3)", children: [{ label: "f(2)" }, { label: "f(1)" }] } },
    };
    const treeOut = await rsTool.execute(rsTool.params.parse(treeArgs) as never, deps);
    const treeCard = (treeOut.data as { structure: RenderStructureCard }).structure;
    check(
      "renderStructure tree → a valid tree_diagram ships (kind mapped)",
      treeCard.diagram?.kind === "tree_diagram" && treeCard.title === "Recursion"
    );
    const axesArgs = {
      kind: "axes" as const,
      axes: {
        xLabel: "x",
        yLabel: "y",
        xRange: { min: 0, max: 10 },
        yRange: { min: 0, max: 10 },
        series: [{ label: "line", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
      },
    };
    const axesOut = await rsTool.execute(rsTool.params.parse(axesArgs) as never, deps);
    check("renderStructure axes → coordinate_plot", (axesOut.data as { structure: RenderStructureCard }).structure.diagram?.kind === "coordinate_plot");
    const timelineArgs = {
      kind: "timeline" as const,
      timeline: { points: [{ label: "1990" }, { label: "2000" }, { label: "2010" }] },
    };
    const tlOut = await rsTool.execute(rsTool.params.parse(timelineArgs) as never, deps);
    const tlCard = (tlOut.data as { structure: RenderStructureCard }).structure;
    check("renderStructure timeline → number_line with ordered labeled points", tlCard.diagram?.kind === "number_line" && tlCard.diagram !== null);
    const graphArgs = {
      kind: "graph" as const,
      graph: {
        weighted: true,
        nodes: [{ id: "A" }, { id: "B" }],
        edges: [{ from: "A", to: "B", weight: 3 }],
      },
    };
    const graphOut = await rsTool.execute(rsTool.params.parse(graphArgs) as never, deps);
    check(
      "renderStructure graph (weighted, every edge weighted) → graph_diagram",
      (graphOut.data as { structure: RenderStructureCard }).structure.diagram?.kind === "graph_diagram"
    );
    // A missing body for the chosen kind drops-and-flags (no throw).
    const noBodyOut = await rsTool.execute(rsTool.params.parse({ kind: "tree" }) as never, deps);
    check(
      "renderStructure with kind but no body → dropped (diagram null)",
      (noBodyOut.data as { structure: RenderStructureCard }).structure.diagram === null
    );

    /* ── A3-24 · a malformed spec → dropped (diagram null + error), NEVER throws. ──
     *    A weighted graph with an UNWEIGHTED edge fails validateDiagram; the tool
     *    drops-and-flags rather than throwing. ── */
    const logsRS: string[] = [];
    const origLogRS = console.log;
    console.log = (...a: unknown[]) => { logsRS.push(a.map(String).join(" ")); };
    let badRsOut!: Awaited<ReturnType<typeof rsTool.execute>>;
    try {
      badRsOut = await rsTool.execute(
        rsTool.params.parse({
          kind: "graph",
          graph: {
            weighted: true,
            nodes: [{ id: "A" }, { id: "B" }],
            edges: [{ from: "A", to: "B" }], // no weight → invalid for a weighted graph
          },
        }) as never,
        deps
      );
    } finally {
      console.log = origLogRS;
    }
    const badCard = (badRsOut.data as { structure: RenderStructureCard; error?: string });
    check("A3-24: a malformed renderStructure spec drops-and-flags (diagram null + error)", badCard.structure.diagram === null && typeof badCard.error === "string");
    check("A3-24: tutor_structure_dropped logged, tool never threw", logsRS.some((l) => l.includes('"tag":"tutor_structure_dropped"')));

    /* ── A3-12 · renderStructure SURVIVES a question turn (structures pass through;
     *    assessments forced []). Drive the full loop with a scripted renderStructure
     *    tool call on a QUESTION turn, then a grounded final. ── */
    {
      const snapshotFx = buildSnapshot();
      const script: MockTurn[] = [
        {
          toolCalls: [
            {
              name: "renderStructure",
              arguments: { kind: "tree", title: "T", tree: { root: { label: "root", children: [{ label: "L" }, { label: "R" }] } } },
            },
          ],
        },
        {
          text: turnOutputJson({
            proseWithSpanMarkers: `${GROUNDED_OPEN}Here is the structure.${GROUNDED_CLOSE}`,
            citations: [{ lessonId: L1, blockId: B1, slideId: null }],
            rung: 2,
          }),
        },
      ];
      const model = createMockModelClient(script, { model: LUNA });
      const res = await runTutorTurn(
        {
          learnerClient: emptyLearnerClient(),
          serviceClient: capturingServiceClient().client,
          model,
          loadSnapshot: async () => ({ snapshot: snapshotFx }),
          conceptNodes: CONCEPT_NODES,
          conceptEdges: CONCEPT_EDGES,
        },
        {
          userId: USER_A,
          courseId: COURSE,
          publicationId: PUB,
          version: 1,
          lessonId: L1,
          charterRow: CHARTER_ROW("guided_default"),
          historyTurns: [{ role: "learner", content: "prior" }],
          learnerMessage: "draw me the recursion tree",
          // initiation omitted → { kind: "question" }
        }
      );
      check("A3-12: renderStructure EXECUTES on a question turn (never intercepted)", res.ok === true && res.structures.length === 1, `ok=${res.ok} n=${res.structures.length} err=${res.error ?? ""}`);
      check("A3-12: the structure passes through to the settled turn (tree_diagram)", res.structures[0]?.diagram?.kind === "tree_diagram");
      check("A3-12: a question turn forces assessments []", res.assessments.length === 0);
      check("A3-12: renderStructure carries NO invitation (Class P, not gated)", (res.invitation ?? null) === null);
    }

    /* ── downgrade-of-checkUnderstanding-on-a-question-turn: the intercept converts
     *    the Class-A call to an invitation NAMING checkUnderstanding (never executes
     *    the tool), and firstNodeIdFromArgs reads conceptSlug so the node rides. ── */
    {
      const snapshotFx = buildSnapshot();
      const script: MockTurn[] = [
        {
          toolCalls: [
            {
              name: "checkUnderstanding",
              arguments: {
                conceptSlug: NODE_1,
                stem: "Where does price settle?",
                options: [
                  { id: "a", text: "At equilibrium", correct: true, feedback: "Right." },
                  { id: "b", text: "Above", correct: false, misconceptionId: "m1", feedback: "No." },
                  { id: "c", text: "Below", correct: false, misconceptionId: "m2", feedback: "No." },
                ],
              },
            },
          ],
        },
        {
          text: turnOutputJson({
            proseWithSpanMarkers: `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
            citations: [{ lessonId: L1, blockId: B1, slideId: null }],
            rung: 1,
          }),
        },
      ];
      const model = createMockModelClient(script, { model: LUNA });
      const logsDG: string[] = [];
      const origLogDG = console.log;
      console.log = (...a: unknown[]) => { logsDG.push(a.map(String).join(" ")); };
      let res!: Awaited<ReturnType<typeof runTutorTurn>>;
      try {
        res = await runTutorTurn(
          {
            learnerClient: emptyLearnerClient(),
            serviceClient: capturingServiceClient().client,
            model,
            loadSnapshot: async () => ({ snapshot: snapshotFx }),
            conceptNodes: CONCEPT_NODES,
            conceptEdges: CONCEPT_EDGES,
          },
          {
            userId: USER_A,
            courseId: COURSE,
            publicationId: PUB,
            version: 1,
            lessonId: L1,
            charterRow: CHARTER_ROW("guided_default"),
            historyTurns: [{ role: "learner", content: "prior" }],
            learnerMessage: "why does price settle there?",
          }
        );
      } finally {
        console.log = origLogDG;
      }
      check("downgrade: checkUnderstanding on a question turn is NOT executed (no assessment)", res.assessments.length === 0);
      check(
        "downgrade: the invitation NAMES checkUnderstanding + carries the conceptSlug node (firstNodeIdFromArgs reads conceptSlug)",
        res.invitation?.toolName === "checkUnderstanding" && res.invitation?.nodeId === NODE_1,
        JSON.stringify(res.invitation ?? null)
      );
      check("downgrade: the turn still settles ok (downgraded, never blocked)", res.ok === true && !res.approvalRequired, `ok=${res.ok} err=${res.error ?? ""}`);
      check("downgrade: tutor_tool_downgraded logged for checkUnderstanding", logsDG.some((l) => l.includes('"tag":"tutor_tool_downgraded"') && l.includes('"toolName":"checkUnderstanding"')));
    }

    /* ── acceptance path: an invitation_accepted turn EXECUTES checkUnderstanding →
     *    the card surfaces on `assessments`, stamped with the acceptance initiation,
     *    and NO invitation. ── */
    {
      const snapshotFx = buildSnapshot();
      const script: MockTurn[] = [
        {
          toolCalls: [
            {
              name: "checkUnderstanding",
              arguments: {
                conceptSlug: NODE_1,
                stem: "Where does price settle?",
                options: [
                  { id: "a", text: "At equilibrium", correct: true, feedback: "Right." },
                  { id: "b", text: "Above", correct: false, misconceptionId: "m1", feedback: "No." },
                  { id: "c", text: "Below", correct: false, misconceptionId: "m2", feedback: "No." },
                ],
              },
            },
          ],
        },
        {
          text: turnOutputJson({
            proseWithSpanMarkers: `${GROUNDED_OPEN}Here's a quick check.${GROUNDED_CLOSE}`,
            citations: [{ lessonId: L1, blockId: B1, slideId: null }],
            rung: 2,
          }),
        },
      ];
      const model = createMockModelClient(script, { model: LUNA });
      const res = await runTutorTurn(
        {
          learnerClient: emptyLearnerClient(),
          serviceClient: capturingServiceClient().client,
          model,
          loadSnapshot: async () => ({ snapshot: snapshotFx }),
          conceptNodes: CONCEPT_NODES,
          conceptEdges: CONCEPT_EDGES,
        },
        {
          userId: USER_A,
          courseId: COURSE,
          publicationId: PUB,
          version: 1,
          lessonId: L1,
          charterRow: CHARTER_ROW("guided_default"),
          historyTurns: [{ role: "learner", content: "prior" }],
          learnerMessage: "yes, check me",
          initiation: { kind: "invitation_accepted", toolName: "checkUnderstanding", nodeId: NODE_1 },
        }
      );
      const asmt = res.assessments[0] as AssessmentCard | undefined;
      check("acceptance: checkUnderstanding EXECUTES → one assessment card", res.assessments.length === 1 && asmt?.toolName === "checkUnderstanding", `n=${res.assessments.length} err=${res.error ?? ""}`);
      check("acceptance: the card's initiation is stamped invitation_accepted by the sink", asmt?.initiation === "invitation_accepted", JSON.stringify(asmt?.initiation));
      check("acceptance: the delivery turn carries NO invitation", (res.invitation ?? null) === null);
      // The acceptance instruction NAMES the mapped tool (checkUnderstanding), not generate_practice.
      const userItem = (model.getCalls()[0]?.input as unknown[]).find(
        (it) => it != null && typeof it === "object" && (it as Record<string, unknown>).role === "user"
      ) as Record<string, unknown> | undefined;
      check("acceptance: the per-turn instruction names checkUnderstanding (not generate_practice)", String(userItem?.content ?? "").includes("call checkUnderstanding for that concept"));
    }

    /* ── R-2 · the MAIN tutor turn is dispatched with store:true (the chaining seam
     *    is live). Inspect the mock's captured params. ── */
    {
      const { deps, model } = loopDepsWithStructured({
        proseWithSpanMarkers: `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
        citations: [{ lessonId: L1, blockId: B1, slideId: null }],
        rung: 2,
      });
      await runTutorTurn(
        { ...deps },
        {
          userId: USER_A,
          courseId: COURSE,
          publicationId: PUB,
          version: 1,
          lessonId: L1,
          charterRow: CHARTER_ROW("guided_default"),
          historyTurns: [{ role: "learner", content: "prior" }],
          learnerMessage: "why?",
        }
      );
      const mainCall = model.getCalls().find((c) => c.responseFormat?.name === "tutor_turn_output");
      check("R-2: the MAIN tutor_turn call is dispatched with store:true", mainCall?.store === true, JSON.stringify({ store: mainCall?.store }));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
