/**
 * AI-assisted VISUAL pipeline checks — pure, no key/DB.
 * Run: `npx tsx scripts/verify-visuals.ts`
 *
 * Proves the whole programmatic-diagram path end to end:
 *  - every catalog template seed is CORRECT by construction (validateDiagram == [])
 *  - the deterministic validator catches the spec's named failure cases
 *    (demand sloping up, an unsorted binary-search array, a weighted graph missing
 *    a weight, an edge to a non-existent node)
 *  - the STRICT AI schema accepts a valid diagram and bounces the bad ones
 *  - the diagram tool schemas convert to OpenAI-strict JSON (incl. the fixed-depth
 *    tree — no recursive $ref) and the add_diagram tool produces a real slide
 *  - every diagram kind renders to SVG (server static render — export-ready)
 *  - structured visualIntent parses (object + legacy string) into the plan
 *  - the router picks programmatic over image-gen by priority
 *  - the lesson validator flags a REQUIRED visual that's missing and passes when present
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagramView } from "@/components/editor/slide/diagram/DiagramView";
import { DIAGRAM_TEMPLATES, findDiagramTemplate, templateRequiredElements } from "@/lib/course/diagram/catalog";
import { DiagramContentInputSchema, DiagramSpecInputSchema } from "@/lib/course/diagram/schemas";
import { DIAGRAM_KINDS, type DiagramSpec } from "@/lib/course/diagram/types";
import { diagramRequiredElements, validateDiagram } from "@/lib/course/diagram/validate";
import { applyCoursePatch } from "@/lib/course/patches";
import { courseDocFromRows, courseDocToRows } from "@/lib/course/persistence";
import { SlideSchema } from "@/lib/course/schemas";
import { createBlock, createLesson, createModule, createStructuredSlide } from "@/lib/course/factories";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { coerceOutline, slideRequiresVisual, type LessonOutline } from "@/lib/ai/outline";
import { validateLessonGeneration } from "@/lib/ai/validation";
import { routeVisual } from "@/lib/ai/visuals/router";
import { imagePromptFromSpec } from "@/lib/ai/visuals/imagePrompt";
import { executeTool, getToolDefinitions } from "@/lib/ai/tools";
import type { VisualSpec } from "@/lib/ai/visuals/types";

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

const NOW = "2026-06-20T00:00:00.000Z";

/** A doc with one module → lesson → empty slide deck (we push controlled slides). */
function deckDoc(): { doc: CourseDocument; deckId: string; lessonId: string } {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  const lesson = createLesson("Lesson", 0);
  lesson.blocks = [deck];
  const mod = createModule("Module", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: "course",
    title: "Visuals test",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: { name: "Editorial Warm", accent: "amber", slideDefaults: { layout: "title", themeId: "editorial-warm" } },
    metadata: { createdAt: NOW, updatedAt: NOW, ownerId: "owner", aiReadableVersion: "1.0" },
  };
  return { doc, deckId: deck.id, lessonId: lesson.id };
}

async function main() {
  console.log("\n# 1. Catalog templates are correct by construction");
  check(`catalog has ${DIAGRAM_TEMPLATES.length} templates`, DIAGRAM_TEMPLATES.length >= 15);
  for (const t of DIAGRAM_TEMPLATES) {
    const errs = validateDiagram(t.seed());
    check(`${t.id}: seed passes validateDiagram`, errs.length === 0, errs.join(" | "));
  }
  // Every diagram KIND is covered by at least one template.
  for (const kind of DIAGRAM_KINDS) {
    check(`a template renders kind "${kind}"`, DIAGRAM_TEMPLATES.some((t) => t.kind === kind));
  }
  check("supply_demand_equilibrium requiredElements mention equilibrium",
    templateRequiredElements(findDiagramTemplate("supply_demand_equilibrium")!).some((e) => /equilibrium/i.test(e)));

  console.log("\n# 2. The deterministic validator catches the spec's failure cases");
  // Demand sloping UP → fail.
  check("supply/demand with demand sloping up is invalid",
    validateDiagram({ kind: "supply_demand", supply: { leftY: 0.2, rightY: 0.8 }, demand: { leftY: 0.2, rightY: 0.8 } }).some((e) => /demand/i.test(e)));
  // Supply sloping DOWN → fail.
  check("supply/demand with supply sloping down is invalid",
    validateDiagram({ kind: "supply_demand", supply: { leftY: 0.8, rightY: 0.2 }, demand: { leftY: 0.8, rightY: 0.2 } }).some((e) => /supply/i.test(e)));
  // Unsorted "sorted" array → fail.
  check("binary-search array that isn't sorted is invalid",
    validateDiagram({ kind: "array_diagram", values: ["3", "1", "2"], sorted: true }).some((e) => /sorted|order/i.test(e)));
  // Weighted graph missing a weight → fail.
  check("weighted graph with a missing edge weight is invalid",
    validateDiagram({ kind: "graph_diagram", weighted: true, nodes: [{ id: "A" }, { id: "B" }], edges: [{ from: "A", to: "B" }] }).some((e) => /weight/i.test(e)));
  // Edge to a non-existent node → fail.
  check("graph edge to a non-existent node is invalid",
    validateDiagram({ kind: "graph_diagram", nodes: [{ id: "A" }], edges: [{ from: "A", to: "Z" }] }).some((e) => /Z/.test(e)));
  // A correct supply/demand → valid.
  check("a correct supply/demand graph is valid",
    validateDiagram({ kind: "supply_demand", supply: { leftY: 0.2, rightY: 0.85 }, demand: { leftY: 0.85, rightY: 0.2 } }).length === 0);

  console.log("\n# 3. The strict AI schema accepts good diagrams and bounces bad ones");
  const goodSpec = findDiagramTemplate("dijkstra_graph")!.seed();
  check("strict schema accepts a valid weighted graph", DiagramSpecInputSchema.safeParse(goodSpec).success);
  const badDemand = { kind: "supply_demand", supply: { leftY: 0.2, rightY: 0.85 }, demand: { leftY: 0.2, rightY: 0.85 } };
  const parsed = DiagramSpecInputSchema.safeParse(badDemand);
  check("strict schema REJECTS demand sloping up (superRefine)", !parsed.success);
  check("rejection mentions the demand curve", !parsed.success && JSON.stringify(parsed.error.issues).includes("demand"));
  // Full diagram content (title + spec + diagram).
  const goodContent = {
    title: { text: "Market equilibrium" },
    caption: { text: "Where supply meets demand." },
    spec: { role: "graph", pedagogicalPurpose: "Show equilibrium.", altText: "A supply and demand graph." },
    diagram: findDiagramTemplate("supply_demand_equilibrium")!.seed(),
  };
  check("DiagramContentInputSchema accepts a valid content", DiagramContentInputSchema.safeParse(goodContent).success,
    JSON.stringify(DiagramContentInputSchema.safeParse(goodContent).error?.issues ?? ""));
  check("DiagramContentInputSchema rejects empty alt text",
    !DiagramContentInputSchema.safeParse({ ...goodContent, spec: { ...goodContent.spec, altText: "" } }).success);

  console.log("\n# 4. The diagram tool schemas convert to OpenAI-strict JSON");
  let toolDefs: ReturnType<typeof getToolDefinitions> = [];
  try {
    toolDefs = getToolDefinitions();
    check("getToolDefinitions() builds every tool schema (incl. diagram)", true);
  } catch (e) {
    check("getToolDefinitions() builds every tool schema (incl. diagram)", false, String(e));
  }
  const addDiagram = toolDefs.find((t) => t.name === "add_diagram");
  const setDiagram = toolDefs.find((t) => t.name === "set_diagram");
  check("add_diagram tool is exposed", !!addDiagram);
  check("set_diagram tool is exposed", !!setDiagram);
  const json = JSON.stringify(addDiagram?.parameters ?? {});
  check("add_diagram schema has NO recursive $ref (fixed-depth tree inlined)", !json.includes("$ref"), "found a $ref");
  // The structured-slide batch schema (with the diagram variant) also converts.
  let diagramContentJsonOk = true;
  try {
    toStrictJsonSchema(DiagramContentInputSchema);
  } catch (e) {
    diagramContentJsonOk = false;
    console.log(`     ${e}`);
  }
  check("DiagramContentInputSchema converts to strict JSON schema", diagramContentJsonOk);

  console.log("\n# 5. Every diagram kind renders to SVG (server static render)");
  const palette = { accent: "#ea580c", ink: "#1c1917", body: "#44403c", muted: "#78716c" };
  const oneTemplatePerKind = new Map<string, DiagramSpec>();
  for (const t of DIAGRAM_TEMPLATES) if (!oneTemplatePerKind.has(t.kind)) oneTemplatePerKind.set(t.kind, t.seed());
  for (const [kind, spec] of oneTemplatePerKind) {
    let markup = "";
    try {
      markup = renderToStaticMarkup(createElement(DiagramView, { diagram: spec, width: 900, height: 480, palette, uid: "t" }));
    } catch (e) {
      markup = `ERR ${e}`;
    }
    check(`${kind}: renders an <svg>`, markup.includes("<svg") && markup.length > 100, markup.slice(0, 80));
  }

  console.log("\n# 6. Structured visualIntent parses into the plan");
  const planned = coerceOutline({
    slides: [
      { layout: "diagram", visualIntent: { required: true, role: "graph", reason: "Conventionally a graph.", priority: "required", mustBeAccurate: true } },
      { layout: "prose", visualIntent: "a rough sketch of the idea" },
      { layout: "key_concept", visualIntent: null },
    ],
  });
  const slides = planned.outline?.slides ?? [];
  check("structured visualIntent coerces to an object", slides[0]?.visualIntent?.role === "graph" && slides[0]?.visualIntent?.required === true);
  check("a required visual is recognized", !!slides[0] && slideRequiresVisual(slides[0]));
  check("legacy string visualIntent → recommended (not required)",
    slides[1]?.visualIntent?.required === false && slides[1]?.visualIntent?.expectedVisualType === "a rough sketch of the idea" && !slideRequiresVisual(slides[1]));
  check("null visualIntent → no intent", slides[2]?.visualIntent === undefined);

  console.log("\n# 7. The router prefers programmatic, by priority");
  const r1 = routeVisual({ role: "graph", topicText: "supply and demand equilibrium", mustBeAccurate: true });
  check("supply/demand topic → programmatic template", r1.source === "programmatic" && r1.templateId === "supply_demand_equilibrium" && r1.canRender);
  const r2 = routeVisual({ role: "tree_or_graph", topicText: "no keywords here", mustBeAccurate: false });
  check("a graph role with no template → programmatic by kind", r2.source === "programmatic" && r2.diagramKind === "graph_diagram");
  const r3 = routeVisual({ role: "concept_diagram", topicText: "abstract metaphor", mustBeAccurate: true });
  check("accuracy-critical, no programmatic fit → manual (never an AI image)", r3.source === "upload" && !r3.canRender);
  const r4 = routeVisual({ role: "concept_diagram", topicText: "a historical scene of the signing", mustBeAccurate: false });
  check("a non-accuracy concept with no template + image-gen ON → ai_generated", r4.source === "ai_generated" && r4.canRender);
  // image-prompt builder produces a strict prompt (used only on the enabled path)
  const vspec: VisualSpec = {
    id: "v", courseId: "c", lessonId: "l", deckBlockId: "d", slideId: "s", slideSpecId: "s1",
    type: "ai_generated_diagram", visualRole: "concept_diagram", title: "T",
    pedagogicalPurpose: "P", requiredElements: ["a box", "an arrow"], placement: "center", altText: "alt",
    validation: { required: true, mustPassBeforeInsert: true }, ai: { purpose: "P", editable: true, allowedActions: [], semanticTags: [] },
  };
  check("imagePromptFromSpec lists required elements + bans decoration",
    /a box/.test(imagePromptFromSpec(vspec)) && /no decorative/i.test(imagePromptFromSpec(vspec)));

  console.log("\n# 8. add_diagram authors a real diagram slide");
  {
    const { doc, deckId, lessonId } = deckDoc();
    const out = await executeTool(
      "add_diagram",
      JSON.stringify({
        deckBlockId: deckId,
        slideSpecId: "s1",
        position: null,
        title: "Market equilibrium",
        caption: "Supply meets demand at E.",
        takeaways: ["Above P*, surplus pushes price down."],
        role: "graph",
        pedagogicalPurpose: "Teach equilibrium.",
        altText: "A supply and demand graph with equilibrium E.",
        reason: "Conventionally taught with intersecting curves.",
        templateId: "supply_demand_equilibrium",
        diagram: null,
      }),
      { doc, courseId: doc.id, lessonId }
    );
    check("add_diagram returns an ADD_SLIDE patch", (out.patches?.length ?? 0) >= 1 && out.patches!.some((p) => p.action === "ADD_SLIDE"));
    let working = doc;
    for (const p of out.patches ?? []) {
      const res = applyCoursePatch(working, p, NOW);
      if (res.ok) working = res.doc;
    }
    const slide = (working.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides.at(-1);
    check("the new slide is a diagram template", slide?.template?.layoutId === "diagram");
    check("the diagram's spec.source defaults to programmatic", slide?.template?.layoutId === "diagram" && slide.template.content.spec.source === "programmatic");
    check("the new slide is stamped with its plan spec id", slide?.ai.specId === "s1");
    check("the diagram slide passes the (permissive) SlideSchema", !!slide && SlideSchema.safeParse(slide).success);
    check("the diagram's requiredElements were filled from the diagram",
      slide?.template?.layoutId === "diagram" && (slide.template.content.spec.requiredElements?.length ?? 0) > 0);
  }
  // add_diagram with an INVALID custom diagram is rejected (the tool boundary).
  {
    const { doc, deckId, lessonId } = deckDoc();
    let threw = false;
    try {
      await executeTool(
        "add_diagram",
        JSON.stringify({
          deckBlockId: deckId, slideSpecId: null, position: null,
          title: "Bad", caption: null, takeaways: null, role: "graph",
          pedagogicalPurpose: "x", altText: "x", reason: null, templateId: null,
          diagram: { kind: "supply_demand", supply: { leftY: 0.2, rightY: 0.85 }, demand: { leftY: 0.2, rightY: 0.85 } },
        }),
        { doc, courseId: doc.id, lessonId }
      );
    } catch {
      threw = true;
    }
    check("add_diagram rejects an invalid custom diagram (demand up)", threw);
  }

  console.log("\n# 9. add_image authors a STORED illustration slide (+ guards)");
  {
    const { doc, deckId, lessonId } = deckDoc();
    // A fake visual capability (the real one generates bytes + uploads to Supabase).
    const visuals = {
      maxPerLesson: 5,
      async generateIllustration() {
        return { url: "https://x.test/storage/v1/object/public/course-assets/u/img.png", storagePath: "u/img.png", width: 1536, height: 1024 };
      },
    };
    const out = await executeTool(
      "add_image",
      JSON.stringify({ deckBlockId: deckId, slideSpecId: "s1", prompt: "a branching tree of nodes", alt: "An illustration of a branching tree of nodes.", title: null, caption: "Notice the branching." }),
      { doc, courseId: doc.id, lessonId, visuals }
    );
    check("add_image returns an ADD_SLIDE patch", (out.patches?.length ?? 0) >= 1 && out.patches!.some((p) => p.action === "ADD_SLIDE"));
    let working = doc;
    for (const p of out.patches ?? []) { const res = applyCoursePatch(working, p, NOW); if (res.ok) working = res.doc; }
    const slide = (working.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides.at(-1);
    check("the new slide is an illustration with the STORED course-assets URL", slide?.template?.layoutId === "illustration" && slide.template.content.imageUrl.includes("course-assets") && slide.template.content.source === "ai_generated");
    check("the illustration kept its alt text + plan spec stamp", slide?.template?.layoutId === "illustration" && slide.template.content.alt.length > 0 && slide.ai.specId === "s1");
    check("the illustration slide passes the permissive SlideSchema", !!slide && SlideSchema.safeParse(slide).success);
  }
  // add_image WITHOUT an image capability → a clear ToolError (degrade to diagram/prose).
  {
    const { doc, deckId, lessonId } = deckDoc();
    let threw = false;
    try {
      await executeTool("add_image", JSON.stringify({ deckBlockId: deckId, slideSpecId: null, prompt: "x", alt: "alt text", title: null, caption: null }), { doc, courseId: doc.id, lessonId });
    } catch { threw = true; }
    check("add_image without an image capability → ToolError", threw);
  }

  console.log("\n# 10. The lesson validator enforces REQUIRED visuals");
  const outline: LessonOutline = {
    objective: "Understand equilibrium",
    targetStudent: "Beginners",
    estimatedMinutes: 10,
    microLesson: false,
    teachingArc: { hook: "", coreConcepts: [], workedExamples: [], commonMisconceptions: [], recapGoal: "" },
    segments: [],
    slides: [
      {
        id: "s1", segmentId: "seg", title: "Equilibrium", teachingGoal: "See where curves cross",
        role: "visual_model", kind: "core", layout: "diagram", depth: "mechanism", keyPoints: [], notes: "",
        speakerNotesGoal: "", visualIntent: { required: true, role: "graph", mustBeAccurate: true, priority: "required" },
      },
    ],
  };

  // (a) A built DIAGRAM slide satisfies the required visual.
  {
    const { doc, lessonId } = deckDoc();
    const deck = doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
    const dslide = createStructuredSlide("diagram", "editorial-warm");
    dslide.ai.specId = "s1";
    deck.slides = [dslide];
    const report = validateLessonGeneration(doc, lessonId, outline);
    check("required visual SATISFIED by a diagram slide → no missing-visual issue", report.missingRequiredVisualSpecIds.length === 0);
    check("report is OK when the required visual is present", report.ok, JSON.stringify(report.issues));
  }
  // (b) A built PROSE slide for the same spec is flagged.
  {
    const { doc, lessonId } = deckDoc();
    const deck = doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
    const pslide = createStructuredSlide("prose", "editorial-warm");
    pslide.ai.specId = "s1";
    deck.slides = [pslide];
    const report = validateLessonGeneration(doc, lessonId, outline);
    check("required visual MISSING on a prose slide → flagged", report.missingRequiredVisualSpecIds.includes("s1"));
    check("REQUIRED_VISUAL_MISSING is a hard failure", !report.ok && report.issues.some((i) => i.code === "REQUIRED_VISUAL_MISSING"));
  }

  console.log("\n# 10. diagramRequiredElements describe the visual");
  check("array diagram requiredElements mention cells", diagramRequiredElements({ kind: "array_diagram", values: ["1"], sorted: true }).some((e) => /cell/i.test(e)));

  console.log("\n# 11. A diagram persists through the Supabase doc↔rows map (no migration)");
  {
    const { doc } = deckDoc();
    const deck = doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
    const slide = createStructuredSlide("diagram", "editorial-warm");
    slide.template = {
      layoutId: "diagram",
      content: {
        title: { text: "Shortest path" },
        caption: { text: "S→A→B→T costs 6." },
        spec: { role: "tree_or_graph", pedagogicalPurpose: "Show Dijkstra.", altText: "A weighted directed graph.", source: "programmatic", mustBeAccurate: true, requiredElements: ["nodes", "edges", "edge weights"] },
        diagram: findDiagramTemplate("dijkstra_graph")!.seed(),
      },
    };
    deck.slides = [slide];

    // doc → rows: the diagram lands in blocks.content jsonb verbatim (no column).
    const rows = courseDocToRows(doc, "owner");
    const written = (rows.blocks[0].content as { slides: { template: { layoutId: string; content: { diagram: { kind: string; edges: unknown[] } } } }[] }).slides[0].template;
    check("WRITE: the diagram is serialized into blocks.content jsonb", written.layoutId === "diagram" && written.content.diagram.kind === "graph_diagram" && written.content.diagram.edges.length === 6);

    // rows → doc: read back verbatim (the round-trip the studio load + autosave use).
    const courseRow = { ...rows.course, created_at: NOW, updated_at: NOW } as Parameters<typeof courseDocFromRows>[0];
    const back = courseDocFromRows(courseRow, rows.modules as Parameters<typeof courseDocFromRows>[1], rows.lessons as Parameters<typeof courseDocFromRows>[2], rows.blocks as Parameters<typeof courseDocFromRows>[3]);
    const t = (back.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].template;
    check("READ: the diagram comes back lossless (kind + weights + alt text + spec)",
      t?.layoutId === "diagram" &&
      t.content.diagram.kind === "graph_diagram" &&
      (t.content.diagram as { weighted?: boolean }).weighted === true &&
      t.content.diagram.edges.length === 6 &&
      t.content.spec.altText === "A weighted directed graph." &&
      t.content.spec.mustBeAccurate === true);
    check("read-back slide still passes the (permissive) SlideSchema",
      SlideSchema.safeParse((back.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0]).success);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
