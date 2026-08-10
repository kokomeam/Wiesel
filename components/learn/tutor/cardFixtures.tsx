"use client";

/**
 * TUTOR-1 A3 Wave 6 — DETERMINISTIC fixtures for the five A3 interactive tutor
 * cards, plus the A3-4 escape-hatch gate and the A3-18 malformed-item fallback.
 *
 * Mirrors the ui/fixtures.tsx precedent: a "use client" fixture LIST rendered by
 * a dev route (app/zz-tutor-cards) AND driven by the automated a11y + keyboard
 * suite (scripts/verify-tutor-cards-browser.ts). Every entry renders ONE surface
 * with realistic, deterministic props — no Math.random / Date.now, no network
 * dependence (the cards' tool_evidence POSTs are fire-and-forget and swallow
 * every error, so a fixture interaction never throws even without a server route).
 *
 * The cards are client components (they use the tutor store + local state); this
 * file is the client boundary. The store slice they touch (recordSessionAttempt)
 * is in-memory and works without a hydrator.
 *
 * A3-18 fence: the render-structure card's contract is that the SERVER drops an
 * invalid diagram (drop-and-flag) so an unusable diagram never reaches the card.
 * We prove the honest degradation at the fixture level with SafeStructure — a
 * thin wrapper that renders a plain "couldn't render" NOTE (never a broken /
 * partial widget) when the diagram is null, and defers to the real card
 * otherwise. This mirrors the drop-and-flag contract WITHOUT mutating the frozen
 * card component.
 */

import { useTutorStore } from "@/lib/learn/tutorStore";
import {
  hasAttemptedFor,
  shouldOfferEscapeHatch,
  type TutorAssessmentCard,
  type TutorRenderStructureCard,
} from "@/lib/learn/tutorClientTypes";
import { TutorCheckUnderstandingCard } from "./TutorCheckUnderstandingCard";
import { TutorSequenceCard } from "./TutorSequenceCard";
import { TutorStructureCard } from "./TutorStructureCard";
import { TutorFadedExampleCard } from "./TutorFadedExampleCard";
import { TutorPredictCard } from "./TutorPredictCard";
import { TutorExplainBackCard } from "./TutorExplainBackCard";

/** Deterministic ambient the cards need — placeholder ids; the evidence POST is
 *  best-effort so these never need to resolve to a real publication. */
const CTX = {
  courseId: "fixture-course",
  publicationId: "fixture-pub",
  version: 1,
  lessonId: "fixture-lesson",
  userId: "fixture-user",
} as const;

export interface CardFixture {
  name: string;
  node: React.ReactNode;
}

/* ───────────────────── deterministic card payloads ────────────────────── */

/** checkUnderstanding — 4 options, TWO misconception-labelled distractors, and a
 *  sure/unsure confidence read (collectConfidence). */
const CHECK_CARD: Extract<TutorAssessmentCard, { toolName: "checkUnderstanding" }> = {
  cardId: "fx-check-1",
  toolName: "checkUnderstanding",
  conceptSlug: "opportunity-cost",
  initiation: "invitation_accepted",
  stem: "You skip a $30 concert to work a shift that pays $40. What is the opportunity cost of working?",
  options: [
    {
      id: "o1",
      text: "The $30 value of the concert you gave up",
      correct: true,
      misconceptionId: null,
      feedback: "Right — opportunity cost is the value of the next-best alternative you forgave, the concert.",
    },
    {
      id: "o2",
      text: "The $40 you earned on the shift",
      correct: false,
      misconceptionId: "confuses-benefit-with-cost",
      feedback: "That's the benefit of the choice you made, not what you gave up to make it.",
    },
    {
      id: "o3",
      text: "The $70 total of both amounts",
      correct: false,
      misconceptionId: "double-counts",
      feedback: "Adding both double-counts — the cost is only the one alternative you forwent.",
    },
    {
      id: "o4",
      text: "Nothing — you came out ahead",
      correct: false,
      misconceptionId: "ignores-forgone-value",
      feedback: "Even a good choice has an opportunity cost: the value of what you didn't do.",
    },
  ],
  collectConfidence: true,
};

/** sequenceTask — adjacent-pairs, 4 items to order. */
const SEQUENCE_CARD: Extract<TutorAssessmentCard, { toolName: "sequenceTask" }> = {
  cardId: "fx-seq-1",
  toolName: "sequenceTask",
  conceptSlug: "binary-search",
  initiation: "practice_request",
  prompt: "Put the steps of one binary-search iteration in order.",
  items: [
    { id: "s1", text: "Compute the midpoint of the current range" },
    { id: "s2", text: "Compare the target to the midpoint value" },
    { id: "s3", text: "Discard the half that cannot contain the target" },
    { id: "s4", text: "Repeat on the remaining half" },
  ],
  correctOrder: ["s1", "s2", "s3", "s4"],
  partialCreditRule: "adjacent-pairs",
};

/** renderStructure — a valid tree DiagramSpec (the storage-schema shape). */
const STRUCTURE_CARD: TutorRenderStructureCard = {
  kind: "tree",
  title: "A small decision tree",
  caption: "Each branch splits the data on one question; leaves are the outcomes.",
  diagram: {
    kind: "tree_diagram",
    root: {
      label: "Sunny?",
      children: [
        { label: "Humid?", children: [{ label: "Play" }, { label: "Don't play" }] },
        { label: "Windy?", children: [{ label: "Don't play" }, { label: "Play" }] },
      ],
    },
  },
};

/** fadedExample — fadeLevel 2, some steps blanked (the learner fills them). */
const FADED_CARD: Extract<TutorAssessmentCard, { toolName: "fadedExample" }> = {
  cardId: "fx-faded-1",
  toolName: "fadedExample",
  conceptSlug: "solve-linear-equation",
  initiation: "practice_request",
  fadeLevel: 2,
  problem: "Solve 3x + 6 = 18 for x.",
  steps: [
    { text: "Subtract 6 from both sides", blanked: false, answer: "3x = 12" },
    { text: "Divide both sides by 3", blanked: true, answer: "x = 4" },
    { text: "State the solution", blanked: true, answer: "x = 4" },
  ],
};

/** predictThenReveal — one accepted answer + a near-miss with a misconception. */
const PREDICT_CARD: Extract<TutorAssessmentCard, { toolName: "predictThenReveal" }> = {
  cardId: "fx-predict-1",
  toolName: "predictThenReveal",
  conceptSlug: "supply-shock",
  initiation: "practice_request",
  setup: "A frost destroys half the coffee harvest. Demand is unchanged.",
  prompt: "What happens to the equilibrium price of coffee?",
  acceptedAnswers: ["rises", "goes up", "increases", "higher"],
  nearMisses: [
    {
      pattern: "falls",
      misconceptionId: "wrong-direction",
      feedback: "A leftward supply shift with steady demand pushes price UP, not down.",
    },
    {
      pattern: "stays the same",
      misconceptionId: "ignores-scarcity",
      feedback: "Scarcer supply at the same demand can't leave the price unchanged.",
    },
  ],
  revealExplanation:
    "Supply shifts left while demand holds, so the new equilibrium sits at a higher price and a lower quantity.",
};

/** explainBack — a labelled free-text prompt graded on the SERVER (2 criteria). */
const EXPLAIN_CARD: Extract<TutorAssessmentCard, { toolName: "explainBack" }> = {
  cardId: "fx-explain-1",
  toolName: "explainBack",
  conceptSlug: "recursion",
  initiation: "invitation_accepted",
  prompt: "In your own words, explain what makes a recursive function terminate.",
  rubric: [
    { criterion: "Names a base case that stops the recursion", required: true },
    { criterion: "Notes the recursive call moves toward the base case", required: true },
  ],
};

/* ─────────────────── A3-18 · malformed structure fallback ──────────────── */

/**
 * The drop-and-flag contract mirror. A structure whose diagram is null/absent is
 * dropped SERVER-side and never reaches the real card; this wrapper renders the
 * honest degradation the same way the pipeline flags it — a plain, non-widget
 * "couldn't render" NOTE — so the fence is observable without a live server and
 * without mutating the frozen card. A valid diagram defers to the real card.
 */
/** The loose diagram shape the drop-and-flag path can carry: a real spec, or
 *  null when the server dropped an invalid one. */
type DiagramSpecOrNull = TutorRenderStructureCard["diagram"] | null;

function SafeStructure({
  card,
}: {
  card: { kind: TutorRenderStructureCard["kind"]; title: string | null; caption: string | null; diagram: DiagramSpecOrNull };
}) {
  if (!card.diagram || typeof card.diagram !== "object" || typeof (card.diagram as { kind?: unknown }).kind !== "string") {
    return (
      <div
        data-ai-component="tutor-structure-fallback"
        role="note"
        className="w-[92%] rounded-2xl border border-stone-200/80 bg-stone-50/60 p-3 text-sm text-stone-600 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      >
        <p>This diagram couldn&apos;t be rendered.</p>
        {card.caption ? <p className="mt-1 text-xs text-stone-500">{card.caption}</p> : null}
      </div>
    );
  }
  return <TutorStructureCard card={card as TutorRenderStructureCard} />;
}

/* ───────────────────── A3-4 · attempt-gated escape hatch ───────────────── */

/**
 * A fixture-level, browser-OBSERVABLE proof of the A3-4 gate composition that
 * TutorBody uses verbatim: `shouldOfferEscapeHatch(rung, hasAttemptedFor(attempts,
 * turnNodeIds))`. Renders a rung-2 (below-4) tutor bubble whose "Just show me"
 * hatch is gated exactly as the real turn gates it, reading the SAME store slice
 * a real card writes. The "Simulate an attempt" button calls the real
 * `recordSessionAttempt`, flipping the gate false→true LIVE — no mock.
 */
function EscapeHatchGate({ rung, turnNodeIds }: { rung: number; turnNodeIds: string[] | null }) {
  const attempts = useTutorStore((s) => s.sessionAttempts[CTX.userId]);
  const recordSessionAttempt = useTutorStore((s) => s.recordSessionAttempt);
  const hasAttempted = hasAttemptedFor(attempts, turnNodeIds);
  const offered = shouldOfferEscapeHatch(rung, hasAttempted);

  const attemptNode = turnNodeIds && turnNodeIds.length > 0 ? turnNodeIds[0] : "any";

  return (
    <div data-ai-component="tutor-hatch-gate-fixture" className="flex flex-col items-start gap-2">
      <div
        data-ai-component="tutor-assistant-bubble"
        className="max-w-[92%] rounded-2xl rounded-bl-md border border-stone-200/80 bg-stone-50/80 px-3.5 py-2.5 text-sm leading-relaxed text-stone-800"
      >
        <p>Try working out the next step yourself before I reveal it.</p>
        {/* The A3-4/A3-5 gate — identical composition to TutorBody's TurnBubble. */}
        {offered ? (
          <button
            type="button"
            data-ai-tool="tutor-just-show-me"
            className="mt-2 text-[11px] font-medium text-stone-500 underline decoration-dotted underline-offset-2 transition-colors hover:text-brand-700"
          >
            Just show me
          </button>
        ) : null}
      </div>
      <button
        type="button"
        data-ai-tool="fixture-simulate-attempt"
        onClick={() => recordSessionAttempt(CTX.userId, attemptNode === "any" ? null : attemptNode)}
        className="rounded-full border border-stone-300/80 bg-white px-3 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      >
        Simulate an attempt
      </button>
      <p aria-hidden className="text-[11px] text-stone-600" data-fixture-hatch-state={offered ? "offered" : "hidden"}>
        hatch: {offered ? "offered" : "hidden"}
      </p>
    </div>
  );
}

/* ─────────────────────────── the fixture list ─────────────────────────── */

export const CARD_FIXTURES: CardFixture[] = [
  {
    name: "check-understanding",
    node: <TutorCheckUnderstandingCard card={CHECK_CARD} {...CTX} />,
  },
  {
    name: "sequence-task",
    node: <TutorSequenceCard card={SEQUENCE_CARD} {...CTX} />,
  },
  {
    name: "render-structure",
    node: <TutorStructureCard card={STRUCTURE_CARD} />,
  },
  {
    name: "faded-example",
    node: <TutorFadedExampleCard card={FADED_CARD} {...CTX} />,
  },
  {
    name: "predict-then-reveal",
    node: <TutorPredictCard card={PREDICT_CARD} {...CTX} />,
  },
  {
    name: "explain-back",
    node: <TutorExplainBackCard card={EXPLAIN_CARD} {...CTX} />,
  },
  {
    // A3-18 — the drop-and-flag fallback: diagram null → a graceful note, never
    // a broken/partial widget.
    name: "malformed-structure",
    node: <SafeStructure card={{ kind: "tree", title: "A dropped diagram", caption: "the structure couldn't be built", diagram: null }} />,
  },
  {
    // A3-4 — attempt gate BEFORE any attempt: the hatch must be hidden.
    name: "escape-hatch-pre-attempt",
    node: <EscapeHatchGate rung={2} turnNodeIds={null} />,
  },
  {
    // A3-4 — the same gate that flips to offered after "Simulate an attempt".
    name: "escape-hatch-flip",
    node: <EscapeHatchGate rung={2} turnNodeIds={["opportunity-cost"]} />,
  },
];
