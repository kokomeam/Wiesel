/**
 * Outline PLAN-path checks — pure, no key/DB. Run: `npx tsx scripts/verify-outline.ts`
 *
 * Guards the bug class the MOCK provider hid (this path had never run against
 * OpenAI's real strict json_schema validation):
 *  1. The generated lesson/module response-format schemas obey OpenAI strict
 *     rules (no unsupported keywords; every object additionalProperties:false +
 *     required listing every property).
 *  2. The bounds-relaxed parse accepts a 1-slide / over-count outline (strict
 *     ignores min/max → don't hard-reject locally) and clamps to the caps.
 *  3. `messageTextFromOutput` recovers the assistant JSON from `message` items
 *     when `output_text` is empty (the real root cause: reasoning + structured
 *     output returns an empty `output_text`).
 */

import { classifyIntent } from "@/lib/ai/intent";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { messageTextFromOutput } from "@/lib/ai/providers/openai";
import {
  coerceModuleFallback,
  coerceModuleSkeleton,
  coerceOutline,
  ensureLessonArc,
  isContinuationSlide,
  lessonBriefToPlanRequest,
  moduleFallbackResponseFormat,
  moduleSkeletonResponseFormat,
  outlineResponseFormat,
  MAX_LESSON_SLIDES,
  MAX_MODULE_LESSONS,
} from "@/lib/ai/outline";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n} ${d}`); }
};

// Keywords OpenAI's strict json_schema subset rejects (mirror of schema.ts).
const FORBIDDEN = ["minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "default", "$schema"];

/** Walk a JSON Schema, collecting strict-rule violations. */
function auditStrict(node: unknown, path: string, errs: string[]) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => auditStrict(n, `${path}[${i}]`, errs));
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN.includes(k)) errs.push(`${path}.${k} (forbidden keyword)`);
  }
  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    if (obj.additionalProperties !== false) errs.push(`${path}: additionalProperties !== false`);
    const props = Object.keys(obj.properties as Record<string, unknown>);
    const required = Array.isArray(obj.required) ? (obj.required as string[]) : [];
    const missing = props.filter((p) => !required.includes(p));
    if (missing.length) errs.push(`${path}: required missing [${missing.join(",")}]`);
  }
  for (const [k, v] of Object.entries(obj)) auditStrict(v, `${path}.${k}`, errs);
}

async function main() {
  // ── 0. Routing: a module build that NAMES its lessons must hit the module
  //       pipeline (the old `!/lessons/` guard misrouted it to a single lesson);
  //       "add a lesson to module X" stays a single lesson. Both short-circuit
  //       (no model call) — assert the mock was never consulted.
  const noModel = createMockModelClient([]);
  const route = (msg: string) => classifyIntent(noModel, { hasDeck: false }, msg);
  check("module build naming its lessons → generate_module", (await route("Please create module 4 on sorting; only do the first 2 lessons for now")) === "generate_module");
  check("module build (no lessons word) → generate_module", (await route("Add a search algorithms module covering linear and binary search")) === "generate_module");
  check("add a lesson to a module → generate_lesson (not module)", (await route("Add a lesson to module 2 on recursion")) === "generate_lesson");
  check("build out this lesson → generate_lesson", (await route("Build out this lesson with a full slide deck")) === "generate_lesson");
  check("routing short-circuits used no model call", noModel.getCalls().length === 0, `${noModel.getCalls().length}`);

  // ── 1. Strict-schema shape (lesson + the compact module SKELETON + fallback).
  for (const [label, rf] of [
    ["lesson", outlineResponseFormat()],
    ["module_skeleton", moduleSkeletonResponseFormat()],
    ["module_fallback", moduleFallbackResponseFormat()],
  ] as const) {
    const errs: string[] = [];
    auditStrict(rf.schema, label, errs);
    check(`${label} response schema obeys OpenAI strict rules`, errs.length === 0, errs.slice(0, 4).join(" | "));
  }

  // ── 2. Bounds-relaxed parse (the rich teaching-contract shape).
  const slide = { segmentId: "seg1", title: "t", teachingGoal: "g", layout: "key_concept", depth: "definition", keyPoints: ["a"], notes: "n", visualIntent: null, requiredElements: null, speakerNotesGoal: "explain it" };
  const one = coerceOutline({ objective: "o", targetStudent: "ts", estimatedMinutes: 10, segments: [{ id: "seg1", name: "Concept", purpose: "concept_intro", targetSlideCount: 1 }], slides: [slide] });
  check("coerceOutline accepts a 1-slide contract (strict ignores min)", one.outline?.slides.length === 1);
  check("coerceOutline assigns a stable slide id", !!one.outline?.slides[0].id);
  check("coerceOutline derives segment slideSpecIds from segmentId grouping", one.outline?.segments[0]?.slideSpecIds.length === 1 && one.outline.segments[0].slideSpecIds[0] === one.outline.slides[0].id);
  // Idempotent: re-coercing the flat (already-ided) form keeps the same ids.
  const re = coerceOutline(one.outline);
  check("coerceOutline is idempotent on the flat form (ids preserved)", re.outline?.slides[0].id === one.outline?.slides[0].id);
  const many = coerceOutline({ objective: "o", segments: [], slides: Array.from({ length: MAX_LESSON_SLIDES + 12 }, () => slide) });
  check(`coerceOutline clamps to the ${MAX_LESSON_SLIDES}-slide safety rail`, many.outline?.slides.length === MAX_LESSON_SLIDES, `${many.outline?.slides.length}`);
  check("coerceOutline rejects 0 slides", !coerceOutline({ objective: "o", segments: [], slides: [] }).outline);
  check("coerceOutline rejects a bad layout enum", !coerceOutline({ objective: "o", segments: [], slides: [{ ...slide, layout: "title_bullets" }] }).outline);

  // ── 2b. ensureLessonArc — guarantees a titled opener + recap closer (non-micro),
  //        applied by the pipeline AFTER the depth floor (so the floor measures the
  //        model's real content) and BEFORE approval. coerceOutline stays PURE.
  const arcSeg = [{ id: "seg1", name: "Core", purpose: "concept_intro", targetSlideCount: 2 }];
  const arcSlide = (role: string, layout: string, title: string) => ({ segmentId: "seg1", title, teachingGoal: "g", role, kind: "core", layout, depth: "definition", keyPoints: ["a point"], notes: "", visualIntent: null, requiredElements: null, speakerNotesGoal: "x" });
  const arcBase = coerceOutline({ objective: "Teach X", targetStudent: "ts", estimatedMinutes: 10, microLesson: false, segments: arcSeg, slides: [arcSlide("hook", "prose", "Hook"), arcSlide("concept_intro", "key_concept", "Concept")] }).outline!;
  const arced = ensureLessonArc(arcBase);
  check("ensureLessonArc prepends a section_break opener", arced.slides[0].layout === "section_break" && arced.slides[0].role === "hook");
  check("ensureLessonArc appends a recap closer", arced.slides[arced.slides.length - 1].role === "recap");
  check("ensureLessonArc grew the deck by exactly 2 (opener + recap)", arced.slides.length === arcBase.slides.length + 2);
  check("ensureLessonArc re-ids slides contiguously s1..sN", arced.slides.every((s, i) => s.id === `s${i + 1}`));
  check("ensureLessonArc re-derives segment slideSpecIds to include opener+recap", arced.segments[0].slideSpecIds.length === arced.slides.length);
  check("ensureLessonArc is idempotent (re-applying is a no-op ref)", ensureLessonArc(arced) === arced);

  const goodArc = coerceOutline({ objective: "o", microLesson: false, segments: arcSeg, slides: [arcSlide("hook", "section_break", "Title"), arcSlide("recap", "prose", "Recap")] }).outline!;
  check("ensureLessonArc leaves an already-arc'd plan untouched (same ref)", ensureLessonArc(goodArc) === goodArc);
  const micro = coerceOutline({ objective: "o", microLesson: true, segments: arcSeg, slides: [arcSlide("concept_intro", "prose", "One")] }).outline!;
  check("ensureLessonArc skips a micro lesson (same ref)", ensureLessonArc(micro) === micro);

  // ── 2c. METHOD 1 — content-first planning + splits (no truncation).
  // (i) The model-facing slide schema lists keyPoints BEFORE layout (points decided
  //     first, layout chosen to fit them).
  const lessonSchema = outlineResponseFormat().schema as { properties?: { slides?: { items?: { properties?: Record<string, unknown> } } } };
  const slideProps = Object.keys(lessonSchema.properties?.slides?.items?.properties ?? {});
  const kpIdx = slideProps.indexOf("keyPoints");
  const layoutIdx = slideProps.indexOf("layout");
  check("content-first: keyPoints precedes layout in the slide schema", kpIdx >= 0 && layoutIdx >= 0 && kpIdx < layoutIdx, `keyPoints@${kpIdx} layout@${layoutIdx}`);
  // The split is now a DETERMINISTIC rule (code), NOT a model decision — so the heavy
  // split + requiredElements fields are GONE from the strict output schema (fewer
  // constrained fields per slide = far less plan reasoning; the runaway fix).
  check("split is deterministic: continuationOf is NOT a model schema field", !slideProps.includes("continuationOf"), slideProps.join(","));
  check("schema trimmed: requiredElements is NOT a model schema field", !slideProps.includes("requiredElements"), slideProps.join(","));

  const cf = (title: string, layout: string, pts: string[], continuationOf: string | null = null) => ({
    segmentId: "seg1", title, teachingGoal: "g", role: "concept_intro", kind: "core", layout, depth: "definition",
    keyPoints: pts, continuationOf, notes: "", visualIntent: null, requiredElements: null, speakerNotesGoal: "x",
  });

  // (ii) CONTINUATION split — one idea overflowing: a 2nd slide titled "X (cont.)",
  //      linked to the parent, repeating NONE of its points, dropping ZERO unique info.
  const split = coerceOutline({
    objective: "o", targetStudent: "ts", estimatedMinutes: 10, microLesson: true,
    segments: [{ id: "seg1", name: "Core", purpose: "concept_intro", targetSlideCount: 2 }],
    slides: [
      cf("Deadweight loss", "key_concept", ["A claim", "B claim", "C claim", "D claim"]),
      cf("Deadweight loss", "key_concept", ["D claim", "E claim", "F claim"], "Deadweight loss"), // "D claim" duplicates the parent
    ],
  }).outline!;
  const parent = split.slides[0], cont = split.slides[1];
  check("continuation: title stamped with '(cont.)' off the parent", /\(cont\.?\)$/i.test(cont.title) && cont.title.startsWith("Deadweight loss"), cont.title);
  check("continuation: continuationOf resolves to the parent's base title", cont.continuationOf === "Deadweight loss", String(cont.continuationOf));
  check("continuation: shares NO bullet with the parent (exact dup dropped)", !cont.keyPoints.some((p) => parent.keyPoints.includes(p)), cont.keyPoints.join(","));
  const originalUnique = new Set(["A claim", "B claim", "C claim", "D claim", "E claim", "F claim"]);
  const acrossPair = new Set([...parent.keyPoints, ...cont.keyPoints]);
  check("continuation: ZERO unique points dropped (no information loss)", [...originalUnique].every((p) => acrossPair.has(p)), [...acrossPair].join(","));
  check("isContinuationSlide flags the continuation, not the parent", isContinuationSlide(cont) && !isContinuationSlide(parent));
  check("the parent slide is NOT mutated by the split (keeps all its points)", parent.keyPoints.length === 4 && !parent.continuationOf);

  // (iii) SUB-TOPIC split — two distinct sub-ideas get two real descriptive titles,
  //       neither a continuation.
  const sub = coerceOutline({
    objective: "o", microLesson: true,
    segments: [{ id: "seg1", name: "C", purpose: "concept_intro", targetSlideCount: 2 }],
    slides: [cf("Causes of deadweight loss", "outline_list", ["c1", "c2"]), cf("Effects of deadweight loss", "outline_list", ["e1", "e2"])],
  }).outline!;
  check("sub-topic split: two DISTINCT descriptive titles, neither '(cont.)'", sub.slides[0].title !== sub.slides[1].title && !sub.slides.some((s) => /\(cont\.?\)/i.test(s.title)), sub.slides.map((s) => s.title).join(" / "));
  check("sub-topic split: neither slide is a continuation", !sub.slides[0].continuationOf && !sub.slides[1].continuationOf && !isContinuationSlide(sub.slides[0]) && !isContinuationSlide(sub.slides[1]));

  // (v) DETERMINISTIC overflow split — a slide the model crammed with > 6 points
  //     is split in CODE (the model never marked continuationOf), parent + cont.,
  //     no point dropped. This replaces the model's split reasoning.
  const overflow = coerceOutline({
    objective: "o", microLesson: true,
    segments: [{ id: "seg1", name: "C", purpose: "concept_intro", targetSlideCount: 1 }],
    slides: [cf("Big idea", "prose", ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"])],
  }).outline!;
  check("deterministic split: an 8-point slide (no model continuationOf) splits into 2", overflow.slides.length === 2, `${overflow.slides.length}`);
  check("deterministic split: parent keeps the first 6 points", overflow.slides[0].keyPoints.length === 6 && !overflow.slides[0].continuationOf, `${overflow.slides[0].keyPoints.length}`);
  check("deterministic split: continuation marked '(cont.)' carries the overflow", isContinuationSlide(overflow.slides[1]) && overflow.slides[1].keyPoints.length === 2, overflow.slides[1].keyPoints.join(","));
  check("deterministic split: NO point dropped (6 + 2 = 8)", overflow.slides.flatMap((s) => s.keyPoints).length === 8, String(overflow.slides.flatMap((s) => s.keyPoints).length));
  check("deterministic split: ids stay contiguous s1..sN after the split", overflow.slides.every((s, i) => s.id === `s${i + 1}`), overflow.slides.map((s) => s.id).join(","));

  // (iv) Deck-level layout VARIETY is preserved (the model varies; coerce keeps it).
  const variety = coerceOutline({
    objective: "o", microLesson: true,
    segments: [{ id: "seg1", name: "C", purpose: "concept_intro", targetSlideCount: 4 }],
    slides: [cf("A", "key_concept", ["x"]), cf("B", "process_steps", ["x"]), cf("C", "comparison_columns", ["x"]), cf("D", "metrics_overview", ["x"])],
  }).outline!;
  check("deck-level layout variety preserved (≥3 distinct layout types)", new Set(variety.slides.map((s) => s.layout)).size >= 3, variety.slides.map((s) => s.layout).join(","));

  // ── Module SKELETON coerce — the compact lesson MAP (NO per-slide arrays).
  const brief = { title: "Linear search", objective: "Scan an array in order.", rationale: "starts the unit", skillsIntroduced: ["scanning"], minSlides: 2, maxSlides: 99, suggestedBlocks: ["quiz"], recommendQuiz: true };
  const sk = coerceModuleSkeleton({ moduleTitle: "Searching", moduleObjective: "find things", lessons: Array.from({ length: MAX_MODULE_LESSONS + 6 }, () => brief) });
  check(`coerceModuleSkeleton clamps to the ${MAX_MODULE_LESSONS}-lesson safety rail`, sk.skeleton?.lessons.length === MAX_MODULE_LESSONS, `${sk.skeleton?.lessons.length}`);
  check("coerceModuleSkeleton normalizes the slide range (min≥3, max≤cap)", sk.skeleton?.lessons[0].minSlides === 3 && sk.skeleton.lessons[0].maxSlides === MAX_LESSON_SLIDES, `${sk.skeleton?.lessons[0].minSlides}-${sk.skeleton?.lessons[0].maxSlides}`);
  check("coerceModuleSkeleton forces slide_deck into suggestedBlocks", sk.skeleton?.lessons[0].suggestedBlocks.includes("slide_deck") === true);
  check("coerceModuleSkeleton drops untitled lessons + requires ≥1", coerceModuleSkeleton({ moduleTitle: "M", lessons: [{ title: "" }, brief] }).skeleton?.lessons.length === 1);
  check("coerceModuleSkeleton rejects an empty lesson list", !coerceModuleSkeleton({ moduleTitle: "M", lessons: [] }).skeleton);
  check("coerceModuleSkeleton tolerates a model that omits optional fields", !!coerceModuleSkeleton({ lessons: [{ title: "Just a title" }] }).skeleton);

  // lessonBriefToPlanRequest turns a brief into a rich-plan instruction.
  const req = lessonBriefToPlanRequest(coerceModuleSkeleton({ moduleTitle: "M", lessons: [brief] }).skeleton!.lessons[0], "Searching");
  check("lessonBriefToPlanRequest mentions the title, slide range + quiz", req.includes("Linear search") && /\d+–\d+ slides/.test(req) && /knowledge check/i.test(req), req);

  // ── Module FALLBACK coerce — ultra-lean → the same ModuleSkeleton shape.
  const fb = coerceModuleFallback({ moduleTitle: "M", moduleObjective: "o", lessons: [{ title: "A", objective: "x" }, { title: "B", objective: "y" }], estimatedLessonCount: 2 });
  check("coerceModuleFallback yields a usable skeleton with default slide ranges", fb.skeleton?.lessons.length === 2 && fb.skeleton.lessons[0].suggestedBlocks.includes("slide_deck") && fb.skeleton.lessons[0].minSlides >= 3);
  check("coerceModuleFallback rejects an empty lesson list", !coerceModuleFallback({ moduleTitle: "M", lessons: [] }).skeleton);

  // ── 3. The real-bug regression: text recovered from message items.
  const output = [
    { type: "reasoning", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"slides":[]}' }] },
  ];
  check("messageTextFromOutput recovers JSON when output_text is empty", messageTextFromOutput(output) === '{"slides":[]}');
  check("messageTextFromOutput returns '' for a reasoning-only output", messageTextFromOutput([{ type: "reasoning" }]) === "");

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
