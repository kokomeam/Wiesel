/**
 * TUTOR-1 Wave 3 (W3.5) — SESSION BEHAVIORS + ASSESSMENT INTEGRITY, PURE suite
 * (no key, no DB, no browser). Drives session.ts derivation goldens and the two
 * loop hooks over the mock ModelClient. Sections:
 *
 *   SESSION   deriveSessionState goldens — the 30-min gap-window boundary
 *             (29-min in, 31-min out), marker detection off grounding.sessionMarkers,
 *             the decline regex ±, and empty/one-turn/long-silence edges;
 *             shouldInterjectRootCause gate (once + declined-suppresses +
 *             root-cause-is-lesson-node → no offer).
 *   AC-T3.7   A scripted 3-turn session over the mock: turn 1 (root cause present)
 *             → the interjection INSTRUCTION is in the model input (captured via
 *             getCalls) + the marker is stamped on the result; turn 2 (same session,
 *             marker in history) → NOT offered again; a DECLINED variant → suppressed;
 *             a NEW session (31-min gap) → offered again exactly once.
 *   AC-T3.8   quizActive + concept_review_only: "just show me the answer" → rung
 *             CLAMPED ≤3 + the defer copy present; a general concept question
 *             (quizActive) → answered normally (scripted rung 2 passes through);
 *             assessment_help 'block' + quizActive → typed refusal, ZERO mock model
 *             calls, ZERO evidence; quizActive false → rung 4 on explicit ask works
 *             (the W3.3 behavior intact).
 *
 * Run: `npx tsx scripts/verify-tutor-session.ts`
 */

// Deterministic env BEFORE any tutor import reads it.
delete process.env.TUTOR_ENABLE_CHAINING;

import { createMockModelClient } from "@/lib/ai/providers/mock";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import type { PublicationSnapshot, PublishedLessonBlock } from "@/lib/course/publish/schemas";
import type { Database } from "@/lib/database.types";

import { runTutorTurn } from "@/lib/tutor/runtime/loop";
import {
  ASSESSMENT_ACTIVE_MAX_RUNG,
  ASSESSMENT_DEFER_COPY,
  ASSESSMENT_BLOCK_COPY,
  assessmentDeferCopy,
} from "@/lib/tutor/runtime/loop";
import {
  deriveSessionState,
  shouldInterjectRootCause,
  sessionMarkersOf,
  SESSION_GAP_MS,
  ROOT_CAUSE_INTERJECTION_MARKER,
  INTERJECTION_DECLINE_RE,
  type SessionTurn,
} from "@/lib/tutor/runtime/session";
import type { LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import type { GuidanceStyle } from "@/lib/tutor/runtime/charter";
import {
  GROUNDED_OPEN,
  GROUNDED_CLOSE,
  type TurnOutput,
} from "@/lib/tutor/runtime/outputContract";
import type { HistoryTurn } from "@/lib/tutor/runtime/history";
import type { TutorToolDeps } from "@/lib/tutor/runtime/tools";

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

const LUNA = TUTOR_MODELS.tutor_turn.model;
const COURSE = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const USER_A = "33333333-3333-4333-8333-333333333333";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";
const B1 = "bbbbbbbb-0000-4000-8000-000000000001"; // lesson-1 block
const B2 = "bbbbbbbb-0000-4000-8000-000000000002"; // lesson-2 block
const NODE_SURFACE = "cccccccc-0000-4000-8000-000000000001"; // anchored to L1 (the surface)
const NODE_ROOT = "cccccccc-0000-4000-8000-000000000002"; // anchored to L2 (the upstream root cause)

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
            objective: "Explain how price emerges.",
            order: 0,
            blocks: [lectureBlock(B1, "The market", "Price is set where supply meets demand at equilibrium.")],
          },
          {
            id: L2,
            type: "lesson",
            title: "Fractions",
            objective: "The upstream prerequisite.",
            order: 1,
            blocks: [lectureBlock(B2, "Fractions", "A fraction expresses a part of a whole.")],
          },
        ],
      },
    ],
  };
}

/** Two nodes: NODE_SURFACE anchored to L1 (this lesson), NODE_ROOT anchored to L2
 *  (upstream). NODE_ROOT is a prerequisite of NODE_SURFACE, so a below-mastery
 *  NODE_ROOT is the root cause of a struggle on NODE_SURFACE. */
const CONCEPT_NODES: LessonConceptNode[] = [
  { id: NODE_SURFACE, title: "Equilibrium", description: "Where supply meets demand.", anchors: [{ lessonId: L1, blockId: B1 }] },
  { id: NODE_ROOT, title: "Fractions", description: "Parts of a whole.", anchors: [{ lessonId: L2, blockId: B2 }] },
];
// NODE_ROOT is a PREREQUISITE OF NODE_SURFACE (edge source → target).
const CONCEPT_EDGES: EdgeLike[] = [{ sourceNodeId: NODE_ROOT, targetNodeId: NODE_SURFACE, kind: "prerequisite" }];

const CHARTER_ROW = (
  style: GuidanceStyle,
  canon: "strict" | "open" = "open",
  assessmentHelp: "block" | "concept_review_only" = "concept_review_only",
  toneNotes: string | null = null
): Database["public"]["Tables"]["tutor_course_settings"]["Row"] => ({
  assessment_help: assessmentHelp,
  budget_limit_usd: null,
  course_canon: canon,
  course_id: COURSE,
  created_at: "2026-08-04T00:00:00Z",
  current_charter_version_id: null,
  enabled: true,
  escalation_sensitivity: "default",
  guidance_style: style,
  scope: "course_only",
  tone_notes: toneNotes,
  updated_at: "2026-08-04T00:00:00Z",
});

/* ──────────────── learner-scoped stub returning REAL mastery ─────────────── */

/** A learner-scoped stub whose learner_mastery read returns the given rows, so
 *  the loop's gatherLearnerState computes a real root cause. my_review_queue is
 *  empty. `masteryRows` is [{node_id, decayed_p}]. */
function masteryLearnerClient(masteryRows: Array<{ node_id: string; decayed_p: number }>) {
  return {
    rpc: async () => ({ data: [], error: null }),
    from: (table: string) => ({
      select: () => ({
        eq: async () => ({
          data: table === "learner_mastery" ? masteryRows : [],
          error: null,
        }),
      }),
    }),
  } as unknown as TutorToolDeps["learnerClient"];
}

function capturingServiceClient() {
  return {
    from() {
      return {
        insert() {
          return { select: () => ({ single: async () => ({ data: { id: "escalation-id-1" }, error: null }) }) };
        },
      };
    },
  } as unknown as TutorToolDeps["serviceClient"];
}

function turnOutputJson(o: Partial<TurnOutput>): string {
  const full: TurnOutput = {
    proseWithSpanMarkers: o.proseWithSpanMarkers ?? `${GROUNDED_OPEN}Price settles at equilibrium.${GROUNDED_CLOSE}`,
    citations: o.citations ?? [{ lessonId: L1, blockId: B1, slideId: null }],
    rung: o.rung ?? 2,
    evidence: o.evidence ?? [],
    practiceItems: o.practiceItems,
    escalationProposal: o.escalationProposal ?? null,
  };
  return JSON.stringify(full);
}

/** Build a loop deps whose mock returns a fixed structured turn. `mastery` seeds
 *  the learner client so a root cause can be derived. */
function loopDeps(
  turnOutput: Partial<TurnOutput>,
  mastery: Array<{ node_id: string; decayed_p: number }> = []
) {
  const snapshot = buildSnapshot();
  const model = createMockModelClient([], {
    model: LUNA,
    structured: { tutor_turn_output: turnOutputJson(turnOutput) },
  });
  return {
    deps: {
      learnerClient: masteryLearnerClient(mastery),
      serviceClient: capturingServiceClient(),
      model,
      loadSnapshot: async () => ({ snapshot }),
      conceptNodes: CONCEPT_NODES,
      conceptEdges: CONCEPT_EDGES,
    },
    model,
  };
}

/** All user-input strings the mock saw (the per-turn input carries the behavior
 *  instructions). */
function userInputs(model: ReturnType<typeof createMockModelClient>): string[] {
  const out: string[] = [];
  for (const call of model.getCalls()) {
    for (const item of call.input) {
      if ("role" in item && item.role === "user") out.push(item.content);
    }
  }
  return out;
}

/** A ctx builder — history turns carry createdAt so session derivation works. */
function ctxWith(overrides: {
  historyTurns?: HistoryTurn[];
  quizActive?: boolean;
  charterRow?: Database["public"]["Tables"]["tutor_course_settings"]["Row"];
  learnerMessage?: string;
  nowIso?: string;
}) {
  return {
    userId: USER_A,
    courseId: COURSE,
    publicationId: PUB,
    version: 1,
    lessonId: L1,
    quizActive: overrides.quizActive,
    charterRow: overrides.charterRow ?? CHARTER_ROW("guided_default"),
    historyTurns: overrides.historyTurns ?? [{ role: "learner" as const, content: "prior", createdAt: "2026-08-04T10:00:00Z" }],
    learnerMessage: overrides.learnerMessage ?? "help me",
  };
}

/* ──────────────── mastery that makes NODE_ROOT the root cause ─────────────── */

// Surface node struggling (below mastery); root node ALSO below mastery + upstream
// → rootCause() walks to NODE_ROOT.
const ROOT_CAUSE_MASTERY = [
  { node_id: NODE_SURFACE, decayed_p: 0.3 },
  { node_id: NODE_ROOT, decayed_p: 0.2 },
];

/* ───────────────────────────────── main ─────────────────────────────────── */

async function main() {
  /* ─────────────────────────── SESSION derivation ─────────────────────── */
  console.log("\n— session derivation goldens —");

  check("SESSION_GAP_MS is 30 minutes", SESSION_GAP_MS === 30 * 60 * 1000);

  const T = (mins: number) => new Date(Date.UTC(2026, 7, 4, 10, mins, 0)).toISOString();

  // 29-min gap → SAME session (both turns kept).
  {
    const turns: SessionTurn[] = [
      { role: "learner", content: "a", createdAt: T(0) },
      { role: "learner", content: "b", createdAt: T(29) },
    ];
    const st = deriveSessionState(turns, T(29)); // now = newest turn
    check("29-min gap stays in-session (2 turns)", st.sessionTurns.length === 2, `len=${st.sessionTurns.length}`);
  }

  // 31-min gap → NEW session (only the newest turn).
  {
    const turns: SessionTurn[] = [
      { role: "learner", content: "a", createdAt: T(0) },
      { role: "learner", content: "b", createdAt: T(31) },
    ];
    const st = deriveSessionState(turns, T(31));
    check("31-min gap breaks the session (1 turn)", st.sessionTurns.length === 1, `len=${st.sessionTurns.length}`);
    check("31-min gap: only the newest turn survives", st.sessionTurns[0]?.content === "b");
  }

  // EXACTLY 30 min → new session (boundary is `< 30min` to stay in-session).
  {
    const turns: SessionTurn[] = [
      { role: "learner", content: "a", createdAt: T(0) },
      { role: "learner", content: "b", createdAt: T(30) },
    ];
    const st = deriveSessionState(turns, T(30));
    check("EXACTLY 30-min gap starts a new session (1 turn)", st.sessionTurns.length === 1, `len=${st.sessionTurns.length}`);
  }

  // Empty thread → empty session.
  {
    const st = deriveSessionState([], T(0));
    check("empty thread → empty session", st.sessionTurns.length === 0 && !st.interjectionOffered && !st.interjectionDeclined);
  }

  // One-turn thread → one-turn session.
  {
    const st = deriveSessionState([{ role: "learner", content: "a", createdAt: T(0) }], T(1));
    check("one-turn thread → one-turn session", st.sessionTurns.length === 1);
  }

  // Newest turn ≥30 min behind `now` → current session empty (a long silence).
  {
    const turns: SessionTurn[] = [{ role: "learner", content: "a", createdAt: T(0) }];
    const st = deriveSessionState(turns, T(31));
    check("newest turn 31-min stale vs now → empty session", st.sessionTurns.length === 0);
  }

  // Marker detection off grounding.sessionMarkers.
  {
    const withMarker: SessionTurn = { role: "assistant", content: "x", createdAt: T(1), grounding: { sessionMarkers: [ROOT_CAUSE_INTERJECTION_MARKER] } };
    const without: SessionTurn = { role: "assistant", content: "y", createdAt: T(1), grounding: { flags: [] } };
    check("sessionMarkersOf reads the marker array", sessionMarkersOf(withMarker).includes(ROOT_CAUSE_INTERJECTION_MARKER));
    check("sessionMarkersOf tolerates a marker-free grounding", sessionMarkersOf(without).length === 0);
    check("sessionMarkersOf tolerates undefined grounding", sessionMarkersOf({ role: "assistant", content: "z", createdAt: T(1) }).length === 0);
  }

  // interjectionOffered / interjectionDeclined via derivation.
  {
    const turns: SessionTurn[] = [
      { role: "learner", content: "I'm stuck", createdAt: T(0) },
      { role: "assistant", content: "Want to check fractions first?", createdAt: T(1), grounding: { sessionMarkers: [ROOT_CAUSE_INTERJECTION_MARKER] } },
      { role: "learner", content: "no thanks, just answer", createdAt: T(2) },
    ];
    const st = deriveSessionState(turns, T(2));
    check("interjectionOffered true when a session assistant turn carries the marker", st.interjectionOffered);
    check("interjectionDeclined true when the next learner turn declines", st.interjectionDeclined);
  }
  {
    // Offered but the learner ENGAGED (didn't decline).
    const turns: SessionTurn[] = [
      { role: "assistant", content: "Want to check fractions first?", createdAt: T(1), grounding: { sessionMarkers: [ROOT_CAUSE_INTERJECTION_MARKER] } },
      { role: "learner", content: "sure, let's do that", createdAt: T(2) },
    ];
    const st = deriveSessionState(turns, T(2));
    check("interjectionOffered true, declined FALSE when learner engages", st.interjectionOffered && !st.interjectionDeclined);
  }
  {
    // Marker in an OLDER session (before a 31-min gap) does NOT count for THIS session.
    const turns: SessionTurn[] = [
      { role: "assistant", content: "old offer", createdAt: T(0), grounding: { sessionMarkers: [ROOT_CAUSE_INTERJECTION_MARKER] } },
      { role: "learner", content: "new session start", createdAt: T(40) },
    ];
    const st = deriveSessionState(turns, T(40));
    check("marker in a PRIOR session doesn't leak into this session", !st.interjectionOffered && st.sessionTurns.length === 1);
  }

  // decline regex ±.
  for (const p of ["no thanks", "NOT NOW please", "skip it", "just answer", "maybe later"]) {
    check(`INTERJECTION_DECLINE_RE + "${p}"`, INTERJECTION_DECLINE_RE.test(p));
  }
  for (const n of ["yes please", "let's check that", "I don't understand", "sure"]) {
    check(`INTERJECTION_DECLINE_RE − "${n}"`, !INTERJECTION_DECLINE_RE.test(n));
  }

  // shouldInterjectRootCause gate.
  {
    const base = { sessionTurns: [], interjectionOffered: false, interjectionDeclined: false };
    check(
      "interject: root cause present, not offered, not declined → TRUE",
      shouldInterjectRootCause({ sessionState: base, rootCauseNodeId: NODE_ROOT, lessonNodeIds: [NODE_SURFACE] })
    );
    check(
      "interject: no root cause → FALSE",
      !shouldInterjectRootCause({ sessionState: base, rootCauseNodeId: null, lessonNodeIds: [NODE_SURFACE] })
    );
    check(
      "interject: root cause IS a lesson node (not upstream) → FALSE",
      !shouldInterjectRootCause({ sessionState: base, rootCauseNodeId: NODE_SURFACE, lessonNodeIds: [NODE_SURFACE] })
    );
    check(
      "interject: already offered this session → FALSE",
      !shouldInterjectRootCause({ sessionState: { ...base, interjectionOffered: true }, rootCauseNodeId: NODE_ROOT, lessonNodeIds: [NODE_SURFACE] })
    );
    check(
      "interject: declined this session → FALSE",
      !shouldInterjectRootCause({ sessionState: { ...base, interjectionOffered: true, interjectionDeclined: true }, rootCauseNodeId: NODE_ROOT, lessonNodeIds: [NODE_SURFACE] })
    );
  }

  /* ─────────────── AC-T3.7 · root-cause interjection through the loop ────── */
  console.log("\n— AC-T3.7 root-cause interjection (once per session) —");

  const NOW = T(15); // session anchor "now"
  // Turn 1: root cause present, no prior offer this session → instruction present + marker stamped.
  {
    const { deps, model } = loopDeps({ rung: 2 }, ROOT_CAUSE_MASTERY);
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        historyTurns: [{ role: "learner", content: "I keep getting equilibrium wrong", createdAt: T(14) }],
        learnerMessage: "why is this wrong",
        nowIso: NOW,
      }) as never
    );
    // The loop uses deps.nowIso; the ctx nowIso field is ignored (only deps carries it).
    const inputs = userInputs(model);
    const offered = inputs.some((s) => s.toLowerCase().includes("fractions") && s.toLowerCase().includes("offer"));
    check("turn 1: interjection instruction is in the model input", offered, inputs.join(" || ").slice(0, 200));
    check("turn 1: marker stamped on the result", res.sessionMarkers.includes(ROOT_CAUSE_INTERJECTION_MARKER), `markers=${res.sessionMarkers.join(",")}`);
    check("turn 1: turn ok", res.ok, `err=${res.error ?? ""}`);
  }

  // Turn 2: SAME session, a prior assistant turn carries the marker → NOT offered again.
  {
    const { deps, model } = loopDeps({ rung: 2 }, ROOT_CAUSE_MASTERY);
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        historyTurns: [
          { role: "learner", content: "I keep getting equilibrium wrong", createdAt: T(12) },
          { role: "assistant", content: "Want to check fractions first?", createdAt: T(13), grounding: { sessionMarkers: [ROOT_CAUSE_INTERJECTION_MARKER] } },
          { role: "learner", content: "sure", createdAt: T(14) },
        ],
        learnerMessage: "ok what next",
        nowIso: NOW,
      }) as never
    );
    const inputs = userInputs(model);
    const offered = inputs.some((s) => s.toLowerCase().includes("offer to check"));
    check("turn 2 (same session, already offered): NOT offered again", !offered);
    check("turn 2: no marker stamped", !res.sessionMarkers.includes(ROOT_CAUSE_INTERJECTION_MARKER));
  }

  // Declined variant: prior offer + a decline → suppressed for the session.
  {
    const { deps, model } = loopDeps({ rung: 2 }, ROOT_CAUSE_MASTERY);
    await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        historyTurns: [
          { role: "assistant", content: "Want to check fractions first?", createdAt: T(12), grounding: { sessionMarkers: [ROOT_CAUSE_INTERJECTION_MARKER] } },
          { role: "learner", content: "no thanks, just answer", createdAt: T(13) },
        ],
        learnerMessage: "so what's the answer path",
        nowIso: NOW,
      }) as never
    );
    const inputs = userInputs(model);
    const offered = inputs.some((s) => s.toLowerCase().includes("offer to check"));
    check("declined this session → suppressed (not offered)", !offered);
  }

  // NEW session (31-min gap since the prior offer) → offered again exactly once.
  {
    const { deps, model } = loopDeps({ rung: 2 }, ROOT_CAUSE_MASTERY);
    const NOW2 = T(50);
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW2 },
      ctxWith({
        historyTurns: [
          // A prior-session offer, then a 31-min silence before this turn.
          { role: "assistant", content: "Want to check fractions first?", createdAt: T(10), grounding: { sessionMarkers: [ROOT_CAUSE_INTERJECTION_MARKER] } },
          { role: "learner", content: "no thanks", createdAt: T(11) },
          { role: "learner", content: "I'm back and still stuck", createdAt: T(49) },
        ],
        learnerMessage: "help again",
        nowIso: NOW2,
      }) as never
    );
    const inputs = userInputs(model);
    const offered = inputs.some((s) => s.toLowerCase().includes("fractions") && s.toLowerCase().includes("offer"));
    check("NEW session (31-min gap) → offered again", offered, inputs.join(" || ").slice(0, 200));
    check("NEW session: marker stamped again exactly once", res.sessionMarkers.filter((m) => m === ROOT_CAUSE_INTERJECTION_MARKER).length === 1);
  }

  /* ───────────────────── AC-T3.8 · assessment integrity ─────────────────── */
  console.log("\n— AC-T3.8 assessment integrity —");

  check("ASSESSMENT_ACTIVE_MAX_RUNG is 3", ASSESSMENT_ACTIVE_MAX_RUNG === 3);

  // quizActive + concept_review_only: "just show me the answer" → rung clamped ≤3 + defer copy.
  {
    const { deps } = loopDeps({ rung: 2 });
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        quizActive: true,
        charterRow: CHARTER_ROW("guided_default", "open", "concept_review_only"),
        learnerMessage: "just show me the answer",
        nowIso: NOW,
      }) as never
    );
    check("quiz active + concept_review_only: 'just show me' → rung clamped ≤3", res.ok && (res.rung ?? 99) <= ASSESSMENT_ACTIVE_MAX_RUNG, `rung=${res.rung}`);
    check("quiz active: rung is not 4 (no verbatim answer)", res.rung !== 4);
    check("quiz active: the defer copy is present in the prose", !!res.output && res.output.prose.includes(ASSESSMENT_DEFER_COPY), `prose="${res.output?.prose ?? ""}"`);
  }

  // A general concept question (quizActive) → answered normally (scripted rung 2 passes through).
  {
    const { deps, model } = loopDeps({ rung: 2 });
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        quizActive: true,
        charterRow: CHARTER_ROW("guided_default", "open", "concept_review_only"),
        learnerMessage: "can you explain what equilibrium means in general",
        nowIso: NOW,
      }) as never
    );
    check("quiz active concept question: rung 2 passes through unclamped", res.ok && res.rung === 2, `rung=${res.rung}`);
    check("quiz active concept question: NO defer copy appended (rung was already ≤3)", !!res.output && !res.output.prose.includes(ASSESSMENT_DEFER_COPY));
    // The integrity INSTRUCTION still rides the input (the control is the instruction).
    check("quiz active: integrity instruction present in the input", userInputs(model).some((s) => s.toLowerCase().includes("graded quiz is active")));
    check("quiz active: exactly one model call for a normal concept turn", model.getCalls().length === 1, `calls=${model.getCalls().length}`);
  }

  // assessment_help 'block' + quizActive → typed refusal, ZERO model calls, ZERO evidence.
  {
    const { deps, model } = loopDeps({ rung: 4, evidence: [{ nodeId: NODE_SURFACE, direction: "positive", strength: "moderate", turnRef: "t" }] });
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        quizActive: true,
        charterRow: CHARTER_ROW("guided_default", "open", "block"),
        learnerMessage: "what's the answer to question 3",
        nowIso: NOW,
      }) as never
    );
    check("block + quiz active: typed refusal returned (ok, rung 0)", res.ok && res.rung === 0, `ok=${res.ok} rung=${res.rung}`);
    check("block + quiz active: prose IS the block copy", res.output?.prose === ASSESSMENT_BLOCK_COPY, `prose="${res.output?.prose ?? ""}"`);
    check("block + quiz active: ZERO model calls", model.getCalls().length === 0, `calls=${model.getCalls().length}`);
    check("block + quiz active: ZERO evidence", res.evidence.length === 0);
    check("block + quiz active: ZERO citations", (res.output?.citations.length ?? -1) === 0);
  }

  // quizActive false → rung 4 on explicit ask works (the W3.3 behavior intact).
  {
    const { deps } = loopDeps({ rung: 1 });
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        quizActive: false,
        charterRow: CHARTER_ROW("guided_default", "open", "concept_review_only"),
        learnerMessage: "just show me the answer",
        nowIso: NOW,
      }) as never
    );
    check("quiz INACTIVE: 'just show me' still forces rung 4 (W3.3 intact)", res.ok && res.rung === 4, `rung=${res.rung}`);
    check("quiz INACTIVE: no defer copy appended", !!res.output && !res.output.prose.includes(ASSESSMENT_DEFER_COPY));
  }

  // assessmentDeferCopy tone-awareness (pure).
  {
    check("assessmentDeferCopy() default is ASSESSMENT_DEFER_COPY", assessmentDeferCopy(null) === ASSESSMENT_DEFER_COPY);
    check("assessmentDeferCopy(tone) weaves the tone note", assessmentDeferCopy("warm and brief").includes("warm and brief"));
    check("assessmentDeferCopy(tone) keeps the invariant commitment", assessmentDeferCopy("warm and brief").startsWith(ASSESSMENT_DEFER_COPY));
    check("assessmentDeferCopy('') falls back to the default", assessmentDeferCopy("   ") === ASSESSMENT_DEFER_COPY);
  }

  // A tone-aware clamp end-to-end: the woven tone note appears in the deferred prose.
  {
    const { deps } = loopDeps({ rung: 4 });
    const res = await runTutorTurn(
      { ...deps, nowIso: NOW },
      ctxWith({
        quizActive: true,
        charterRow: CHARTER_ROW("guided_default", "open", "concept_review_only", "encouraging"),
        learnerMessage: "give me the answer",
        nowIso: NOW,
      }) as never
    );
    check("tone-aware defer: the tone note rides through into the prose", !!res.output && res.output.prose.includes("encouraging"), `prose="${res.output?.prose ?? ""}"`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
