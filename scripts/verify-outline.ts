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
  const many = coerceOutline({ objective: "o", segments: [], slides: Array.from({ length: 20 }, () => slide) });
  check(`coerceOutline clamps to ${MAX_LESSON_SLIDES} slides`, many.outline?.slides.length === MAX_LESSON_SLIDES);
  check("coerceOutline rejects 0 slides", !coerceOutline({ objective: "o", segments: [], slides: [] }).outline);
  check("coerceOutline rejects a bad layout enum", !coerceOutline({ objective: "o", segments: [], slides: [{ ...slide, layout: "title_bullets" }] }).outline);

  // ── Module SKELETON coerce — the compact lesson MAP (NO per-slide arrays).
  const brief = { title: "Linear search", objective: "Scan an array in order.", rationale: "starts the unit", skillsIntroduced: ["scanning"], minSlides: 2, maxSlides: 99, suggestedBlocks: ["quiz"], recommendQuiz: true };
  const sk = coerceModuleSkeleton({ moduleTitle: "Searching", moduleObjective: "find things", lessons: Array.from({ length: 12 }, () => brief) });
  check(`coerceModuleSkeleton clamps to ${MAX_MODULE_LESSONS} lessons`, sk.skeleton?.lessons.length === MAX_MODULE_LESSONS, `${sk.skeleton?.lessons.length}`);
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
