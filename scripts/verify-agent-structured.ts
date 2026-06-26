/**
 * Agent-facing checks for the new vocabulary (Task 5) — pure, no key/DB.
 * Run: `npx tsx scripts/verify-agent-structured.ts`
 *
 * The model only ever reaches the doc through these tools. This proves: the
 * strict JSON schemas generate (union + length limits), the new tools are
 * registered, valid calls produce applic­able patches, and — critically — an
 * over-long slot is now CLAMPED + SAVED (never rejected for fit), while a slide
 * MISSING required content still comes back.
 */

import { applyCoursePatch } from "@/lib/course/patches";
import { getToolDefinitions, executeTool, ToolError } from "@/lib/ai/tools";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { LIMITS, STRUCTURED_LAYOUT_IDS, findStructuredLayout } from "@/lib/course/slide/structuredLayouts";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n} ${d}`);
  }
};

const NOW = "2026-06-16T00:00:00.000Z";

function ctxDoc() {
  const deck = createBlock("slide_deck", 0) as SlideDeckBlock;
  const lesson = createLesson("L", 0);
  lesson.blocks = [deck];
  const mod = createModule("M", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: "c",
    title: "t",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: { slideDefaults: { themeId: "editorial-warm" } } as never,
    metadata: { createdAt: NOW, updatedAt: NOW, aiReadableVersion: "1.0" },
  };
  return { doc, deck, lessonId: lesson.id };
}

async function run(name: string, args: unknown, ctx: { doc: CourseDocument; courseId: string; lessonId: string }) {
  const outcome = await executeTool(name, JSON.stringify(args), ctx);
  let mutated = false;
  for (const p of outcome.patches ?? []) {
    const res = applyCoursePatch(ctx.doc, p, NOW);
    if (res.ok) {
      ctx.doc = res.doc;
      mutated = true;
    }
  }
  return { outcome, mutated };
}

async function main() {
  // ── Schema generation (would throw on an unrepresentable union/refine).
  const defs = getToolDefinitions();
  const names = new Set(defs.map((d) => d.name));
  for (const t of ["add_structured_slide", "set_structured_slide", "set_text_style", "add_sticker"]) {
    check(`tool '${t}' is registered`, names.has(t));
  }
  const structJson = JSON.stringify(defs.find((d) => d.name === "add_structured_slide")!.parameters);
  // The image layouts (`illustration` legacy + `image_reference` / `image_supporting`)
  // are authored by the add_image tool (it generates + stores the image), NOT
  // hand-authored, so they're intentionally absent from this union.
  const imageOnly = new Set(["illustration", "image_reference", "image_supporting"]);
  const authorable = STRUCTURED_LAYOUT_IDS.filter((id) => !imageOnly.has(id));
  const missingLayout = authorable.filter((id) => !structJson.includes(id));
  check(
    `structured schema is a union over all ${authorable.length} hand-authored layout ids`,
    structJson.includes("anyOf") && missingLayout.length === 0,
    missingLayout.join(", ")
  );
  for (const id of imageOnly) {
    check(`${id} is NOT hand-authorable (add_image-only)`, !structJson.includes(`"${id}"`));
  }
  check("add_image tool is registered", names.has("add_image"));
  check("set_image_text tool is registered", names.has("set_image_text"));

  const base = ctxDoc();
  const ctx = { doc: base.doc, courseId: "c", lessonId: base.lessonId };
  const blockId = base.deck.id;

  // ── add_structured_slide (valid) → applies.
  const add = await run("add_structured_slide", { blockId, position: null, template: findStructuredLayout("process_steps")!.seed(), notes: null }, ctx);
  check("add_structured_slide applies", add.mutated, add.outcome.summary);
  const decks = () => ctx.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
  const structured = decks().slides.find((s) => s.template?.layoutId === "process_steps");
  check("a structured slide now exists", !!structured);

  // ── set_structured_slide converts the original (flat) slide.
  const flatSlideId = decks().slides[0].id;
  const conv = await run("set_structured_slide", { blockId, slideId: flatSlideId, template: findStructuredLayout("key_concept")!.seed() }, ctx);
  check("set_structured_slide converts a slide", conv.mutated && decks().slides.find((s) => s.id === flatSlideId)?.template?.layoutId === "key_concept");

  // ── REGRESSION (2026-06-16): the model emits rich-text runs whose marks
  // carry `color: null` (and null bold/italic/underline). Strict tool schemas
  // present every optional key as nullable, so this is the EXACT shape the
  // model sends — it must be ACCEPTED (not trip the validate→repair guard with
  // a raw error) and stored CLEAN (nulls normalized away, no `:null` marks).
  const nullMarkTpl = JSON.parse(JSON.stringify(findStructuredLayout("process_steps")!.seed()));
  nullMarkTpl.content.title.runs = [
    { text: nullMarkTpl.content.title.text, marks: { bold: true, italic: null, underline: null, color: null } },
  ];
  nullMarkTpl.content.steps[0].heading.runs = [
    { text: nullMarkTpl.content.steps[0].heading.text, marks: { bold: null, italic: null, underline: null, color: null } },
  ];
  let nullMarksAccepted = true;
  let nullMarksErr = "";
  try {
    const r = await run("set_structured_slide", { blockId, slideId: flatSlideId, template: nullMarkTpl }, ctx);
    nullMarksAccepted = r.mutated;
  } catch (e) {
    nullMarksAccepted = false;
    nullMarksErr = e instanceof Error ? e.message : String(e);
  }
  check("set_structured_slide accepts runs with null marks (color: null)", nullMarksAccepted, nullMarksErr.slice(0, 140));
  const storedTpl = decks().slides.find((s) => s.id === flatSlideId)?.template;
  const titleMarks =
    (storedTpl?.content as { title?: { runs?: { marks?: Record<string, unknown> }[] } } | undefined)?.title
      ?.runs?.[0]?.marks ?? {};
  check(
    "null marks normalized away (color/italic dropped, bold preserved)",
    titleMarks.color === undefined && titleMarks.italic === undefined && titleMarks.bold === true,
    JSON.stringify(titleMarks)
  );
  check(
    "stored template carries no literal null mark (clean data)",
    !JSON.stringify(storedTpl ?? {}).includes(":null"),
    JSON.stringify(storedTpl?.content)?.slice(0, 120)
  );

  // ── A deck that opens with a section break, teaches a concept with a worked
  //    example, and ends with objectives: the model picks the three new layouts,
  //    each fills slots within limits, and they all apply.
  for (const id of ["section_break", "concept_example", "outline_list"] as const) {
    const res = await run("add_structured_slide", { blockId, position: null, template: findStructuredLayout(id)!.seed(), notes: null }, ctx);
    check(`add_structured_slide applies a ${id} slide`, res.mutated, res.outcome.summary);
    check(`a ${id} slide now exists in the deck`, decks().slides.some((s) => s.template?.layoutId === id));
  }

  // ── STRETCHING: an over-long outline item is CLAMPED + SAVED (never rejected for
  //    fit — the card grows / the text auto-shortens; the model is never bounced).
  const outlineOverflow = JSON.parse(JSON.stringify(findStructuredLayout("outline_list")!.seed()));
  outlineOverflow.content.items[0].text.text = "x".repeat(120); // olItem cap = 80
  const olOut = await executeTool("add_structured_slide", JSON.stringify({ blockId, position: null, template: outlineOverflow, notes: null }), ctx);
  const olPatch = (olOut.patches ?? []).find((p) => p.action === "ADD_SLIDE");
  const olSlide = olPatch && olPatch.action === "ADD_SLIDE" ? olPatch.slide : null;
  const olItem0 = olSlide?.template?.layoutId === "outline_list" ? olSlide.template.content.items[0].text.text : "";
  check("over-long outline item is auto-shortened + SAVED (not rejected)", !!olPatch && olItem0.length > 0 && olItem0.length <= LIMITS.olItem && olItem0.length < 120, `${olItem0.length}`);

  // ── A malformed concept_example body kind is rejected by the discriminated union.
  const badBody = JSON.parse(JSON.stringify(findStructuredLayout("concept_example")!.seed()));
  badBody.content.example.body = { kind: "bogus", steps: [] };
  let badBodyRejected = false;
  try {
    await executeTool("add_structured_slide", JSON.stringify({ blockId, position: null, template: badBody, notes: null }), ctx);
  } catch (e) {
    badBodyRejected = e instanceof ToolError;
  }
  check("invalid concept_example body kind is rejected", badBodyRejected);

  // ── STRETCHING: an over-long title is CLAMPED + SAVED (no fit rejection).
  const overflow = JSON.parse(JSON.stringify(findStructuredLayout("metrics_overview")!.seed()));
  overflow.content.title.text = "x".repeat(80); // title cap = 48
  const mOut = await executeTool("add_structured_slide", JSON.stringify({ blockId, position: null, template: overflow, notes: null }), ctx);
  const mPatch = (mOut.patches ?? []).find((p) => p.action === "ADD_SLIDE");
  const mSlide = mPatch && mPatch.action === "ADD_SLIDE" ? mPatch.slide : null;
  const mTitle = mSlide?.template?.layoutId === "metrics_overview" ? mSlide.template.content.title.text : "";
  check("over-long title is auto-shortened + SAVED (not rejected)", !!mPatch && mTitle.length > 0 && mTitle.length <= LIMITS.title && mTitle.length < 80, `${mTitle.length}`);

  // ── A slide MISSING required content (an empty body, not a length issue) DOES
  //    still come back — clamp can't invent content. add_structured_slide throws.
  const noBody = JSON.parse(JSON.stringify(findStructuredLayout("prose")!.seed()));
  noBody.content.body.text = "";
  let missingContentRejected = false;
  try {
    await executeTool("add_structured_slide", JSON.stringify({ blockId, position: null, template: noBody, notes: null }), ctx);
  } catch (e) {
    missingContentRejected = e instanceof ToolError;
  }
  check("a content-MISSING slide still comes back (not a fit reject)", missingContentRejected);

  // ── add_sticker onto a freeform slide.
  const flat = await run("add_structured_slide", { blockId, position: null, template: findStructuredLayout("metrics_overview")!.seed(), notes: null }, ctx);
  void flat;
  // Use the still-freeform-or-structured? add_sticker targets any slide's elements.
  const anySlide = decks().slides[0].id;
  const sticker = await run("add_sticker", { blockId, slideId: anySlide, stickerId: "target", x: 100, y: 100 }, ctx);
  check("add_sticker applies", sticker.mutated, sticker.outcome.summary);

  // ── add_sticker with a bogus id is rejected by the enum.
  let badSticker = false;
  try {
    await executeTool("add_sticker", JSON.stringify({ blockId, slideId: anySlide, stickerId: "definitely-not-real", x: null, y: null }), ctx);
  } catch {
    badSticker = true;
  }
  check("unknown sticker id is rejected", badSticker);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
