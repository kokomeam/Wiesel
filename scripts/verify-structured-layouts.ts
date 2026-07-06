/**
 * Structured (renderer-owned) layout checks (Task 3) — pure, no key/DB.
 * Run: `npx tsx scripts/verify-structured-layouts.ts`
 *
 * Proves the fill contract: every layout's STRICT schema accepts its seed AND
 * near-max content (every slot at its limit + max item count — the overflow
 * guard the browser test then visually confirms), and REJECTS over-long text
 * and bad counts with readable errors. Then the SAME patch pipeline can set a
 * template, edit it by path, and clear it.
 */

import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import {
  setSlideTemplatePatch,
  updateTemplateContentPatch,
} from "@/lib/course/commands";
import { createBlock, createLesson, createModule, createStructuredSlide } from "@/lib/course/factories";
import { SlideSchema } from "@/lib/course/schemas";
import {
  LIMITS,
  STRUCTURED_LAYOUTS,
  findStructuredLayout,
  validateStructuredContent,
} from "@/lib/course/slide/structuredLayouts";
import type {
  ComparisonColumnsContent,
  ComparisonMatrixContent,
  ConceptExampleContent,
  CourseDocument,
  OutlineListContent,
  ProcessContent,
  RichText,
  SectionBreakContent,
  SlideDeckBlock,
} from "@/lib/course/types";

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
const r = (n: number): RichText => ({ text: "a".repeat(n) });

function deckDoc(): { doc: CourseDocument; deck: SlideDeckBlock } {
  const deck = createBlock("slide_deck", 0) as SlideDeckBlock;
  const lesson = createLesson("L", 0);
  lesson.blocks = [deck];
  const mod = createModule("M", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: "c",
    title: "Structured test",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: { id: "editorial-warm", name: "Editorial Warm", accentColor: "#ea580c" } as never,
    metadata: { createdAt: NOW, updatedAt: NOW, ownerId: "o", aiReadableVersion: "1.0" },
  };
  return { doc, deck };
}

function main() {
  check("there are 14 structured layouts", STRUCTURED_LAYOUTS.length === 14, `${STRUCTURED_LAYOUTS.length}`);

  // ── 1. Every layout's seed passes its OWN strict schema.
  for (const l of STRUCTURED_LAYOUTS) {
    const errs = validateStructuredContent(l.id, l.seed().content);
    check(`${l.id}: seed passes strict validation`, errs.length === 0, errs.join(" | "));
  }

  // ── 2. Near-max content (every slot at its limit, MAX items) is accepted —
  //       proves the schema limits are internally coherent (the overflow guard).
  const nearMaxProcess: ProcessContent = {
    eyebrow: r(LIMITS.eyebrow),
    title: r(LIMITS.title),
    subtitle: r(LIMITS.subtitle),
    steps: Array.from({ length: 5 }, () => ({
      sticker: "gear",
      heading: r(LIMITS.heading),
      body: r(LIMITS.body),
    })),
  };
  check("process_steps: near-max content (5 steps, all slots full) is valid",
    validateStructuredContent("process_steps", nearMaxProcess).length === 0);

  // ── 3. Over-long text is REJECTED with a readable error.
  const tooLong: ProcessContent = { ...nearMaxProcess, title: r(LIMITS.title + 1) };
  const titleErrs = validateStructuredContent("process_steps", tooLong);
  check("process_steps: title 1 over the limit is rejected", titleErrs.length > 0);
  check("rejection error is readable (mentions characters)", titleErrs.some((e) => /character/i.test(e)), titleErrs.join(" | "));

  // ── 4. Bad item counts are rejected.
  const tooFew = { ...nearMaxProcess, steps: nearMaxProcess.steps.slice(0, 2) };
  check("process_steps: 2 steps (min 3) is rejected", validateStructuredContent("process_steps", tooFew).length > 0);
  const tooMany = { ...nearMaxProcess, steps: [...nearMaxProcess.steps, { sticker: "x", heading: r(5), body: r(5) }] };
  check("process_steps: 6 steps (max 5) is rejected", validateStructuredContent("process_steps", tooMany).length > 0);

  // ── 5. Code line-count cap.
  const codeSeed = findStructuredLayout("code_walkthrough_steps")!.seed();
  const longCode = structuredClone(codeSeed);
  if (longCode.layoutId === "code_walkthrough_steps") {
    longCode.content.code.code = Array.from({ length: LIMITS.codeLines + 1 }, () => "x = 1").join("\n");
  }
  check("code_walkthrough: > 20 lines of code is rejected",
    validateStructuredContent("code_walkthrough_steps", longCode.content).length > 0);

  // ── 6. Unknown layout id.
  check("unknown layout id is rejected", validateStructuredContent("nope", {}).length > 0);

  // ── 6a. section_break — near-max (every slot full, both variant/title styles
  //        are enum values both schemas accept) + over-length rejections.
  const nearMaxSection: SectionBreakContent = {
    number: "a".repeat(LIMITS.sbNumber),
    label: r(LIMITS.sbLabel),
    title: r(LIMITS.sbTitle),
    subtitle: r(LIMITS.sbSubtitle),
    titleStyle: "serif",
    variant: "hero_numeral",
  };
  check("section_break: near-max content is valid", validateStructuredContent("section_break", nearMaxSection).length === 0,
    validateStructuredContent("section_break", nearMaxSection).join(" | "));
  check("section_break: over-long title rejected", validateStructuredContent("section_break", { ...nearMaxSection, title: r(LIMITS.sbTitle + 1) }).length > 0);
  check("section_break: over-long number rejected", validateStructuredContent("section_break", { ...nearMaxSection, number: "a".repeat(LIMITS.sbNumber + 1) }).length > 0);

  // ── 6b. concept_example — near-max for BOTH body kinds + count/length/kind rejections.
  const nearMaxSteps: ConceptExampleContent = {
    concept: { badge: "a".repeat(LIMITS.ceBadge), title: r(LIMITS.ceTitle), titleStyle: "sans", definition: r(LIMITS.ceDefinition) },
    example: {
      badge: "a".repeat(LIMITS.ceExampleBadge),
      title: r(LIMITS.ceExampleTitle),
      body: { kind: "steps", steps: Array.from({ length: 4 }, () => ({ heading: r(LIMITS.ceStepHeading), body: r(LIMITS.ceStepBody) })) },
    },
    footnote: r(LIMITS.ceFootnote),
  };
  check("concept_example: near-max (4 steps, footnote, all slots) is valid", validateStructuredContent("concept_example", nearMaxSteps).length === 0,
    validateStructuredContent("concept_example", nearMaxSteps).join(" | "));
  const nearMaxParas: ConceptExampleContent = {
    ...nearMaxSteps,
    example: { ...nearMaxSteps.example, body: { kind: "paragraphs", paragraphs: Array.from({ length: 3 }, () => r(LIMITS.ceParagraph)) } },
  };
  check("concept_example: near-max (3 paragraphs) is valid", validateStructuredContent("concept_example", nearMaxParas).length === 0,
    validateStructuredContent("concept_example", nearMaxParas).join(" | "));
  check("concept_example: over-long definition rejected", validateStructuredContent("concept_example", { ...nearMaxSteps, concept: { ...nearMaxSteps.concept, definition: r(LIMITS.ceDefinition + 1) } }).length > 0);
  check("concept_example: 5 steps (max 4) rejected", validateStructuredContent("concept_example", {
    ...nearMaxSteps,
    example: { ...nearMaxSteps.example, body: { kind: "steps", steps: Array.from({ length: 5 }, () => ({ heading: r(5), body: r(5) })) } },
  }).length > 0);
  check("concept_example: 1 step (min 2) rejected", validateStructuredContent("concept_example", {
    ...nearMaxSteps,
    example: { ...nearMaxSteps.example, body: { kind: "steps", steps: [{ heading: r(5), body: r(5) }] } },
  }).length > 0);
  check("concept_example: 4 paragraphs (max 3) rejected", validateStructuredContent("concept_example", {
    ...nearMaxParas,
    example: { ...nearMaxParas.example, body: { kind: "paragraphs", paragraphs: Array.from({ length: 4 }, () => r(5)) } },
  }).length > 0);
  check("concept_example: bad body kind rejected", validateStructuredContent("concept_example", {
    ...nearMaxSteps,
    example: { ...nearMaxSteps.example, body: { kind: "bogus", steps: [] } },
  }).length > 0);

  // ── 6c. outline_list — near-max (5 items × 2 sub-items, all full) + rejections.
  const nearMaxOutline: OutlineListContent = {
    title: r(LIMITS.olTitle),
    items: Array.from({ length: 5 }, () => ({ text: r(LIMITS.olItem), subItems: [r(LIMITS.olSubItem), r(LIMITS.olSubItem)] })),
  };
  check("outline_list: near-max (5 items × 2 sub-items) is valid", validateStructuredContent("outline_list", nearMaxOutline).length === 0,
    validateStructuredContent("outline_list", nearMaxOutline).join(" | "));
  check("outline_list: items with NO sub-items is valid (per-item optional)", validateStructuredContent("outline_list", {
    title: r(20),
    items: [{ text: r(20) }, { text: r(20), subItems: [r(20)] }],
  }).length === 0);
  check("outline_list: 6 items (max 5) rejected", validateStructuredContent("outline_list", { ...nearMaxOutline, items: [...nearMaxOutline.items, { text: r(5) }] }).length > 0);
  check("outline_list: 1 item (min 2) rejected", validateStructuredContent("outline_list", { ...nearMaxOutline, items: [{ text: r(5) }] }).length > 0);
  check("outline_list: 3 sub-items (max 2) rejected", validateStructuredContent("outline_list", {
    ...nearMaxOutline,
    items: [{ text: r(5), subItems: [r(5), r(5), r(5)] }, { text: r(5) }],
  }).length > 0);
  check("outline_list: over-long item rejected", validateStructuredContent("outline_list", {
    ...nearMaxOutline,
    items: [{ text: r(LIMITS.olItem + 1) }, { text: r(5) }],
  }).length > 0);

  // ── 6e. prose — near-max (substantive body) valid; over-length body rejected.
  check("prose: near-max (full body + 5 points) is valid", validateStructuredContent("prose", {
    eyebrow: r(LIMITS.proseEyebrow),
    title: r(LIMITS.proseTitle),
    body: r(LIMITS.proseBody),
    points: Array.from({ length: 5 }, () => r(LIMITS.prosePoint)),
  }).length === 0);
  check("prose: over-length body rejected", validateStructuredContent("prose", { title: r(10), body: r(LIMITS.proseBody + 1) }).length > 0);
  check("prose: 6 points (max 5) rejected", validateStructuredContent("prose", { title: r(10), body: r(40), points: Array.from({ length: 6 }, () => r(5)) }).length > 0);

  // ── 6f. comparison_columns — near-max (3 options × 4 points + summary footer)
  //         valid; over-length + count + footer rejections.
  const nearMaxColumns: ComparisonColumnsContent = {
    eyebrow: r(LIMITS.cmpEyebrow),
    title: r(LIMITS.cmpTitle),
    subtitle: r(LIMITS.cmpSubtitle),
    presentation: "bare",
    options: Array.from({ length: 3 }, () => ({
      name: r(LIMITS.cmpOptionName),
      icon: "lightbulb",
      points: Array.from({ length: 4 }, () => ({ label: r(LIMITS.cmpPointLabel), detail: r(LIMITS.cmpPointDetail) })),
    })),
    footer: { kind: "summary", text: r(LIMITS.cmpSummary) },
  };
  check("comparison_columns: near-max (3 opts × 4 pts + summary) is valid", validateStructuredContent("comparison_columns", nearMaxColumns).length === 0,
    validateStructuredContent("comparison_columns", nearMaxColumns).join(" | "));
  check("comparison_columns: 2 options with a similarities footer is valid", validateStructuredContent("comparison_columns", {
    title: r(20),
    options: Array.from({ length: 2 }, () => ({ name: r(10), points: [{ label: r(10) }, { label: r(10) }] })),
    footer: { kind: "similarities", points: [r(10), r(10)] },
  }).length === 0);
  check("comparison_columns: 1 option (min 2) rejected", validateStructuredContent("comparison_columns", {
    title: r(20), options: [{ name: r(10), points: [{ label: r(10) }, { label: r(10) }] }],
  }).length > 0);
  check("comparison_columns: 4 options (max 3) rejected", validateStructuredContent("comparison_columns", {
    title: r(20), options: Array.from({ length: 4 }, () => ({ name: r(10), points: [{ label: r(10) }, { label: r(10) }] })),
  }).length > 0);
  check("comparison_columns: option with 1 point (min 2) rejected", validateStructuredContent("comparison_columns", {
    title: r(20), options: [{ name: r(10), points: [{ label: r(10) }] }, { name: r(10), points: [{ label: r(10) }, { label: r(10) }] }],
  }).length > 0);
  check("comparison_columns: over-long title rejected", validateStructuredContent("comparison_columns", { ...nearMaxColumns, title: r(LIMITS.cmpTitle + 1) }).length > 0);
  check("comparison_columns: summary footer over the limit rejected", validateStructuredContent("comparison_columns", {
    ...nearMaxColumns, footer: { kind: "summary", text: r(LIMITS.cmpSummary + 1) },
  }).length > 0);
  check("comparison_columns: 4 similarities (max 3) rejected", validateStructuredContent("comparison_columns", {
    ...nearMaxColumns, footer: { kind: "similarities", points: Array.from({ length: 4 }, () => r(10)) },
  }).length > 0);

  // ── 6g. comparison_matrix — near-max (3 options × 4 dimensions) valid; the
  //         cross-field "one cell per option" invariant + count rejections.
  const nearMaxMatrix: ComparisonMatrixContent = {
    eyebrow: r(LIMITS.cmpEyebrow),
    title: r(LIMITS.cmpTitle),
    subtitle: r(LIMITS.cmpSubtitle),
    options: Array.from({ length: 3 }, () => ({ name: r(LIMITS.cmpOptionName), icon: "gear" })),
    dimensions: Array.from({ length: 4 }, () => ({
      label: r(LIMITS.cmpDimLabel),
      icon: "target",
      cells: Array.from({ length: 3 }, () => ({ detail: r(LIMITS.cmpCellDetail), example: r(LIMITS.cmpCellExample) })),
    })),
    footer: { kind: "similarities", points: [r(LIMITS.cmpSimilarity), r(LIMITS.cmpSimilarity)] },
  };
  check("comparison_matrix: near-max (3 opts × 4 dims) is valid", validateStructuredContent("comparison_matrix", nearMaxMatrix).length === 0,
    validateStructuredContent("comparison_matrix", nearMaxMatrix).join(" | "));
  check("comparison_matrix: 2 options × 2 dims (cells match) is valid", validateStructuredContent("comparison_matrix", {
    title: r(20),
    options: Array.from({ length: 2 }, () => ({ name: r(10) })),
    dimensions: Array.from({ length: 2 }, () => ({ label: r(10), cells: Array.from({ length: 2 }, () => ({ detail: r(10) })) })),
  }).length === 0);
  check("comparison_matrix: cells count != options count rejected", validateStructuredContent("comparison_matrix", {
    title: r(20),
    options: Array.from({ length: 3 }, () => ({ name: r(10) })),
    dimensions: [{ label: r(10), cells: Array.from({ length: 2 }, () => ({ detail: r(10) })) }, { label: r(10), cells: Array.from({ length: 3 }, () => ({ detail: r(10) })) }],
  }).length > 0);
  check("comparison_matrix: 1 dimension (min 2) rejected", validateStructuredContent("comparison_matrix", {
    title: r(20),
    options: Array.from({ length: 2 }, () => ({ name: r(10) })),
    dimensions: [{ label: r(10), cells: Array.from({ length: 2 }, () => ({ detail: r(10) })) }],
  }).length > 0);
  check("comparison_matrix: 5 dimensions (max 4) rejected", validateStructuredContent("comparison_matrix", {
    ...nearMaxMatrix,
    dimensions: Array.from({ length: 5 }, () => ({ label: r(10), cells: Array.from({ length: 3 }, () => ({ detail: r(10) })) })),
  }).length > 0);
  check("comparison_matrix: over-long cell detail rejected", validateStructuredContent("comparison_matrix", {
    ...nearMaxMatrix,
    dimensions: [{ label: r(10), cells: [{ detail: r(LIMITS.cmpCellDetail + 1) }, { detail: r(10) }, { detail: r(10) }] }, { label: r(10), cells: Array.from({ length: 3 }, () => ({ detail: r(10) })) }],
  }).length > 0);

  // ── 6d. A NEW structured layout round-trips through the patch pipeline:
  //        set its seed, edit a nested path, re-validate.
  {
    const rt = deckDoc();
    const sid = rt.deck.slides[0].id;
    const setOutline = applyCoursePatch(rt.doc, setSlideTemplatePatch(rt.deck.id, sid, findStructuredLayout("outline_list")!.seed()), NOW);
    check("SET_SLIDE_TEMPLATE applies a new layout (outline_list)", setOutline.ok, setOutline.ok ? "" : setOutline.error);
    if (setOutline.ok) {
      const editSub = applyCoursePatch(setOutline.doc, updateTemplateContentPatch(rt.deck.id, sid, ["items", 0, "subItems", 0, "text"], "Edited sub-point"), NOW);
      check("UPDATE_TEMPLATE_CONTENT edits a nested sub-item by path", editSub.ok, editSub.ok ? "" : editSub.error);
      const tmpl = editSub.ok ? (editSub.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].template : undefined;
      check("nested sub-item text updated", tmpl?.layoutId === "outline_list" && tmpl.content.items[0].subItems?.[0].text === "Edited sub-point");
      // Switching concept_example's body kind by path re-validates.
      const setConcept = applyCoursePatch(setOutline.doc, setSlideTemplatePatch(rt.deck.id, sid, findStructuredLayout("concept_example")!.seed()), NOW);
      const switchBody = setConcept.ok
        ? applyCoursePatch(setConcept.doc, updateTemplateContentPatch(rt.deck.id, sid, ["example", "body"], { kind: "paragraphs", paragraphs: [{ text: "A single paragraph example." }] }), NOW)
        : setConcept;
      check("UPDATE_TEMPLATE_CONTENT switches concept_example body kind", switchBody.ok, switchBody.ok ? "" : switchBody.error);
      // A comparison_matrix sets + edits a nested cell by path (re-validates).
      const setMatrix = applyCoursePatch(setOutline.doc, setSlideTemplatePatch(rt.deck.id, sid, findStructuredLayout("comparison_matrix")!.seed()), NOW);
      check("SET_SLIDE_TEMPLATE applies comparison_matrix", setMatrix.ok, setMatrix.ok ? "" : setMatrix.error);
      const editCell = setMatrix.ok
        ? applyCoursePatch(setMatrix.doc, updateTemplateContentPatch(rt.deck.id, sid, ["dimensions", 0, "cells", 1, "detail", "text"], "Edited cell"), NOW)
        : setMatrix;
      check("UPDATE_TEMPLATE_CONTENT edits a nested matrix cell by path", editCell.ok, editCell.ok ? "" : editCell.error);
      const mtpl = editCell.ok ? (editCell.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].template : undefined;
      check("nested matrix cell text updated", mtpl?.layoutId === "comparison_matrix" && mtpl.content.dimensions[0].cells[1].detail.text === "Edited cell");
    }
  }

  // ── 7. The factory builds a persistence-valid structured slide.
  const slide = createStructuredSlide("metrics_overview");
  check("createStructuredSlide sets a template", !!slide.template && slide.template.layoutId === "metrics_overview");
  check("structured slide passes the (permissive) SlideSchema", SlideSchema.safeParse(slide).success);
  check("structured slide has no freeform elements", slide.elements.length === 0);

  // ── 8. The patch pipeline: set → edit by path → clear.
  const { doc, deck } = deckDoc();
  const sId = deck.slides[0].id;
  const set = applyCoursePatch(doc, setSlideTemplatePatch(deck.id, sId, findStructuredLayout("process_steps")!.seed()), NOW);
  check("SET_SLIDE_TEMPLATE applies", set.ok, set.ok ? "" : set.error);
  if (!set.ok) return finish();
  const afterSet = (set.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0];
  check("slide now has a template + matching layout id", afterSet.template?.layoutId === "process_steps" && afterSet.layout === "process_steps");

  const edit = applyCoursePatch(set.doc, updateTemplateContentPatch(deck.id, sId, ["title", "text"], "Renamed title"), NOW);
  check("UPDATE_TEMPLATE_CONTENT edits a field by path", edit.ok, edit.ok ? "" : edit.error);
  if (edit.ok) {
    const tmpl = (edit.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].template;
    check("title text was updated", tmpl?.layoutId === "process_steps" && tmpl.content.title.text === "Renamed title");
  }

  // Replacing a whole array (add/remove/reorder path) re-validates.
  const badArray = applyCoursePatch(set.doc, updateTemplateContentPatch(deck.id, sId, ["steps"], "not-an-array"), NOW);
  check("UPDATE_TEMPLATE_CONTENT rejects an invalid edit (re-validated)", !badArray.ok);

  // Applying a FLAT layout clears the template (back to freeform).
  const flat: CoursePatch = {
    action: "APPLY_SLIDE_LAYOUT",
    blockId: deck.id,
    slideId: sId,
    layoutId: "title_bullets",
    preserveExistingContent: false,
    newElementIds: ["n1", "n2", "n3"],
  };
  const cleared = applyCoursePatch(set.doc, flat, NOW);
  check("APPLY_SLIDE_LAYOUT clears the structured template", cleared.ok && !(cleared.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].template);

  finish();
}

function finish() {
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
