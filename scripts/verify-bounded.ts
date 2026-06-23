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
 *  6. add_structured_slides_batch CLAMPS-not-rejects: an over-length slot is auto-
 *     shortened to its cap and the slide SAVED (never bounced for formatting); the
 *     stamped specId is kept so coverage closes; only a slide MISSING required
 *     content comes back, while its valid siblings still land. The leaf
 *     `clampStructuredTemplate` is unit-checked too.
 */

import {
  buildBoundedAgentInput,
  buildScopedAgentInput,
  compactToolResult,
  defaultHistoryPolicy,
  editHistoryPolicy,
} from "@/lib/ai/historyPolicy";
import { withTimeoutSignal } from "@/lib/ai/providers/openai";
import { buildGenerationState, computePlanCoverage, serializeGenerationState } from "@/lib/ai/generationState";
import { coerceOutline } from "@/lib/ai/outline";
import type { ModelInputItem } from "@/lib/ai/modelClient";
import { executeTool, ToolError, type ToolContext } from "@/lib/ai/tools";
import { clampStructuredTemplate } from "@/lib/course/slide/clampStructured";
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

type GbData = { found?: boolean; availableBlocks?: { blockId: string }[] };

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

  // ── 6. Batch tool — CLAMP-not-reject, per-slide partial success ─────────────
  console.log("\n# add_structured_slides_batch — clamp over-length + save, stamps specId");
  const ctx: ToolContext = { doc, courseId: doc.id, lessonId };
  const validProse = { layoutId: "prose", content: { title: { text: "Greedy works" }, body: { text: "A greedy algorithm builds the answer one safe choice at a time, adding the cheapest valid option each step." } } };
  // Over-length TITLE (prose title cap = 60). Used to be rejected → now auto-shortened.
  const longTitle = "Why the greedy choice is provably safe for this whole family of problems";
  const overLong = { layoutId: "prose", content: { title: { text: longTitle }, body: { text: "A valid enough body sentence for the test." } } };
  // UNSAVEABLE for a non-length reason (body is empty → min(1), can't be invented).
  const noContent = { layoutId: "prose", content: { title: { text: "Has a title" }, body: { text: "" } } };

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

  // CLAMP-AND-SAVE: an over-long slot is auto-shortened to its max and the slide is
  // SAVED (never bounced back as a formatting failure). The shortened slot is noted
  // in `autoShortened`, NOT in `failed`. This is the death-spiral fix.
  const clampBatch = await executeTool("add_structured_slides_batch", JSON.stringify({
    deckBlockId: deckBlk.id,
    slides: [{ slideSpecId: "s1", template: validProse, notes: null }, { slideSpecId: "s2", template: overLong, notes: null }],
  }), ctx);
  check("over-length slide is SAVED, not rejected (2 patches)", clampBatch.patches?.length === 2 && (clampBatch.patches ?? []).every((p) => p.action === "ADD_SLIDE"));
  const clampData = clampBatch.data as { failed?: unknown[]; autoShortened?: { index: number; shortened: string[] }[] };
  check("the auto-shortened slide is NOT reported as failed", (clampData.failed ?? []).length === 0);
  check("the auto-shortened slide IS noted as autoShortened (with the slot)", (clampData.autoShortened ?? []).length === 1 && (clampData.autoShortened![0].shortened.join() || "").includes("title"));
  // The saved over-long slide's title was truncated to the cap.
  const clampPatch = (clampBatch.patches ?? [])[1] as { slide?: { template?: { content?: { title?: { text?: string } } } } };
  const savedTitle = clampPatch.slide?.template?.content?.title?.text ?? "";
  check("the saved title was truncated to ≤ the cap (60)", savedTitle.length > 0 && savedTitle.length <= 60 && savedTitle.length < longTitle.length, `${savedTitle.length}`);

  // ONLY a slide missing required content (unsaveable by clamping) comes back; the
  // valid sibling still SAVES — so "Added 0 slides" can't happen with a valid slide.
  const mixed = await executeTool("add_structured_slides_batch", JSON.stringify({
    deckBlockId: deckBlk.id,
    slides: [{ slideSpecId: "s4", template: validProse, notes: null }, { slideSpecId: "s5", template: noContent, notes: null }],
  }), ctx);
  check("valid slide still SAVES when a sibling is unbuildable (1 patch, not zero)", mixed.patches?.length === 1 && mixed.patches[0].action === "ADD_SLIDE");
  const mixedFailed = (mixed.data as { failed?: { index: number; slideSpecId?: string }[] }).failed ?? [];
  check("only the genuinely-unbuildable slide comes back as failed", mixedFailed.length === 1 && mixedFailed[0].index === 1 && mixedFailed[0].slideSpecId === "s5");

  // A > 4-slide batch is guided against by the description, but still makes
  // progress (all valid slides land) rather than bouncing — partial success.
  const bigBatch = await executeTool("add_structured_slides_batch", JSON.stringify({
    deckBlockId: deckBlk.id,
    slides: Array.from({ length: 5 }, () => ({ slideSpecId: null, template: validProse, notes: null })),
  }), ctx);
  check("a > 4-slide batch still adds all valid slides (no whole-batch bounce)", bigBatch.patches?.length === 5);

  // An empty/garbage slides array is still a clear ToolError (the lenient path
  // validates per-item, but the call itself must carry slides).
  let bouncedEmpty = false;
  try {
    await executeTool("add_structured_slides_batch", JSON.stringify({ deckBlockId: deckBlk.id, slides: [] }), ctx);
  } catch (e) { bouncedEmpty = e instanceof ToolError; }
  check("an empty slides array is a ToolError", bouncedEmpty);

  // ── 6b. clampStructuredTemplate (the leaf) — direct unit checks ─────────────
  console.log("\n# clampStructuredTemplate — leaf behavior");
  const c1 = clampStructuredTemplate(validProse);
  check("a valid template clamps to itself (not clamped)", !!c1.template && c1.clamped === false);
  const c2 = clampStructuredTemplate(overLong);
  check("an over-length template clamps + reports which slot", !!c2.template && c2.clamped === true && c2.clampedPaths.some((p) => p.includes("title")));
  const c3 = clampStructuredTemplate(noContent);
  check("a content-missing template is unsaveable (no template, has error)", !c3.template && !!c3.error);
  // Over-count array (prose allows ≤5 points) is sliced, not rejected.
  const manyPoints = { layoutId: "prose", content: { title: { text: "T" }, body: { text: "A real body sentence here." }, points: Array.from({ length: 9 }, (_, i) => ({ text: `point ${i}` })) } };
  const c4 = clampStructuredTemplate(manyPoints);
  const c4points = (c4.template?.content as { points?: unknown[] } | undefined)?.points ?? [];
  check("an over-count item array is sliced to the cap (≤5), still saved", !!c4.template && c4points.length === 5, `${c4points.length}`);

  // ── 7. SCOPED GENERATE/REPAIR input — plan-first, NO conversation history ──
  console.log("\n# buildScopedAgentInput — plan + state + this run's I/O ONLY");
  const scopedBuild = (n: number) =>
    buildScopedAgentInput({
      contextMessage: "PLAN: build s1,s2,s3 (full per-slide brief here)",
      generationStateSummary: "STATE: s1 built; s2,s3 remaining",
      eventGroups: Array.from({ length: n }, (_, i) => turnGroup(i + 1)),
      maxToolResultChars: 4000,
    });
  const sc = scopedBuild(3);
  check("scoped: the full PLAN (context) is the FIRST message", contentOf(sc.input[0])?.startsWith("PLAN:") === true);
  check("scoped: the generation-state is the SECOND message", contentOf(sc.input[1]) === "STATE: s1 built; s2,s3 remaining");
  // By construction buildScopedAgentInput takes NO history param — assert nothing
  // resembling a conversation message slipped in (only plan, state, this-run I/O).
  const scLeak = sc.input.slice(2).some(
    (it) => "content" in it && /build the lesson|older run summary|current instruction/.test(it.content)
  );
  check("scoped: NO conversation-history messages can appear", !scLeak);
  check("scoped: this run's tool I/O follows (the turn groups)", sc.input.some((it) => "type" in it && it.type === "function_call_output"));
  // A scoped input grows ONLY with this run's own turns, never with the conversation.
  const sc1 = scopedBuild(1);
  check("scoped: size tracks this run's turns, not any transcript", scopedBuild(3).stats.messages > sc1.stats.messages);
  // A bulky get_deck READ is still trimmed (its content lives in the state summary).
  const bulkyRead = buildScopedAgentInput({
    contextMessage: "PLAN",
    eventGroups: [[
      { type: "function_call", callId: "d1", name: "get_deck", arguments: "{}" },
      { type: "function_call_output", callId: "d1", output: JSON.stringify([{ slideId: "s_a", layout: "prose", slots: [{ role: "body", text: "z".repeat(6000) }] }]) },
    ]],
    maxToolResultChars: 4000,
  });
  const trimmed = bulkyRead.input.find((it) => "type" in it && it.type === "function_call_output") as { output?: string } | undefined;
  check("scoped: a bulky get_deck read is compacted (not replayed whole)", (trimmed?.output?.length ?? 1e9) < 6000 && trimmed!.output!.includes("compacted"));

  // ── 8. DETERMINISTIC specId stamping (planSpecIds in the tool ctx) ──────────
  console.log("\n# add_structured_slides_batch — guaranteed specId stamping");
  const stampDoc = freshDoc();
  const stampDeck = createBlock("slide_deck") as SlideDeckBlock;
  stampDeck.slides = []; // pre-created empty deck (the GENERATE target)
  stampDoc.doc.modules[0].lessons[0].blocks.push(stampDeck);
  const planCtx: ToolContext = { doc: stampDoc.doc, courseId: stampDoc.doc.id, lessonId: stampDoc.lessonId, planSpecIds: ["s1", "s2", "s3"] };
  const vp = { layoutId: "prose", content: { title: { text: "A point" }, body: { text: "A real teaching sentence that says enough to matter." } } };
  // The model OMITS every slideSpecId → they're auto-assigned in plan order.
  const omit = await executeTool("add_structured_slides_batch", JSON.stringify({
    deckBlockId: stampDeck.id,
    slides: [{ slideSpecId: null, template: vp, notes: null }, { slideSpecId: null, template: vp, notes: null }],
  }), planCtx);
  const omitAdded = (omit.data as { slidesAdded?: { specId?: string }[] }).slidesAdded ?? [];
  check("specId auto-assign: omitted ids filled from plan order (s1, s2)", omitAdded[0]?.specId === "s1" && omitAdded[1]?.specId === "s2", omitAdded.map((s) => s.specId).join(","));
  // Apply, then a SECOND batch: a WRONG id ("s9", not a plan spec) maps to the next
  // unclaimed plan spec (s3), so coverage can never read covered:0/extra:N.
  let stampApplied = stampDoc.doc;
  for (const p of omit.patches ?? []) { const r = applyCoursePatch(stampApplied, p, NOW); if (r.ok) stampApplied = r.doc; }
  const planCtx2: ToolContext = { doc: stampApplied, courseId: stampApplied.id, lessonId: stampDoc.lessonId, planSpecIds: ["s1", "s2", "s3"] };
  const wrong = await executeTool("add_structured_slides_batch", JSON.stringify({
    deckBlockId: stampDeck.id,
    slides: [{ slideSpecId: "s9", template: vp, notes: null }],
  }), planCtx2);
  const wrongAdded = (wrong.data as { slidesAdded?: { specId?: string }[] }).slidesAdded ?? [];
  check("specId auto-assign: a non-plan id remaps to the next unclaimed spec (s3)", wrongAdded[0]?.specId === "s3", String(wrongAdded[0]?.specId));
  // No plan ctx (edit path) → the model's id is honored verbatim, unchanged.
  const editCtx: ToolContext = { doc: stampApplied, courseId: stampApplied.id, lessonId: stampDoc.lessonId };
  const edited = await executeTool("add_structured_slides_batch", JSON.stringify({
    deckBlockId: stampDeck.id,
    slides: [{ slideSpecId: "custom-x", template: vp, notes: null }],
  }), editCtx);
  check("specId: edit path (no plan) honors the model's id unchanged", ((edited.data as { slidesAdded?: { specId?: string }[] }).slidesAdded ?? [])[0]?.specId === "custom-x");

  // ── 9. HARD deadline signal (the transport-timeout enforcement) ─────────────
  console.log("\n# withTimeoutSignal — a call can't exceed its deadline");
  const dl = withTimeoutSignal(undefined, 30);
  const firedAt = await new Promise<boolean>((resolve) => {
    dl.signal!.addEventListener("abort", () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 400);
  });
  check("deadline fires + is flagged as a timeout", firedAt && dl.timedOut());
  dl.dispose();
  const parent = new AbortController();
  const dl2 = withTimeoutSignal(parent.signal, 100000);
  parent.abort();
  check("a parent (user Stop) abort is forwarded — NOT flagged as a timeout", dl2.signal!.aborted && !dl2.timedOut());
  dl2.dispose();
  check("no deadline + no parent → no signal (prior behavior preserved)", withTimeoutSignal(undefined, undefined).signal === undefined);

  // ── 10. DIAGNOSTIC — discriminate the causes of "missing content" (STEP 2) ──
  console.log("\n# missing-content rejection — cause discrimination");
  // A. VALIDATOR-TOO-STRICT? Run obviously-valid payloads through the EXACT validation
  //    the batch tool uses (clampStructuredTemplate). A valid slide MUST be accepted; an
  //    OPTIONAL field omitted MUST NOT cause rejection.
  const validFull = { layoutId: "prose", content: { title: { text: "Greedy choice" }, body: { text: "A greedy algorithm takes the locally optimal option at each step, never reconsidering." }, points: [{ text: "optimal substructure" }, { text: "greedy-choice property" }] } };
  const validMinimal = { layoutId: "prose", content: { title: { text: "Loop invariant" }, body: { text: "A condition that holds before and after every iteration of the loop." } } };
  check("A. validator ACCEPTS a full valid slide (NOT over-strict)", !!clampStructuredTemplate(validFull).template, clampStructuredTemplate(validFull).error);
  check("A. validator ACCEPTS a minimal valid slide — omitting an OPTIONAL field is fine", !!clampStructuredTemplate(validMinimal).template, clampStructuredTemplate(validMinimal).error);

  // C. EMPTY-FIELD-FROM-AUTHOR? An empty REQUIRED field is rejected with a PRECISE field
  //    path (so the log pinpoints what the author left empty) — distinct from a valid slide.
  const emptyBody = clampStructuredTemplate({ layoutId: "prose", content: { title: { text: "Has a title" }, body: { text: "" } } });
  check("C. an empty REQUIRED field is rejected (genuinely missing content)", !emptyBody.template && !!emptyBody.error);
  check("C. the rejection NAMES the exact field (body), not a vague 'missing content'", /body/i.test(emptyBody.error ?? ""), emptyBody.error);

  // B. TRUNCATION manifests DIFFERENTLY: a batch JSON cut mid-string is a PARSE error
  //    ("Invalid JSON arguments"), NOT an Added-0/missing-content result.
  const diagDoc = freshDoc();
  const diagDeck = createBlock("slide_deck") as SlideDeckBlock; diagDeck.slides = [];
  diagDoc.doc.modules[0].lessons[0].blocks.push(diagDeck);
  const diagCtx = (extra: Partial<ToolContext> = {}): ToolContext => ({ doc: diagDoc.doc, courseId: diagDoc.doc.id, lessonId: diagDoc.lessonId, ...extra });
  const fullBatch = JSON.stringify({ deckBlockId: diagDeck.id, slides: [{ slideSpecId: "s1", template: validMinimal, notes: null }] });
  let truncMsg = "";
  try { await executeTool("add_structured_slides_batch", fullBatch.slice(0, fullBatch.length - 25), diagCtx()); }
  catch (e) { truncMsg = e instanceof ToolError ? e.message : "other"; }
  check("B. a truncated batch JSON is a PARSE error (distinct from missing-content)", /Invalid JSON arguments/.test(truncMsg), truncMsg);

  // B2. A COMPLETE-but-empty final slide (the 'ran out of budget' degenerate {}) parses
  //     and reads as missing-content: the valid sibling SAVES, only the empty one fails.
  const degenerate = { layoutId: "prose", content: {} };
  const b2 = await executeTool("add_structured_slides_batch", JSON.stringify({ deckBlockId: diagDeck.id, slides: [{ slideSpecId: "s1", template: validMinimal, notes: null }, { slideSpecId: "s2", template: degenerate, notes: null }] }), diagCtx());
  check("B2. a complete-but-empty slide reads as missing-content; the valid sibling still SAVES", b2.patches?.length === 1, `${b2.patches?.length}`);
  const b2failed = (b2.data as { failed?: { slideSpecId?: string }[] }).failed ?? [];
  check("B2. only the empty slide is reported failed", b2failed.length === 1 && b2failed[0].slideSpecId === "s2");

  // Prove the INSTRUMENTATION emits the raw Zod reason + payload + spec context.
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { captured.push(a.map(String).join(" ")); };
  try {
    await executeTool("add_structured_slides_batch", JSON.stringify({ deckBlockId: diagDeck.id, slides: [{ slideSpecId: "s3", template: degenerate, notes: null }] }), diagCtx({ planSpecIds: ["s3"], planSpecPoints: { s3: 4 } }));
  } finally { console.log = origLog; }
  const rejectLog = captured.find((l) => l.includes('"slide_reject"'));
  check("instrumentation emits slide_reject with the raw zodError + payload + plan-spec context", !!rejectLog && /zodError/.test(rejectLog!) && /payloadPreview/.test(rejectLog!) && /"planSpecPointCount":4/.test(rejectLog!), rejectLog?.slice(0, 160));

  // D. REFERENCE RESOLUTION — get_block resolves a valid id, and FAILS GRACEFULLY on a
  //    missing one (returns the lesson's real blocks, never throws → no retry loop).
  const gbOk = await executeTool("get_block", JSON.stringify({ blockId: diagDeck.id }), diagCtx());
  check("D. get_block resolves a VALID block id", (gbOk.data as { id?: string }).id === diagDeck.id);
  let gbThrew = false;
  let gbData: GbData | null = null;
  try { gbData = (await executeTool("get_block", JSON.stringify({ blockId: "made-up-id" }), diagCtx())).data as GbData; }
  catch { gbThrew = true; }
  check("D. get_block does NOT throw on a missing id (no retry loop)", !gbThrew);
  check("D. get_block returns found:false + the lesson's real blocks for self-correction", gbData?.found === false && !!gbData.availableBlocks?.some((b) => b.blockId === diagDeck.id));

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
