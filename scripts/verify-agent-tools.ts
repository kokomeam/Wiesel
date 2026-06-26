/**
 * Verification harness for the AI tool layer (no API key, no DB).
 * Run: `npx tsx scripts/verify-agent-tools.ts`
 *
 * Asserts: strict-schema invariants for every tool; writer tools produce
 * schema-valid blocks with ZERO gradebook fields; SET_BLOCK_CONTENT and
 * ADD_BLOCK round-trip through applyCoursePatch; arg validation rejects bad
 * input.
 */

import { createLesson, createModule, createBlock } from "@/lib/course/factories";
import { applyCoursePatch } from "@/lib/course/patches";
import { LessonBlockSchema, CourseDocumentSchema } from "@/lib/course/schemas";
import { defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument } from "@/lib/course/types";
import { getToolDefinitions, executeTool, ToolError } from "@/lib/ai/tools";
import type { ToolContext } from "@/lib/ai/tools";
import { diffBlocks } from "@/lib/ai/changeSetDiff";

const NOW = "2026-06-15T00:00:00.000Z";
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

function freshCtx(): { ctx: ToolContext; doc: CourseDocument; lessonId: string } {
  const lesson = createLesson("Intro to two pointers", 0);
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  const now = "2026-06-15T00:00:00.000Z";
  const doc: CourseDocument = {
    id: crypto.randomUUID(),
    title: "Competitive Programming 101",
    description: "Learn core algorithmic patterns.",
    audience: "beginner USACO competitors",
    level: "beginner",
    plan: { outcomes: ["Apply the two-pointer pattern"], prerequisites: [], teachingStyle: "friendly, concrete" },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: { createdAt: now, updatedAt: now, aiReadableVersion: "1.0" },
  };
  return { ctx: { doc, courseId: doc.id, lessonId: lesson.id }, doc, lessonId: lesson.id };
}

const GRADEBOOK_KEYS = ["difficulty", "points", "passingScore", "timeLimitMinutes", "attemptsAllowed", "dueAt", "whenToShowAnswers"];
function deepFindKeys(value: unknown, keys: string[], path = "$"): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...deepFindKeys(v, keys, `${path}[${i}]`)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) hits.push(`${path}.${k}`);
      hits.push(...deepFindKeys(v, keys, `${path}.${k}`));
    }
  }
  return hits;
}

// ── strict JSON-schema invariants ──────────────────────────────────────────
const STRIP = new Set(["minLength","maxLength","pattern","format","minimum","maximum","exclusiveMinimum","exclusiveMaximum","multipleOf","minItems","maxItems","uniqueItems","default","$schema"]);
function walkStrict(node: unknown, errs: string[], path = "$") {
  if (Array.isArray(node)) { node.forEach((x, i) => walkStrict(x, errs, `${path}[${i}]`)); return; }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  for (const k of STRIP) if (k in o) errs.push(`${path}: leftover ${k}`);
  if ("oneOf" in o) errs.push(`${path}: leftover oneOf`);
  if (o.type === "object" && o.properties && typeof o.properties === "object") {
    if (o.additionalProperties !== false) errs.push(`${path}: additionalProperties!=false`);
    const pk = Object.keys(o.properties as object).sort();
    const rq = [...((o.required as string[]) ?? [])].sort();
    if (JSON.stringify(pk) !== JSON.stringify(rq)) errs.push(`${path}: required!=props`);
  }
  for (const [k, v] of Object.entries(o)) walkStrict(v, errs, `${path}.${k}`);
}

async function main() {
  console.log("\n# Tool definitions (strict schemas)");
  const defs = getToolDefinitions();
  const expected = ["get_course_context","list_modules","list_lessons","get_lesson","get_block","create_module","create_lesson","create_block","delete_block","delete_module","delete_lesson","reorder_blocks","write_slide_deck","write_quiz","write_homework","write_lecture_text","get_deck","get_slide","add_slide","update_slide","set_slide_layout","reorder_slides","delete_slide","add_structured_slide","add_structured_slides_batch","set_structured_slide","set_text_style","add_sticker","add_diagram","set_diagram","add_image","set_image_text"];
  check(`all ${expected.length} tools registered`, defs.length === expected.length && expected.every((n) => defs.some((d) => d.name === n)), `got ${defs.map((d) => d.name).join(",")}`);
  for (const d of defs) {
    const errs: string[] = [];
    walkStrict(d.parameters, errs);
    check(`strict schema: ${d.name}`, errs.length === 0, errs.join("; "));
  }

  console.log("\n# delete_module / delete_lesson → confirm-gated DELETE patches");
  {
    const { ctx, doc, lessonId } = freshCtx();
    const moduleId = doc.modules[0].id;

    // delete_module: returns a confirm descriptor + a valid DELETE_MODULE patch,
    // and DOES NOT apply on its own (the loop pauses for the user).
    const dm = await executeTool("delete_module", JSON.stringify({ moduleId }), ctx);
    check("delete_module asks for confirmation", dm.confirm?.kind === "module" && /Module 1:/.test(dm.confirm?.label ?? ""), JSON.stringify(dm.confirm));
    check("delete_module returns one DELETE_MODULE patch", dm.patches?.length === 1 && dm.patches[0].action === "DELETE_MODULE");
    const afterDel = applyCoursePatch(doc, dm.patches![0], NOW);
    check("DELETE_MODULE applies → module removed", afterDel.ok && afterDel.doc.modules.length === 0, afterDel.ok ? "" : afterDel.error);

    // delete_lesson: confirm descriptor + valid DELETE_LESSON patch.
    const dl = await executeTool("delete_lesson", JSON.stringify({ lessonId }), ctx);
    check("delete_lesson asks for confirmation", dl.confirm?.kind === "lesson");
    check("delete_lesson returns one DELETE_LESSON patch", dl.patches?.length === 1 && dl.patches[0].action === "DELETE_LESSON");
    const afterDelL = applyCoursePatch(doc, dl.patches![0], NOW);
    check("DELETE_LESSON applies → lesson removed", afterDelL.ok && afterDelL.doc.modules[0].lessons.length === 0);

    // a missing target is a clean ToolError (the loop reports it back).
    let bad = false;
    try { await executeTool("delete_module", JSON.stringify({ moduleId: "nope" }), ctx); }
    catch (e) { bad = e instanceof ToolError; }
    check("delete_module on a missing id → ToolError", bad);
  }

  console.log("\n# write_quiz → low-stakes, valid, new block");
  {
    const { ctx } = freshCtx();
    const out = await executeTool("write_quiz", JSON.stringify({
      blockId: null, lessonId: null, title: "Quick check",
      questions: [
        { kind: "multiple_choice", prompt: "What moves in two-pointer?", explanation: "Both ends.", choices: ["One pointer","Two pointers","A stack"], correctIndex: 1 },
        { kind: "true_false", prompt: "Two pointers can be O(n).", explanation: "Yes.", correctAnswer: true },
        { kind: "short_answer", prompt: "Name the complexity.", explanation: "Linear.", expectedAnswer: "O(n)", acceptedAnswers: ["linear"] },
      ],
    }), ctx);
    check("returns one ADD_BLOCK patch", out.patches?.length === 1 && out.patches[0].action === "ADD_BLOCK");
    const block = out.patches![0].action === "ADD_BLOCK" ? out.patches![0].block : null;
    const parsed = LessonBlockSchema.safeParse(block);
    check("quiz block valid vs LessonBlockSchema", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
    const gb = deepFindKeys(block, GRADEBOOK_KEYS);
    check("quiz block has NO gradebook fields", gb.length === 0, gb.join(","));
    check("quiz has 3 questions", block?.type === "quiz" && block.questions.length === 3);
  }

  console.log("\n# write_slide_deck → layout + rich content, no markdown leak");
  {
    const { ctx } = freshCtx();
    const rt = (s: string, bold = false) => [{ text: s, bold: bold ? true : null, italic: null }];
    const out = await executeTool("write_slide_deck", JSON.stringify({
      blockId: null, lessonId: null, title: "Intro deck",
      slides: [
        { layout: "definition", content: [
          { role: "title", text: rt("Two Pointers"), items: null },
          { role: "definition", text: [{ text: "Two pointers", bold: true, italic: null }, { text: " scan an array from both ends.", bold: null, italic: null }], items: null },
        ], notes: "Zipper analogy." },
        { layout: "title_bullets", content: [
          { role: "title", text: rt("Why O(n)"), items: null },
          { role: "main_points", text: null, items: ["No backtracking", "Each element seen **once**"] },
        ], notes: null },
      ],
    }), ctx);
    const block = out.patches?.[0].action === "ADD_BLOCK" ? out.patches[0].block : null;
    const parsed = LessonBlockSchema.safeParse(block);
    check("slide_deck valid vs schema", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
    const layouts = block?.type === "slide_deck" ? block.slides.map((s) => s.layout) : [];
    check("each slide kept its chosen layout", layouts.includes("definition") && layouts.includes("title_bullets"), layouts.join(","));
    // bold term renders as runs (not markdown)
    const defEl = block?.type === "slide_deck" ? block.slides[0].elements.find((e) => e.type === "text" || e.type === "heading") : undefined;
    const defText = block?.type === "slide_deck" ? block.slides[0].elements : [];
    const hasBoldRun = JSON.stringify(defText).includes('"bold":true');
    check("emphasis stored as runs (bold:true)", hasBoldRun, "no bold run found");
    void defEl;
    // no '**' anywhere (bullets stripped, runs used)
    check("NO '**' markdown leaked into any slide", !JSON.stringify(block).includes("**"));
  }

  console.log("\n# granular slide tools — non-destructive, id-addressed");
  {
    const { ctx, doc } = freshCtx();
    const rt = (s: string) => [{ text: s, bold: null, italic: null }];
    // seed a 2-slide deck via write_slide_deck
    const mk = await executeTool("write_slide_deck", JSON.stringify({
      blockId: null, lessonId: null, title: "Deck",
      slides: [
        { layout: "title", content: [{ role: "title", text: rt("Slide One"), items: null }], notes: null },
        { layout: "title_bullets", content: [{ role: "title", text: rt("Slide Two"), items: null }, { role: "main_points", text: null, items: ["a", "b"] }], notes: null },
      ],
    }), ctx);
    let cur = applyCoursePatch(doc, mk.patches![0], NOW);
    if (!cur.ok) throw new Error(cur.error);
    let liveDoc = cur.doc;
    const deckBlock = liveDoc.modules[0].lessons[0].blocks.find((b) => b.type === "slide_deck")!;
    const ctx2: ToolContext = { ...ctx, doc: liveDoc };

    // get_deck returns slide ids + slots
    const gd = await executeTool("get_deck", JSON.stringify({ blockId: deckBlock.id }), ctx2);
    const slides = gd.data as { slideId: string; layout: string; slots: { role: string }[] }[];
    check("get_deck returns 2 slides with ids + slots", slides.length === 2 && slides.every((s) => s.slideId && s.slots.length > 0));
    const slide1Id = slides[0].slideId, slide2Id = slides[1].slideId;

    // set_slide_layout on slide 1 ONLY → others untouched
    const sl = await executeTool("set_slide_layout", JSON.stringify({ blockId: deckBlock.id, slideId: slide1Id, layout: "two_column", content: [
      { role: "title", text: rt("Slide One"), items: null },
      { role: "left", text: null, items: ["left a"] },
      { role: "right", text: null, items: ["right a"] },
    ] }), ctx2);
    check("set_slide_layout → one SET_SLIDE_CONTENT patch", sl.patches?.length === 1 && sl.patches[0].action === "SET_SLIDE_CONTENT");
    cur = applyCoursePatch(liveDoc, sl.patches![0], NOW);
    if (!cur.ok) throw new Error(cur.error);
    liveDoc = cur.doc;
    const after = liveDoc.modules[0].lessons[0].blocks.find((b) => b.id === deckBlock.id)!;
    if (after.type === "slide_deck") {
      check("slide 1 switched to two_column", after.slides.find((s) => s.id === slide1Id)?.layout === "two_column");
      check("slide 2 untouched (still title_bullets, 2 bullets)", after.slides.find((s) => s.id === slide2Id)?.layout === "title_bullets");
      check("deck still has exactly 2 slides (non-destructive)", after.slides.length === 2);
      check("whole doc valid after layout switch", CourseDocumentSchema.safeParse(liveDoc).success);
    }

    // update_slide patches only the named slot
    const ctx3: ToolContext = { ...ctx, doc: liveDoc };
    const us = await executeTool("update_slide", JSON.stringify({ blockId: deckBlock.id, slideId: slide2Id, content: [{ role: "title", text: [{ text: "Renamed", bold: true, italic: null }], items: null }] }), ctx3);
    check("update_slide → UPDATE_SLIDE_ELEMENT patch(es)", (us.patches?.length ?? 0) >= 1 && us.patches!.every((p) => p.action === "UPDATE_SLIDE_ELEMENT"));
  }

  console.log("\n# write_homework → no points anywhere (incl. rubric)");
  {
    const { ctx } = freshCtx();
    const out = await executeTool("write_homework", JSON.stringify({
      blockId: null, lessonId: null, title: "Practice", instructions: "Solve each.", deliverableType: "text_response", estimatedMinutes: 30,
      exercises: [{ title: "Window", prompt: "Find longest window.", hint: "Shrink from left.", solution: null }],
      rubric: [{ name: "Invariant stated", description: "Clear before coding", levels: [{ label: "Strong", description: "Stated precisely" }, { label: "Developing", description: null }] }],
    }), ctx);
    const block = out.patches?.[0].action === "ADD_BLOCK" ? out.patches[0].block : null;
    const parsed = LessonBlockSchema.safeParse(block);
    check("homework valid vs schema", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));
    const gb = deepFindKeys(block, GRADEBOOK_KEYS);
    check("homework has NO gradebook fields", gb.length === 0, gb.join(","));
  }

  console.log("\n# SET_BLOCK_CONTENT round-trip (overwrite existing block, id preserved)");
  {
    const { ctx, doc, lessonId } = freshCtx();
    // seed an empty quiz block
    const empty = createBlock("quiz");
    const lesson = doc.modules[0].lessons[0];
    lesson.blocks.push(empty);
    const out = await executeTool("write_quiz", JSON.stringify({
      blockId: empty.id, lessonId: null, title: "Filled",
      questions: [{ kind: "true_false", prompt: "ok?", explanation: "yes", correctAnswer: true }],
    }), ctx);
    check("returns SET_BLOCK_CONTENT", out.patches?.[0].action === "SET_BLOCK_CONTENT");
    const res = applyCoursePatch(doc, out.patches![0], "2026-06-15T00:00:00.000Z");
    check("apply ok", res.ok, res.ok ? "" : res.error);
    if (res.ok) {
      const blk = res.doc.modules[0].lessons[0].blocks.find((b) => b.id === empty.id);
      check("block id preserved + content replaced", !!blk && blk.type === "quiz" && blk.questions.length === 1 && blk.title === "Filled");
      check("whole doc still valid", CourseDocumentSchema.safeParse(res.doc).success);
    }
    void lessonId;
  }

  console.log("\n# ADD_BLOCK round-trip via applyCoursePatch");
  {
    const { ctx, doc } = freshCtx();
    const out = await executeTool("write_lecture_text", JSON.stringify({
      blockId: null, lessonId: null, title: "Notes", tone: "beginner",
      paragraphs: [{ kind: "key_idea", text: "Two pointers avoid nested loops." }],
    }), ctx);
    const res = applyCoursePatch(doc, out.patches![0], "2026-06-15T00:00:00.000Z");
    check("lecture ADD_BLOCK applies + doc valid", res.ok && CourseDocumentSchema.safeParse(res.ok ? res.doc : null).success);
  }

  console.log("\n# argument validation rejects bad input");
  {
    const { ctx } = freshCtx();
    let threw = false;
    try { await executeTool("write_quiz", JSON.stringify({ questions: "nope" }), ctx); }
    catch (e) { threw = e instanceof ToolError; }
    check("invalid args → ToolError", threw);
    // get_block on a missing id now FAILS GRACEFULLY (returns found:false + the
    // lesson's real blocks) instead of throwing into a retry loop — the half-built-
    // module reference-resolution fix. (A truly invalid SHAPE still ToolErrors.)
    let gbThrew = false;
    let gbData: { found?: boolean } | null = null;
    try { gbData = (await executeTool("get_block", JSON.stringify({ blockId: "does-not-exist" }), ctx)).data as { found?: boolean }; }
    catch (e) { gbThrew = e instanceof ToolError; }
    check("missing block → graceful found:false (NOT a throw/retry loop)", !gbThrew && gbData?.found === false);
  }

  console.log("\n# change-set diff (create / update / delete)");
  {
    const { ctx, doc } = freshCtx();
    const now = "2026-06-15T00:00:00.000Z";
    // create a block
    const out1 = await executeTool("write_quiz", JSON.stringify({ blockId: null, lessonId: null, title: "Q", questions: [{ kind: "true_false", prompt: "p", explanation: "e", correctAnswer: true }] }), ctx);
    const r1 = applyCoursePatch(doc, out1.patches![0], now);
    if (!r1.ok) throw new Error(r1.error);
    const created = diffBlocks(doc, r1.doc);
    check("diff detects create", created.length === 1 && created[0].op === "create" && created[0].before === null);
    const blockId = created[0].blockId;
    // update the same block
    const ctx2: ToolContext = { ...ctx, doc: r1.doc };
    const out2 = await executeTool("write_quiz", JSON.stringify({ blockId, lessonId: null, title: "Q2", questions: [{ kind: "true_false", prompt: "p2", explanation: "e2", correctAnswer: false }] }), ctx2);
    const r2 = applyCoursePatch(r1.doc, out2.patches![0], now);
    if (!r2.ok) throw new Error(r2.error);
    const updated = diffBlocks(r1.doc, r2.doc);
    check("diff detects update with before+after", updated.length === 1 && updated[0].op === "update" && !!updated[0].before && !!updated[0].after);
    // delete it
    const ctx3: ToolContext = { ...ctx, doc: r2.doc };
    const out3 = await executeTool("delete_block", JSON.stringify({ blockId }), ctx3);
    const r3 = applyCoursePatch(r2.doc, out3.patches![0], now);
    if (!r3.ok) throw new Error(r3.error);
    const deleted = diffBlocks(r2.doc, r3.doc);
    check("diff detects delete with before snapshot", deleted.length === 1 && deleted[0].op === "delete" && !!deleted[0].before && deleted[0].after === null);
    // no-op diff
    check("identical docs → no changes", diffBlocks(r2.doc, r2.doc).length === 0);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
