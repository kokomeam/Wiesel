/**
 * TUTOR-1 Wave 3 (package C2) — the LIVE tutor runtime PURE suite (no key, no DB,
 * no browser). Drives the FIVE tools + the bounded tool loop + prompt assembly +
 * scaffolding + grounding over a hand-built snapshot fixture, with the mock
 * ModelClient's scripted/structured seam. Sections:
 *
 *   AC-T3.2  Prompt assembly — two DIFFERENT learners on the SAME (publication,
 *            lesson, charter) share BYTE-IDENTICAL system + developer; only the
 *            input (L3/L4/message) differs. TUTOR_L0 ≥ 4096 chars;
 *            TUTOR_PROMPT_VERSION === "tutor-v1".
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
import { buildSnapshotIndex, parseSpans } from "@/lib/tutor/runtime/grounding";
import { serializeHistory, collapseToChaining, type HistoryTurn } from "@/lib/tutor/runtime/history";
import { TUTOR_MASTERY_THRESHOLD } from "@/lib/tutor/mastery/config";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import {
  GROUNDED_OPEN,
  GROUNDED_CLOSE,
  SUPPLEMENTAL_OPEN,
  SUPPLEMENTAL_CLOSE,
  TurnOutputSchema,
  type TurnOutput,
} from "@/lib/tutor/runtime/outputContract";

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
  check("TUTOR_PROMPT_VERSION === tutor-v1", TUTOR_PROMPT_VERSION === "tutor-v1");
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
    "TUTOR_TOOL_NAMES is exactly the five (order-insensitive)",
    new Set(TUTOR_TOOL_NAMES).size === 5 &&
      ["get_lesson_context", "get_mastery_summary", "generate_practice", "emit_evidence", "propose_escalation"].every((n) =>
        (TUTOR_TOOL_NAMES as readonly string[]).includes(n)
      ),
    TUTOR_TOOL_NAMES.join(",")
  );

  // Every tool's zod → toStrictJsonSchema without throw.
  let schemaOk = true;
  for (const name of TUTOR_TOOL_NAMES) {
    try {
      toStrictJsonSchema(TUTOR_TOOLS[name].params as z.ZodType);
    } catch {
      schemaOk = false;
    }
  }
  check("all five tool param schemas convert to strict JSON schema", schemaOk);

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

    // Budget drop-oldest: a tight budget drops the oldest whole turns.
    const tight = serializeHistory(turns, 60);
    check("tight budget drops oldest whole turns", tight.length <= 60 && tight.includes("turn 12"), `len=${tight.length}`);
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
