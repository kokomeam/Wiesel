/**
 * Bounded-history + plan-coverage + batch-atomicity checks — pure, no key/DB.
 * Run: `npx tsx scripts/verify-bounded.ts`
 *
 * These lock in the headline guarantees of the cost refactor that were previously
 * only LOGGED (agent_input_compaction / agent_plan_coverage), never asserted:
 *  1. buildBoundedAgentInput does NOT grow with the number of turns (the whole
 *     point — replace unbounded transcript replay with a bounded tail).
 *  2. The tail keeps only the last K tool turn-groups, with function_call /
 *     function_call_output pairs intact, and drops stale cross-run tool items.
 *  3. compactToolResult shrinks a bulky get_deck and caps everything else.
 *  4. The EDIT path policy is genuinely roomier than the GENERATE default.
 *  5. computePlanCoverage reports exact covered / missing / extra specs.
 *  6. add_structured_slides_batch is atomic: one bad slide (or > 4) bounces the
 *     WHOLE batch with no patches; a clean batch stamps each slide's specId.
 */

import {
  buildBoundedAgentInput,
  compactToolResult,
  defaultHistoryPolicy,
  editHistoryPolicy,
} from "@/lib/ai/historyPolicy";
import { buildGenerationState, computePlanCoverage, serializeGenerationState } from "@/lib/ai/generationState";
import { coerceOutline } from "@/lib/ai/outline";
import type { ModelInputItem } from "@/lib/ai/modelClient";
import { executeTool, ToolError, type ToolContext } from "@/lib/ai/tools";
import { createBlock, createLesson, createModule, createStructuredSlide } from "@/lib/course/factories";
import { applyCoursePatch } from "@/lib/course/patches";
import { defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n} ${d}`); }
};

const NOW = "2026-06-18T00:00:00.000Z";

function freshDoc(): { doc: CourseDocument; lessonId: string } {
  const lesson = createLesson("Greedy algorithms", 0);
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: crypto.randomUUID(),
    title: "Algorithms 101",
    description: "Core patterns.",
    audience: "beginners",
    level: "beginner",
    plan: { outcomes: ["Apply greedy"], prerequisites: [], teachingStyle: "concrete" },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: { createdAt: NOW, updatedAt: NOW, aiReadableVersion: "1.0" },
  };
  return { doc, lessonId: lesson.id };
}

/** One model-turn's worth of items: an assistant note + a matched call/output. */
function turnGroup(i: number): ModelInputItem[] {
  return [
    { role: "assistant", content: `note ${i}` },
    { type: "function_call", callId: `c${i}`, name: "add_structured_slides_batch", arguments: "{}" },
    { type: "function_call_output", callId: `c${i}`, output: JSON.stringify({ ok: true, summary: `segment ${i}` }) },
  ];
}

const callIdsOf = (items: ModelInputItem[]): string[] =>
  items.flatMap((it) => ("callId" in it ? [it.callId] : []));

const contentOf = (it: ModelInputItem | undefined): string | undefined =>
  it && "content" in it ? it.content : undefined;

async function main() {
  // ── 1–3. Bounded input assembly ───────────────────────────────────────────
  console.log("\n# bounded input — does not grow, pairs intact, stale dropped");
  const history: ModelInputItem[] = [
    { role: "user", content: "build the lesson" },
    { role: "assistant", content: "older run summary" },
    { type: "function_call", callId: "stale", name: "get_deck", arguments: "{}" },
    { type: "function_call_output", callId: "stale", output: "STALE BIG OUTPUT".repeat(500) },
    { role: "user", content: "current instruction" },
  ];
  const build = (n: number) =>
    buildBoundedAgentInput({
      contextMessage: "CTX",
      generationStateSummary: "STATE",
      history,
      eventGroups: Array.from({ length: n }, (_, i) => turnGroup(i + 1)),
      keepRecentToolEvents: 4,
      keepRecentChatMessages: 3,
      maxToolResultChars: 4000,
    });

  const b10 = build(10);
  const ids10 = callIdsOf(b10.input);
  check("stale cross-run tool item is dropped", !ids10.includes("stale"));
  check("tail keeps only the last 4 turn-groups (c7–c10)", ids10.includes("c10") && ids10.includes("c7") && !ids10.includes("c6") && !ids10.includes("c1"), ids10.join(","));

  const calls = new Set(b10.input.flatMap((it) => ("type" in it && it.type === "function_call" ? [it.callId] : [])));
  const outs = new Set(b10.input.flatMap((it) => ("type" in it && it.type === "function_call_output" ? [it.callId] : [])));
  const paired = calls.size === outs.size && [...calls].every((id) => outs.has(id));
  check("function_call / function_call_output pairs stay matched", paired, `${[...calls]} vs ${[...outs]}`);

  check("context + state are the first two developer messages", contentOf(b10.input[0]) === "CTX" && contentOf(b10.input[1]) === "STATE", JSON.stringify(b10.input.slice(0, 2)));
  check("recent chat window kept (current instruction present)", b10.input.some((it) => "content" in it && it.content === "current instruction"));

  const b6 = build(6);
  const b20 = build(20);
  check("bounded size is FLAT across turn count (6 vs 20 turns)", b6.stats.compactedMessages === b20.stats.compactedMessages, `${b6.stats.compactedMessages} vs ${b20.stats.compactedMessages}`);
  check("full replay WOULD have grown (originalMessages 20 > 6)", b20.stats.originalMessages > b6.stats.originalMessages, `${b6.stats.originalMessages} → ${b20.stats.originalMessages}`);
  check("compacted chars ≤ original chars", b20.stats.compactedApproxChars <= b20.stats.originalApproxChars, `${b20.stats.compactedApproxChars} vs ${b20.stats.originalApproxChars}`);

  // ── compactToolResult ──────────────────────────────────────────────────────
  console.log("\n# compactToolResult");
  const deckJson = JSON.stringify([
    { slideId: "s_a", layout: "prose", slots: [{ role: "title", text: "x".repeat(300) }, { role: "body", text: "y".repeat(600) }] },
    { slideId: "s_b", layout: "key_concept", slots: [{ role: "term", text: "z".repeat(400) }] },
  ]);
  const deckC = compactToolResult("get_deck", deckJson, 4000);
  check("get_deck compacts to a slide skeleton (no slot text)", deckC.includes("compacted") && !deckC.includes("slots") && deckC.length < deckJson.length, `${deckC.length} vs ${deckJson.length}`);
  const big = "q".repeat(5000);
  const bigC = compactToolResult("get_block", big, 4000);
  check("oversized generic result is truncated to the cap", bigC.length <= 4000 + 16 && bigC.endsWith("…(truncated)"), `${bigC.length}`);
  check("small result passes through untouched", compactToolResult("write_quiz", '{"ok":true}', 4000) === '{"ok":true}');

  // ── 4. EDIT policy is roomier than GENERATE default ────────────────────────
  console.log("\n# edit history policy");
  const def = defaultHistoryPolicy();
  const ed = editHistoryPolicy();
  check("default (generate) policy is bounded + includes generation state", def.mode === "bounded" && def.includeGenerationState === true);
  check("edit policy drops the generation-state summary", ed.mode === "bounded" && ed.includeGenerationState === false);
  if (def.mode === "bounded" && ed.mode === "bounded") {
    check("edit keeps a LARGER chat window than generate", ed.keepRecentChatMessages > def.keepRecentChatMessages, `${ed.keepRecentChatMessages} vs ${def.keepRecentChatMessages}`);
    check("edit allows a LARGER tool-result cap than generate", ed.maxToolResultChars > def.maxToolResultChars, `${ed.maxToolResultChars} vs ${def.maxToolResultChars}`);
  }

  // ── 5. Plan coverage — exact covered / missing / extra ─────────────────────
  console.log("\n# computePlanCoverage (exact)");
  const slideSpec = { segmentId: "seg", title: "t", teachingGoal: "g", layout: "prose", depth: "definition", keyPoints: ["a"], notes: "n", visualIntent: null, requiredElements: null, speakerNotesGoal: "x" };
  const { outline } = coerceOutline({
    objective: "o", targetStudent: "ts", estimatedMinutes: 10,
    segments: [{ id: "seg", name: "S", purpose: "concept_intro", targetSlideCount: 3 }],
    slides: [slideSpec, slideSpec, slideSpec],
  });
  if (!outline) throw new Error("coerceOutline failed to build the test outline");
  check("outline assigns spec ids s1/s2/s3", outline.slides.map((s) => s.id).join(",") === "s1,s2,s3", outline.slides.map((s) => s.id).join(","));

  const { doc, lessonId } = freshDoc();
  const sA = createStructuredSlide("prose"); sA.ai.specId = "s1";
  const sB = createStructuredSlide("prose"); sB.ai.specId = "s2";
  const sC = createStructuredSlide("prose"); // unstamped → "extra"
  const deckBlk = createBlock("slide_deck") as SlideDeckBlock;
  deckBlk.slides = [sA, sB, sC];
  doc.modules[0].lessons[0].blocks.push(deckBlk);

  const cov = computePlanCoverage(doc, lessonId, outline);
  check("coverage: 3 planned, 3 generated", cov.plannedSlides === 3 && cov.generatedSlides === 3);
  check("coverage: 2 specs covered", cov.coveredSlideSpecs === 2, `${cov.coveredSlideSpecs}`);
  check("coverage: s3 is missing", cov.missingSlideSpecs.join(",") === "s3", cov.missingSlideSpecs.join(","));
  check("coverage: the unstamped slide is the only extra", cov.extraSlides.length === 1 && cov.extraSlides[0] === sC.id, cov.extraSlides.join(","));

  // generation-state summary reflects the same truth + respects the cap.
  const state = buildGenerationState(doc, lessonId, { phase: "generate", outline });
  check("generation state: 2/3 specs built, s3 remaining", state.planProgress?.slideSpecsCompleted.length === 2 && state.planProgress?.slideSpecsRemaining.join(",") === "s3");
  const ser = serializeGenerationState(state, 40);
  check("serialized state respects maxChars cap", ser.length <= 40 + "\n…(truncated)".length, `${ser.length}`);

  // ── 6. Batch tool atomicity ────────────────────────────────────────────────
  console.log("\n# add_structured_slides_batch — atomic, capped, stamps specId");
  const ctx: ToolContext = { doc, courseId: doc.id, lessonId };
  const validProse = { layoutId: "prose", content: { title: { text: "Greedy works" }, body: { text: "A greedy algorithm builds the answer one safe choice at a time, adding the cheapest valid option each step." } } };
  const badProse = { layoutId: "prose", content: { title: { text: "x".repeat(61) }, body: { text: "A valid enough body sentence for the test." } } };

  const okBatch = await executeTool("add_structured_slides_batch", JSON.stringify({
    deckBlockId: deckBlk.id,
    slides: [{ slideSpecId: "s3", template: validProse, notes: null }, { slideSpecId: null, template: validProse, notes: "spoken" }],
  }), ctx);
  check("clean 2-slide batch → 2 ADD_SLIDE patches", okBatch.patches?.length === 2 && okBatch.patches.every((p) => p.action === "ADD_SLIDE"));
  const added = (okBatch.data as { slidesAdded?: { specId?: string }[] }).slidesAdded ?? [];
  check("batch stamps slideSpecId onto the created slide", added[0]?.specId === "s3");
  // patches actually apply cleanly through the reducer
  let applied = doc;
  for (const p of okBatch.patches ?? []) { const r = applyCoursePatch(applied, p, NOW); if (r.ok) applied = r.doc; }
  const deckAfter = applied.modules[0].lessons[0].blocks.find((b): b is SlideDeckBlock => b.id === deckBlk.id);
  check("both batch slides applied to the deck", deckAfter?.slides.length === 5, `${deckAfter?.slides.length}`);

  let bouncedBad = false;
  try {
    await executeTool("add_structured_slides_batch", JSON.stringify({
      deckBlockId: deckBlk.id,
      slides: [{ slideSpecId: "s1", template: validProse, notes: null }, { slideSpecId: "s2", template: badProse, notes: null }],
    }), ctx);
  } catch (e) { bouncedBad = e instanceof ToolError; }
  check("one over-limit slide bounces the WHOLE batch (ToolError, no patches)", bouncedBad);

  let bouncedCap = false;
  try {
    await executeTool("add_structured_slides_batch", JSON.stringify({
      deckBlockId: deckBlk.id,
      slides: Array.from({ length: 5 }, () => ({ slideSpecId: null, template: validProse, notes: null })),
    }), ctx);
  } catch (e) { bouncedCap = e instanceof ToolError; }
  check("> 4 slides bounces (cap enforced)", bouncedCap);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
