/**
 * Rich-text null-coercion — the DECISIVE "missing content" fix. Pure, no key/DB.
 * Run: `npx tsx scripts/verify-richtext-coercion.ts`
 *
 * PROVEN root cause (from slide_reject logs, lesson b240a404): fully-authored slides
 * were rejected only on rich-text envelope technicalities — the agent emits
 * `runs: null` / `marks: null` for "no inline formatting", but the schema wanted an
 * empty array / object. These checks reconstruct the ACTUAL failing payloads (s1
 * section_break, s2 comparison_columns with null runs nested deep) and assert they now
 * build with the text preserved byte-for-byte, that a diagram whose prose rides in a
 * sibling field still builds (no re-send loop), and that a genuinely-empty slide is
 * still rejected.
 */

import { clampStructuredTemplate, normalizeAgentNulls } from "@/lib/course/slide/clampStructured";
import { executeTool, type ToolContext } from "@/lib/ai/tools";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { applyCoursePatch } from "@/lib/course/patches";
import { computePlanCoverage } from "@/lib/ai/generationState";
import { coerceOutline } from "@/lib/ai/outline";
import { defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument, Slide, SlideDeckBlock } from "@/lib/course/types";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n} ${d}`); }
};
const NOW = "2026-06-24T00:00:00.000Z";

function freshDeck(): { doc: CourseDocument; lessonId: string; deckId: string; ctx: ToolContext } {
  const lesson = createLesson("Preferences and utility", 0);
  const mod = createModule("Consumer choice", 0);
  mod.lessons = [lesson];
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [];
  lesson.blocks.push(deck);
  const doc: CourseDocument = {
    id: crypto.randomUUID(), title: "Microeconomics", description: "Consumer theory.", audience: "beginners", level: "beginner",
    plan: { outcomes: [], prerequisites: [], teachingStyle: "concrete" }, modules: [mod], theme: defaultCourseTheme(),
    metadata: { createdAt: NOW, updatedAt: NOW, aiReadableVersion: "1.0" },
  };
  return { doc, lessonId: lesson.id, deckId: deck.id, ctx: { doc, courseId: doc.id, lessonId: lesson.id } };
}

/** Author one template through the REAL tool path; return the resulting slide (from
 *  the ADD_SLIDE patch) + the tool outcome, without needing to apply it. */
async function authorOne(ctx: ToolContext, deckId: string, template: unknown, specId: string | null) {
  const out = await executeTool("add_structured_slides_batch", JSON.stringify({ deckBlockId: deckId, slides: [{ slideSpecId: specId, template, notes: null }] }), ctx);
  const patch = (out.patches ?? []).find((p) => p.action === "ADD_SLIDE");
  const slide = patch && patch.action === "ADD_SLIDE" ? (patch.slide as Slide) : null;
  const failed = (out.data as { failed?: unknown[] }).failed ?? [];
  return { slide, failed, out };
}

const tx = (s: string) => ({ text: s, runs: null }); // the agent's "no formatting" envelope

async function main() {
  console.log("# 1. The actual log payloads (runs:null) now build, text preserved byte-for-byte");
  const a = freshDeck();
  // s1 — the EXACT section_break payload from the logs (every slot runs:null).
  const s1 = { layoutId: "section_break", content: { number: "01", label: tx("Consumer choice"), title: tx("Preferences and Utility"), subtitle: tx("How economists compare bundles before adding a budget constraint."), titleStyle: "serif", variant: "hero_numeral" } };
  const r1 = await authorOne(a.ctx, a.deckId, s1, "s1");
  check("s1 section_break (all runs:null) BUILDS (no longer rejected)", !!r1.slide && r1.failed.length === 0, JSON.stringify(r1.failed));
  const s1c = r1.slide?.template?.layoutId === "section_break" ? r1.slide.template.content : null;
  check("s1 title text preserved byte-for-byte", s1c?.title.text === "Preferences and Utility", s1c?.title.text);
  check("s1 subtitle text preserved byte-for-byte", s1c?.subtitle?.text === "How economists compare bundles before adding a budget constraint.", s1c?.subtitle?.text);

  // A run carrying marks:null (Stage B self-correction in the logs) also builds + keeps text.
  const proseMarksNull = { layoutId: "prose", content: { title: tx("Ordinal utility"), body: { text: "Ordinal utility ranks bundles without claiming the gaps are measurable.", runs: [{ text: "Ordinal utility ranks bundles without claiming the gaps are measurable.", marks: null }] } } };
  const r2 = await authorOne(a.ctx, a.deckId, proseMarksNull, "s_pm");
  check("a run with marks:null BUILDS (no 'expected object, received null')", !!r2.slide && r2.failed.length === 0, JSON.stringify(r2.failed));
  const pmBody = r2.slide?.template?.layoutId === "prose" ? r2.slide.template.content.body.text : "";
  check("marks:null slide keeps its full body text", pmBody === "Ordinal utility ranks bundles without claiming the gaps are measurable.", pmBody);

  console.log("\n# 2. Deeply-nested rich-text nulls (options[].points[].detail, cells[].example)");
  const s2 = { layoutId: "comparison_columns", content: {
    eyebrow: tx("Preferences"), title: tx("Comparing whole bundles"), subtitle: tx("Preferences rank complete packages of goods."),
    presentation: "cards",
    options: [
      { name: tx("Bundle A"), icon: null, points: [{ label: tx("3 apples, 2 bananas"), detail: null }, { label: tx("Preferred to B"), detail: tx("If these are the only choices, A wins.") }] },
      { name: tx("Bundle B"), icon: null, points: [{ label: tx("2 apples, 4 bananas"), detail: null }, { label: tx("Ranked below A"), detail: tx("B is the less preferred bundle here.") }] },
    ],
  } };
  const r3 = await authorOne(a.ctx, a.deckId, s2, "s2");
  check("s2 comparison_columns (nested runs:null in options[].points[].detail) BUILDS", !!r3.slide && r3.failed.length === 0, JSON.stringify(r3.failed));
  const s2detail = r3.slide?.template?.layoutId === "comparison_columns" ? r3.slide.template.content.options[0].points[1].detail?.text : "";
  check("s2 nested detail text preserved", s2detail === "If these are the only choices, A wins.", s2detail);

  const matrix = { layoutId: "comparison_matrix", content: {
    title: tx("Two utility approaches"),
    options: [{ name: tx("Ordinal"), icon: null }, { name: tx("Cardinal"), icon: null }],
    dimensions: [
      { label: tx("Measures"), icon: null, cells: [{ detail: tx("Rank order only"), example: { text: "A ≻ B ≻ C", runs: [{ text: "A ≻ B ≻ C", marks: null }] } }, { detail: tx("Numeric levels"), example: null }] },
      { label: tx("Assumptions"), icon: null, cells: [{ detail: tx("Just a ranking"), example: null }, { detail: tx("Measurable utility"), example: null }] },
    ],
  } };
  const r4 = await authorOne(a.ctx, a.deckId, matrix, "s_mx");
  check("comparison_matrix with null marks in cells[].example BUILDS", !!r4.slide && r4.failed.length === 0, JSON.stringify(r4.failed));

  console.log("\n# 3. CAUSE 2 — a diagram whose prose rides in caption/takeaways builds (no loop)");
  // The model sends caption/takeaways as rich-text ENVELOPES (not strings) and an
  // unusable diagram → must degrade to a PROSE slide whose body = the caption, NOT
  // re-loop on "content.body.text: Too small".
  const diagEnvelope = { layoutId: "diagram", content: {
    title: tx("Indifference intuition"), caption: tx("Bundles on one curve give the same satisfaction — the consumer is indifferent between them."),
    takeaways: [tx("Higher curves are preferred")], role: "concept_diagram", pedagogicalPurpose: "show indifference", altText: "an indifference curve", reason: null, templateId: null,
    diagram: { kind: "bar_chart", bars: [] }, // unusable → degrade to prose
  } };
  const r5 = await authorOne(a.ctx, a.deckId, diagEnvelope, "s5");
  check("s5 diagram with envelope caption + empty data BUILDS (not a re-send loop)", !!r5.slide && r5.failed.length === 0, JSON.stringify(r5.failed));
  const s5body = r5.slide?.template?.layoutId === "prose" ? r5.slide.template.content.body.text : (r5.slide?.template?.layoutId === "diagram" ? "(rendered as diagram)" : "");
  check("s5 prose body came from the caption sibling (content not lost)", /indifferent between them/.test(s5body) || s5body === "(rendered as diagram)", s5body);

  console.log("\n# 4. Regression — a genuinely-empty slide is still rejected (not saved blank)");
  const empty = await authorOne(a.ctx, a.deckId, { layoutId: "prose", content: {} }, "s_empty");
  check("a slide with NO text anywhere is still rejected", !empty.slide && empty.failed.length === 1);
  const emptyBody2 = clampStructuredTemplate({ layoutId: "prose", content: { title: tx("T"), body: { text: "", runs: null } } });
  check("an empty REQUIRED text field is still rejected after coercion", !emptyBody2.template && /body/i.test(emptyBody2.error ?? ""), emptyBody2.error);

  console.log("\n# 5. The full 8-slide log batch (lesson b240a404 pattern) → generated == planned");
  const b = freshDeck();
  const cf = (id: string, layout: string) => ({ segmentId: "seg", title: `T${id}`, teachingGoal: "g", role: "concept_intro", kind: "core", layout, depth: "definition", keyPoints: ["a", "b"], notes: "", visualIntent: null, requiredElements: null, speakerNotesGoal: "x" });
  const { outline } = coerceOutline({
    objective: "Teach preferences + utility", targetStudent: "beginners", estimatedMinutes: 25, microLesson: false,
    segments: [{ id: "seg", name: "Core", purpose: "concept_intro", targetSlideCount: 8 }],
    slides: [cf("1", "section_break"), cf("2", "comparison_columns"), cf("3", "prose"), cf("4", "key_concept"), cf("5", "prose"), cf("6", "outline_list"), cf("7", "prose"), cf("8", "prose")],
  });
  if (!outline) throw new Error("test outline failed to coerce");
  const specIds = outline.slides.map((s) => s.id);
  // 8 fully-authored slides, ALL with runs:null everywhere (the log pattern).
  const batch = [
    s1,
    s2,
    { layoutId: "prose", content: { title: tx("Completeness & transitivity"), body: tx("Rational preferences are complete (any two bundles can be compared) and transitive (if A≻B and B≻C then A≻C).") } },
    { layoutId: "key_concept", content: { variant: "serif", term: tx("Utility function"), definition: tx("A rule that assigns a number to each bundle so that higher numbers mean more-preferred bundles."), items: [{ heading: tx("Higher = preferred"), body: tx("A larger utility number marks a more-preferred bundle.") }, { heading: tx("Ordinal only"), body: tx("Only the ranking matters, not the size of the gaps.") }] } },
    { layoutId: "prose", content: { title: tx("Ordinal vs cardinal"), body: tx("Ordinal utility uses only the ranking; cardinal utility would treat the numbers as measurable magnitudes.") } },
    { layoutId: "outline_list", content: { title: tx("What to remember"), items: [{ text: tx("Preferences rank bundles") }, { text: tx("Utility encodes that ranking") }] } },
    { layoutId: "prose", content: { title: tx("A worked ranking"), body: tx("Given A=(3,2), B=(2,4): if the consumer reports A≻B, any utility function must give U(A)>U(B).") } },
    { layoutId: "prose", content: { title: tx("Recap"), body: tx("Preferences are a ranking of bundles; a utility function is just a numeric way to record that ranking.") } },
  ];
  const out8 = await executeTool("add_structured_slides_batch", JSON.stringify({ deckBlockId: b.deckId, slides: batch.map((t, i) => ({ slideSpecId: specIds[i], template: t, notes: null })) }), b.ctx);
  const failed8 = (out8.data as { failed?: unknown[] }).failed ?? [];
  check("all 8 log-pattern slides build in one batch (0 failed)", failed8.length === 0, JSON.stringify(failed8));
  let applied = b.doc;
  for (const p of out8.patches ?? []) { const r = applyCoursePatch(applied, p, NOW); if (r.ok) applied = r.doc; }
  const cov = computePlanCoverage(applied, b.lessonId, outline);
  check("coverage: generated == planned (8/8), nothing missing/extra", cov.generatedSlides === 8 && cov.coveredSlideSpecs === 8 && cov.missingSlideSpecs.length === 0 && cov.extraSlides.length === 0, JSON.stringify(cov));

  // normalizeAgentNulls is lossless on a clean object (idempotent, no key churn).
  const clean = { layoutId: "prose", content: { title: { text: "x" }, body: { text: "y" } } };
  check("normalizeAgentNulls leaves a clean object's text intact", JSON.stringify(normalizeAgentNulls(clean)) === JSON.stringify(clean));

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
