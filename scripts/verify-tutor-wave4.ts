/**
 * TUTOR-1 — Amendment A4, Wave 4 · PURE + loop-integration suite (no DB, no key).
 *
 *   • A4-22 no lesson ID / UUID in learner-facing output (labels, chips, prose)
 *   • A4-23 every nav affordance resolves to a real anchor + NAMES its destination
 *   • A4-24 at most ONE nav affordance per message
 *   • A4-25 suggestion chips vary with lesson + mastery (snapshots ×3 states)
 *   • A4-26 the whole-lesson L2 is replaced by retrieval + the token delta reported
 *
 * Run: `npx tsx scripts/verify-tutor-wave4.ts`
 */

import { readFileSync } from "node:fs";

import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import type { Database } from "@/lib/database.types";
import type { PublicationSnapshot, PublishedLessonBlock } from "@/lib/course/publish/schemas";
import type { LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import type { RetrievedChunk } from "@/lib/tutor/retrieval/retrieve";
import type { ScopeRetrieveFn } from "@/lib/tutor/retrieval/scopePolicy";
import { resolveCitationLabels } from "@/lib/tutor/retrieval/citationLabels";
import { deriveSuggestionChips, QUIZ_CHIP_MESSAGE } from "@/lib/learn/tutorChips";
import { hasInternalId, redactInternalIds, primaryNavAffordance } from "@/lib/learn/tutorNav";
import type { TutorCitation } from "@/lib/learn/tutorClientTypes";
import { runTutorTurn } from "@/lib/tutor/runtime/loop";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const LUNA = TUTOR_MODELS.tutor_turn.model;
const COURSE = "11111111-1111-4111-8111-111111111111";
const PUB = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const B1 = "bbbbbbbb-0000-4000-8000-000000000001";

// A long lesson body so the whole-lesson L2 is substantially larger than the
// short header + retrieved passages (so the token delta is a real saving).
const LONG_BODY = "Equilibrium is the price at which quantity supplied equals quantity demanded. ".repeat(40);

function lectureBlock(id: string, title: string, text: string): PublishedLessonBlock {
  return { id, type: "lecture_text", title, order: 0, ai: { purpose: "teach", editable: true, allowedActions: [], semanticTags: [] }, tone: "detailed", paragraphs: [{ id: `${id}-p1`, kind: "paragraph", text }] } as PublishedLessonBlock;
}
function buildSnapshot(): PublicationSnapshot {
  return {
    schemaVersion: 1,
    course: { id: COURSE, title: "Markets", plan: { outcomes: [], prerequisites: [] }, theme: { name: "Editorial Warm", accent: "amber", slideDefaults: { layout: "title", themeId: "editorial-warm" } } },
    modules: [{ id: "mod-1", type: "module", title: "Foundations", order: 0, lessons: [{ id: L1, type: "lesson", title: "Supply and Demand", objective: "Explain how price emerges.", order: 0, blocks: [lectureBlock(B1, "The market", LONG_BODY)] }] }],
  } as unknown as PublicationSnapshot;
}
const NODES: LessonConceptNode[] = [{ id: "cccccccc-0000-4000-8000-000000000001", title: "Equilibrium", description: "Supply meets demand.", anchors: [{ lessonId: L1, blockId: B1 }] }];
const EDGES: EdgeLike[] = [];

function mkChunk(lessonId: string, blockId: string, ord: number): RetrievedChunk {
  return { id: `c${ord}`, lessonId, blockId, slideId: null, chunkOrdinal: ord, text: `Passage ${ord} about the market.`, anchor: { lessonId, blockId, slideId: null }, sourceTier: "canon", vectorRank: 1, lexicalRank: null, score: 0.0328, similarity: 0.7 };
}
const stubRetrieve: ScopeRetrieveFn = async (a) => a.lessonIds.map((l, i) => mkChunk(l, B1, i));

function charter(): Database["public"]["Tables"]["tutor_course_settings"]["Row"] {
  return { assessment_help: "concept_review_only", budget_limit_usd: null, course_canon: "strict", course_id: COURSE, created_at: "2026-08-11T00:00:00Z", current_charter_version_id: null, digest_cadence: "daily", digest_opt_out: false, enabled: true, escalation_sensitivity: "default", guidance_style: "guided_default", scope: "course_only", tone_notes: null, updated_at: "2026-08-11T00:00:00Z" };
}
const emptyLearner = { rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) } as unknown as Parameters<typeof runTutorTurn>[0]["learnerClient"];
const stubService = { from() { return { insert() { return { select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }) }; } }; } } as unknown as Parameters<typeof runTutorTurn>[0]["serviceClient"];

async function main() {
  /* ── A4-25 · chips vary with lesson + mastery (snapshots ×3) ── */
  console.log("\n— A4-25 · suggestion chips derive from lesson + mastery (3 states) —");
  const stateA = deriveSuggestionChips({ lessonTitle: null, weakestConceptTitle: null, reviewCount: 0, hasHistory: false });
  const stateB = deriveSuggestionChips({ lessonTitle: "Hashing", weakestConceptTitle: "Collision handling", reviewCount: 2, hasHistory: true });
  const stateC = deriveSuggestionChips({ lessonTitle: "Balanced Trees", weakestConceptTitle: null, reviewCount: 3, hasHistory: false });
  const labelsOf = (s: ReturnType<typeof deriveSuggestionChips>) => s.map((c) => c.label).join(" | ");
  check("state A (fresh) chips", labelsOf(stateA) === "Explain this simply | Quiz me on this lesson | What should I review next? | Make me a study plan", labelsOf(stateA));
  check("state B (lesson + weak concept + history) chips", labelsOf(stateB) === "Explain Hashing simply | Quiz me on this lesson | Review Collision handling | Summarize what we covered", labelsOf(stateB));
  check("state C (lesson + review-count, no history) chips", labelsOf(stateC) === "Explain Balanced Trees simply | Quiz me on this lesson | Review what I've missed | Make me a study plan", labelsOf(stateC));
  check("the three states produce DISTINCT chip sets (chips vary)", new Set([labelsOf(stateA), labelsOf(stateB), labelsOf(stateC)]).size === 3);
  check("the 'Quiz me on this lesson' message is PINNED across all states", [stateA, stateB, stateC].every((s) => s.some((c) => c.message === QUIZ_CHIP_MESSAGE)));
  check("chips are deduped by action (distinct messages)", stateB.length === new Set(stateB.map((c) => c.message)).size);
  check("no chip label contains an internal id (A4-22)", [stateA, stateB, stateC].every((s) => s.every((c) => !hasInternalId(c.label) && !hasInternalId(c.message))));

  /* ── A4-22 · id redaction + detection ── */
  console.log("\n— A4-22 · no lesson ID / UUID in learner-facing output —");
  check("hasInternalId detects a UUID", hasInternalId(`see ${L1} here`));
  check("hasInternalId is false for clean prose", !hasInternalId("See the Supply and Demand lesson."));
  const redacted = redactInternalIds(`Refer to lesson ${L1} and block ${B1}.`);
  check("redactInternalIds removes every UUID", !hasInternalId(redacted), redacted);
  check("redactInternalIds keeps the surrounding prose", redacted.includes("Refer to lesson") && redacted.includes("the referenced lesson"));

  /* ── A4-23 · labels name a real destination ── */
  console.log("\n— A4-23 · citation labels name a real destination (never an id) —");
  const snapshot = buildSnapshot();
  const labeled = resolveCitationLabels(snapshot, [{ lessonId: L1, blockId: B1, slideId: null }]);
  check("resolveCitationLabels labels a citation with its LESSON TITLE", labeled[0].label === "Supply and Demand", labeled[0].label);
  check("a resolved label contains NO internal id", !hasInternalId(labeled[0].label));
  const unknownLabeled = resolveCitationLabels(snapshot, [{ lessonId: "deadbeef-0000-4000-8000-000000000000", blockId: B1, slideId: null }]);
  check("an unknown lesson degrades to a neutral name (no id)", unknownLabeled[0].label === "the referenced lesson" && !hasInternalId(unknownLabeled[0].label));

  /* ── A4-24 · at most one nav affordance + it resolves ── */
  console.log("\n— A4-24 · at most one navigation affordance per message —");
  const many: TutorCitation[] = [
    { lessonId: L1, blockId: B1, slideId: null, label: "Supply and Demand" },
    { lessonId: "e1", blockId: "e2", slideId: null, label: "Elasticity" },
    { lessonId: "e3", blockId: "e4", slideId: null, label: "Scarcity" },
  ];
  const nav = primaryNavAffordance(many, { activeLessonId: L1 });
  check("primaryNavAffordance returns exactly ONE affordance for many citations", nav !== null);
  check("the affordance NAMES its destination (the label)", nav?.label === "Supply and Demand");
  check("the affordance resolves to a real anchor (a block id)", !!nav?.citation.blockId);
  check("same-lesson citation → an in-place 'Show me' jump", nav?.sameLesson === true);
  check("NO affordance renders when there are no citations (A4-23)", primaryNavAffordance([], { activeLessonId: L1 }) === null);
  const noLabel = primaryNavAffordance([{ lessonId: L1, blockId: B1, slideId: null }], { activeLessonId: null });
  check("a citation with no label still resolves to a NEUTRAL destination name (no id)", noLabel?.label === "the referenced passage" && !hasInternalId(noLabel!.label));
  // Source: the chip component renders the single primaryNavAffordance.
  const bodySrc = readFileSync(new URL("../components/learn/tutor/TutorBody.tsx", import.meta.url), "utf8");
  check("CitationChips renders the single primaryNavAffordance (one button)", bodySrc.includes("primaryNavAffordance(dedupeCitations(citations)"));

  /* ── A4-26 + A4-22 · loop: L2 replaced by retrieval + token delta + prose redacted ── */
  console.log("\n— A4-26 · the whole-lesson L2 is replaced by retrieval + token delta reported —");
  {
    const model = createMockModelClient([], {
      model: LUNA,
      structured: { tutor_turn_output: JSON.stringify({ proseWithSpanMarkers: `Here is a recap. See lesson ${L1} for the full picture.`, citations: [{ lessonId: L1, blockId: B1, slideId: null }], rung: 2, evidence: [] }) },
    });
    const res = await runTutorTurn(
      { learnerClient: emptyLearner, serviceClient: stubService, model, loadSnapshot: async () => ({ snapshot }), conceptNodes: NODES, conceptEdges: EDGES, retrieve: stubRetrieve },
      { userId: USER, courseId: COURSE, publicationId: PUB, version: 1, lessonId: L1, charterRow: charter(), historyTurns: [{ role: "learner", content: "hi" }], completedLessonIds: [], learnerMessage: "what is equilibrium" }
    );
    check("the turn succeeds", res.ok === true, JSON.stringify({ ok: res.ok, err: res.error }));
    check("A4-26: tokenDelta is reported (before + after)", !!res.tokenDelta && res.tokenDelta.l2TokensBefore > 0 && res.tokenDelta.retrievalTokensAfter >= 0, JSON.stringify(res.tokenDelta));
    check("A4-26: the whole-lesson L2 was LARGER than the retrieval-grounded prompt (tokens SAVED)", !!res.tokenDelta && res.tokenDelta.deltaTokens < 0, JSON.stringify(res.tokenDelta));
    const devMsg = JSON.stringify(model.getCalls()[0]?.input ?? "");
    check("A4-26: the developer message NO LONGER carries the whole-lesson dump (short header only)", !devMsg.includes(LONG_BODY.slice(0, 200)), devMsg.slice(0, 120));
    check("A4-26: the developer message carries the SHORT lesson header", devMsg.includes("Active lesson: Supply and Demand"));
    check("A4-22: the cleaned prose has NO UUID (redacted)", !hasInternalId(res.output?.prose ?? ""), res.output?.prose ?? "");
    check("A4-23: the turn's labeledCitations name the destination (lesson title)", (res.labeledCitations ?? []).some((c) => c.label === "Supply and Demand"), JSON.stringify(res.labeledCitations));
    check("A4-22: no labeledCitation label contains an id", (res.labeledCitations ?? []).every((c) => !hasInternalId(c.label)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
