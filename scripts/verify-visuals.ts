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
import { coerceDiagramBestEffort, repairDiagram } from "@/lib/course/diagram/repair";
import { applyCoursePatch } from "@/lib/course/patches";
import { courseDocFromRows, courseDocToRows } from "@/lib/course/persistence";
import { SlideSchema } from "@/lib/course/schemas";
import { createBlock, createLesson, createModule, createStructuredSlide } from "@/lib/course/factories";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { coerceOutline, slideRequiresVisual, type LessonOutline } from "@/lib/ai/outline";
import { hasModelRepairableFailure, validateLessonGeneration } from "@/lib/ai/validation";
import { routeVisual } from "@/lib/ai/visuals/router";
import { buildImagePrompt, imageIntentHash } from "@/lib/ai/visuals/imageIntent";
import { AUTHORABLE_DIAGRAM_KINDS } from "@/lib/course/diagram/repair";
import { executeTool, getToolDefinitions, type VisualGenContext } from "@/lib/ai/tools";

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
  console.log("\n# 1. Catalog templates are correct by construction (authorable kinds only)");
  check(`catalog has ${DIAGRAM_TEMPLATES.length} authorable templates`, DIAGRAM_TEMPLATES.length >= 4);
  for (const t of DIAGRAM_TEMPLATES) {
    const errs = validateDiagram(t.seed());
    check(`${t.id}: seed passes validateDiagram`, errs.length === 0, errs.join(" | "));
    check(`${t.id}: kind is authorable`, AUTHORABLE_DIAGRAM_KINDS.has(t.kind), t.kind);
  }
  // Every AUTHORABLE diagram KIND is covered by at least one template.
  for (const kind of AUTHORABLE_DIAGRAM_KINDS) {
    check(`a template renders kind "${kind}"`, DIAGRAM_TEMPLATES.some((t) => t.kind === kind));
  }
  // RETIRED kinds expose NO templates on the AI surface.
  for (const kind of DIAGRAM_KINDS.filter((k) => !AUTHORABLE_DIAGRAM_KINDS.has(k))) {
    check(`retired kind "${kind}" has no authorable template`, !DIAGRAM_TEMPLATES.some((t) => t.kind === kind));
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

  console.log("\n# 3. The strict AI schema accepts the 2 kept kinds + bounces bad / retired ones");
  const goodSpec = findDiagramTemplate("regression_line")!.seed();
  check("strict schema accepts a valid coordinate_plot", DiagramSpecInputSchema.safeParse(goodSpec).success);
  const badDemand = { kind: "supply_demand", supply: { leftY: 0.2, rightY: 0.85 }, demand: { leftY: 0.2, rightY: 0.85 } };
  const parsed = DiagramSpecInputSchema.safeParse(badDemand);
  check("strict schema REJECTS demand sloping up (superRefine)", !parsed.success);
  check("rejection mentions the demand curve", !parsed.success && JSON.stringify(parsed.error.issues).includes("demand"));
  // A RETIRED kind can no longer be authored — the strict input union doesn't include it.
  check("strict schema REJECTS a retired kind (bar_chart)",
    !DiagramSpecInputSchema.safeParse({ kind: "bar_chart", bars: [{ label: "A", value: 1 }] }).success);
  check("strict schema REJECTS a retired kind (graph_diagram)",
    !DiagramSpecInputSchema.safeParse({ kind: "graph_diagram", nodes: [{ id: "A" }], edges: [] }).success);
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
  // BACK-COMPAT: a RETIRED kind already saved on a slide still renders (storage +
  // renderers were kept) even though the AI can no longer author it.
  {
    const legacy: DiagramSpec = { kind: "bar_chart", bars: [{ label: "A", value: 3 }, { label: "B", value: 5 }] };
    let markup = "";
    try {
      markup = renderToStaticMarkup(createElement(DiagramView, { diagram: legacy, width: 900, height: 480, palette, uid: "t" }));
    } catch (e) {
      markup = `ERR ${e}`;
    }
    check("retired kind (bar_chart) still RENDERS for back-compat", markup.includes("<svg") && markup.length > 100, markup.slice(0, 80));
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

  console.log("\n# 7. The router keeps the 2 kept kinds programmatic; reroutes the rest to images");
  const r1 = routeVisual({ role: "graph", topicText: "supply and demand equilibrium", mustBeAccurate: true });
  check("supply/demand topic → programmatic template", r1.source === "programmatic" && r1.templateId === "supply_demand_equilibrium" && r1.canRender);
  const r2 = routeVisual({ role: "tree_or_graph", topicText: "no keywords here", mustBeAccurate: false });
  check("a retired-kind role (tree_or_graph) → ai_generated image (rerouted)", r2.source === "ai_generated" && r2.canRender);
  const r3 = routeVisual({ role: "concept_diagram", topicText: "abstract metaphor", mustBeAccurate: true });
  check("accuracy-critical, no programmatic fit → manual (never an AI image)", r3.source === "upload" && !r3.canRender);
  const r4 = routeVisual({ role: "concept_diagram", topicText: "a historical scene of the signing", mustBeAccurate: false });
  check("a non-accuracy concept with no template + image-gen ON → ai_generated", r4.source === "ai_generated" && r4.canRender);
  const r5 = routeVisual({ role: "graph", topicText: "a generic plot of two variables", mustBeAccurate: false });
  check("a graph role still maps to a programmatic coordinate_plot", r5.source === "programmatic" && r5.diagramKind === "coordinate_plot");

  // The LIVE image-prompt builder: a reference prompt quotes required labels + the
  // textbook preamble; a supporting prompt is looser. The intent hash is stable.
  const refPrompt = buildImagePrompt({ visualWeight: "reference", prompt: "a labeled neuron", subject: "a neuron", requiredLabels: ["axon", "dendrite"], axes: undefined, annotations: ["the synapse"] });
  check("buildImagePrompt(reference) quotes every required label", /"axon"/.test(refPrompt) && /"dendrite"/.test(refPrompt));
  check("buildImagePrompt(reference) carries the textbook preamble + forbids extra text", /textbook/i.test(refPrompt) && /no other text|no text beyond/i.test(refPrompt));
  const supPrompt = buildImagePrompt({ visualWeight: "supporting", prompt: "students collaborating", subject: "collaboration" });
  check("buildImagePrompt(supporting) is conceptual + textbook (no quoted-label block)", /conceptual figure/i.test(supPrompt) && !/Required labels/.test(supPrompt));
  const h1 = imageIntentHash({ visualWeight: "reference", prompt: "p", requiredLabels: ["a"] });
  const h2 = imageIntentHash({ visualWeight: "reference", prompt: "p", requiredLabels: ["a"] });
  const h3 = imageIntentHash({ visualWeight: "reference", prompt: "p", requiredLabels: ["b"] });
  check("imageIntentHash is stable for the same intent, differs on change", h1 === h2 && h1 !== h3);

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
  // add_diagram with an INVALID custom diagram is ACCEPTED + REPAIRED best-effort
  // (never reshape-and-retry): a demand curve sloping the wrong way is corrected,
  // and the slide still lands as a valid supply_demand diagram.
  {
    const { doc, deckId, lessonId } = deckDoc();
    let threw = false;
    let outcome: Awaited<ReturnType<typeof executeTool>> | null = null;
    try {
      outcome = await executeTool(
        "add_diagram",
        JSON.stringify({
          deckBlockId: deckId, slideSpecId: null, position: null,
          title: "Bad", caption: null, takeaways: null, role: "graph",
          pedagogicalPurpose: "x", altText: "x", reason: null, templateId: null,
          // demand slopes UP (rightY > leftY) — invalid; the tool repairs it.
          diagram: { kind: "supply_demand", supply: { leftY: 0.2, rightY: 0.85 }, demand: { leftY: 0.2, rightY: 0.85 } },
        }),
        { doc, courseId: doc.id, lessonId }
      );
    } catch {
      threw = true;
    }
    check("add_diagram NO LONGER rejects an invalid custom diagram (best-effort)", !threw);
    const addPatch = (outcome?.patches ?? []).find((p) => p.action === "ADD_SLIDE");
    const slide = addPatch && addPatch.action === "ADD_SLIDE" ? addPatch.slide : null;
    const dg = slide?.template?.layoutId === "diagram" ? slide.template.content.diagram : null;
    check("the off-slope diagram was REPAIRED to a valid one (demand slopes down)", !!dg && dg.kind === "supply_demand" && dg.demand.rightY < dg.demand.leftY && dg.supply.rightY > dg.supply.leftY, JSON.stringify(dg));
  }

  // NO PLACEHOLDER DIAGRAMS: an UNUSABLE custom diagram (empty bars — no real data,
  // not repairable) is NOT rendered as a demo diagram. It degrades to a PROSE slide
  // built from the model's real title/caption — never a default A/B/C chart.
  {
    const { doc, deckId, lessonId } = deckDoc();
    const outcome = await executeTool(
      "add_diagram",
      JSON.stringify({
        deckBlockId: deckId, slideSpecId: "s1", position: null,
        title: "Tax revenue by year", caption: "Revenue climbed steadily over the decade.", takeaways: ["Up every year"], role: "data_chart",
        pedagogicalPurpose: "show the trend", altText: "a bar chart of tax revenue", reason: null, templateId: null,
        diagram: { kind: "bar_chart", bars: [] }, // EMPTY — no real data; unrepairable
      }),
      { doc, courseId: doc.id, lessonId }
    );
    const p = (outcome.patches ?? []).find((x) => x.action === "ADD_SLIDE");
    const sl = p && p.action === "ADD_SLIDE" ? p.slide : null;
    check("an unusable (empty-data) diagram does NOT render a placeholder diagram", sl?.template?.layoutId !== "diagram", sl?.template?.layoutId);
    check("it degrades to a PROSE slide carrying the model's real title/caption", sl?.template?.layoutId === "prose" && /tax revenue/i.test(sl.template.content.title.text) && sl.template.content.body.text.length > 0, JSON.stringify(sl?.template?.layoutId));
    check("the degraded slide keeps its plan spec stamp (coverage holds)", sl?.ai?.specId === "s1");
  }

  // FIX 2: the prose degrade NEVER renders an author-DIRECTIVE (pedagogicalPurpose /
  // altText) as slide content — only the model's real caption / takeaways. This is
  // the "Key idea: Show a concrete lunch-choice …" leak the user reported.
  {
    const { doc, deckId, lessonId } = deckDoc();
    const outcome = await executeTool(
      "add_diagram",
      JSON.stringify({
        deckBlockId: deckId, slideSpecId: "s1", position: null,
        title: "Opportunity cost", caption: "Choosing one option means giving up the next-best one.", takeaways: null, role: "concept_diagram",
        pedagogicalPurpose: "Show a concrete lunch-choice ranking of options by utility.", // an author DIRECTIVE, not content
        altText: "an illustration of the choices", reason: null, templateId: null,
        diagram: { kind: "bar_chart", bars: [] }, // unusable → degrade to prose
      }),
      { doc, courseId: doc.id, lessonId }
    );
    const p = (outcome.patches ?? []).find((x) => x.action === "ADD_SLIDE");
    const sl = p && p.action === "ADD_SLIDE" ? p.slide : null;
    const body = sl?.template?.layoutId === "prose" ? sl.template.content.body.text : "";
    check("degrade body = the model's real CAPTION (real teaching content)", /giving up the next-best/i.test(body), body);
    check("degrade NEVER renders the author directive (pedagogicalPurpose) as content", !/Show a concrete/i.test(body), body);
  }

  // A visual request with NO real teaching content (only a directive) FAILS to build
  // (reported back) rather than rendering the directive — a directive-only slide is
  // never authored ("thin slides dropped, not passed through").
  {
    const { doc, deckId, lessonId } = deckDoc();
    let threw = false;
    try {
      await executeTool(
        "add_diagram",
        JSON.stringify({
          deckBlockId: deckId, slideSpecId: "s1", position: null,
          title: "", caption: null, takeaways: null, role: "concept_diagram",
          pedagogicalPurpose: "Explain the tradeoff somehow.", altText: "", reason: null, templateId: null,
          diagram: { kind: "bar_chart", bars: [] },
        }),
        { doc, courseId: doc.id, lessonId }
      );
    } catch {
      threw = true;
    }
    check("a content-less visual request fails (no directive-only slide authored)", threw);
  }

  // repairDiagram / coerceDiagramBestEffort — NO fabrication, NO demo seed.
  {
    // Repairs an invariant on REAL data (off-slope demand → corrected).
    const fixed = repairDiagram({ kind: "supply_demand", supply: { leftY: 0.2, rightY: 0.85 }, demand: { leftY: 0.2, rightY: 0.85 } });
    check("repairDiagram fixes an invariant on real data (slope)", fixed.kind === "supply_demand" && validateDiagram(fixed).length === 0);
    // Does NOT invent data: empty bars stay empty (still invalid) → coerce returns null.
    const emptyBars = repairDiagram({ kind: "bar_chart", bars: [] });
    check("repairDiagram does NOT fabricate bars for an empty chart", emptyBars.kind === "bar_chart" && emptyBars.bars.length === 0);
    check("coerceDiagramBestEffort returns null for unusable data (no demo seed)", coerceDiagramBestEffort({ kind: "bar_chart", bars: [] }) === null);
    check("coerceDiagramBestEffort returns null for a null diagram (never a default)", coerceDiagramBestEffort(null) === null);
    // A weighted graph missing weights renders UNWEIGHTED (real edges) — not faked weights.
    const gw = repairDiagram({ kind: "graph_diagram", weighted: true, nodes: [{ id: "A" }, { id: "B" }], edges: [{ from: "A", to: "B" }] });
    check("repairDiagram drops the 'weighted' claim rather than invent weights", gw.kind === "graph_diagram" && gw.weighted === false && validateDiagram(gw).length === 0);
  }

  console.log("\n# 9. add_image ENQUEUES a pending image slide (off the critical path)");
  const visuals: VisualGenContext = { maxPerLesson: 5 };

  // (a) supporting → a PENDING image_supporting slide (imageUrl "" + pendingGen).
  {
    const { doc, deckId, lessonId } = deckDoc();
    const out = await executeTool("add_image", JSON.stringify({
      deckBlockId: deckId, slideSpecId: "s1", visualWeight: "supporting",
      prompt: "students collaborating around a table", alt: "Students collaborating.",
      eyebrow: "Lesson 1", title: "Why context matters", imageSpec: null,
      annotations: null, cards: null, lead: "Context shapes meaning.", bullets: ["It guides interpretation.", "It prevents errors."], caption: "Notice the shared focus.",
    }), { doc, courseId: doc.id, lessonId, visuals });
    check("add_image returns immediately (enqueue, source=pending)", (out.data as { source?: string })?.source === "pending");
    let working = doc; for (const p of out.patches ?? []) { const r = applyCoursePatch(working, p, NOW); if (r.ok) working = r.doc; }
    const slide = (working.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides.at(-1);
    const c = slide?.template?.layoutId === "image_supporting" ? slide.template.content : null;
    check("supporting → image_supporting, PENDING (imageUrl empty)", !!c && c.imageUrl === "" && c.pendingGen?.status === "pending");
    check("pendingGen carries the supporting weight + prompt + alt", c?.pendingGen?.visualWeight === "supporting" && !!c?.pendingGen?.prompt && !!c?.pendingGen?.alt);
    check("supporting slide kept bullets + spec stamp + intentHash", (c?.bullets?.length ?? 0) === 2 && slide?.ai.specId === "s1" && !!c?.intentHash);
    check("pending image slide passes permissive SlideSchema", !!slide && SlideSchema.safeParse(slide).success);
  }
  // (b) reference → a PENDING image_reference; pendingGen carries the required labels.
  {
    const { doc, deckId, lessonId } = deckDoc();
    const out = await executeTool("add_image", JSON.stringify({
      deckBlockId: deckId, slideSpecId: "s2", visualWeight: "reference",
      prompt: "a labeled diagram of a neuron", alt: "A labeled neuron.",
      eyebrow: "Concept overview", title: "Anatomy of a neuron",
      imageSpec: { subject: "a neuron", requiredLabels: ["axon", "dendrite", "soma"], axisX: null, axisY: null, annotations: ["the synaptic gap"] },
      annotations: [{ label: "Axon", description: "Carries the signal away." }, { label: "Dendrite", description: "Receives signals." }],
      cards: [{ title: "Input", description: "Dendrites gather signals." }, { title: "Process", description: "The soma integrates them." }],
      lead: null, bullets: null, caption: null,
    }), { doc, courseId: doc.id, lessonId, visuals });
    let working = doc; for (const p of out.patches ?? []) { const r = applyCoursePatch(working, p, NOW); if (r.ok) working = r.doc; }
    const slide = (working.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides.at(-1);
    const c = slide?.template?.layoutId === "image_reference" ? slide.template.content : null;
    check("reference → image_reference, PENDING w/ annotations + cards", !!c && c.imageUrl === "" && (c.annotations?.length ?? 0) === 2 && (c.cards?.length ?? 0) === 2);
    check("pendingGen carries the reference weight + required labels", c?.pendingGen?.visualWeight === "reference" && !!c?.pendingGen?.requiredLabels?.includes("axon"));
    // The full gpt-image prompt is built at GENERATION time from pendingGen — verify the builder quotes labels.
    check("buildImagePrompt(pendingGen) quotes the required labels", c?.pendingGen ? /"axon"/.test(buildImagePrompt({ visualWeight: "reference", prompt: c.pendingGen.prompt, subject: c.pendingGen.subject, requiredLabels: c.pendingGen.requiredLabels })) : false);
  }
  // (c) FREEZE — same spec + intent while PENDING is a no-op (no second pending slide).
  {
    const { doc, deckId, lessonId } = deckDoc();
    const args = { deckBlockId: deckId, slideSpecId: "s1", visualWeight: "supporting", prompt: "a fixed scene", alt: "alt text here", eyebrow: null, title: "T", imageSpec: null, annotations: null, cards: null, lead: "lead sentence", bullets: null, caption: null };
    const out1 = await executeTool("add_image", JSON.stringify(args), { doc, courseId: doc.id, lessonId, visuals });
    let working = doc; for (const p of out1.patches ?? []) { const r = applyCoursePatch(working, p, NOW); if (r.ok) working = r.doc; }
    const before = (working.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides.length;
    const out2 = await executeTool("add_image", JSON.stringify(args), { doc: working, courseId: doc.id, lessonId, visuals });
    check("freeze: re-enqueue of the same pending intent is a no-op (no patch)", (out2.patches?.length ?? 0) === 0 && (out2.data as { source?: string })?.source === "pending");
    // Simulate the endpoint FILLING the slide, then re-enqueue with the same intent → reuse (no new pending).
    const deck = working.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
    const filled = deck.slides.find((s) => s.ai.specId === "s1");
    if (filled && filled.template?.layoutId === "image_supporting") {
      filled.template.content.imageUrl = "https://x.test/storage/v1/object/public/course-assets/u/done.png";
      delete filled.template.content.pendingGen;
    }
    const out3 = await executeTool("add_image", JSON.stringify(args), { doc: working, courseId: doc.id, lessonId, visuals });
    check("freeze: same intent after fill → REUSE the stored image (source=reused)", (out3.data as { source?: string })?.source === "reused");
    check("freeze: deck did not grow a duplicate", before === (working.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides.length);
  }
  // (d) image-gen UNAVAILABLE (no ctx.visuals) → prose-degrade immediately (no throw, coverage holds).
  {
    const { doc, deckId, lessonId } = deckDoc();
    const out = await executeTool("add_image", JSON.stringify({
      deckBlockId: deckId, slideSpecId: "s1", visualWeight: "supporting",
      prompt: "x", alt: "alt text", eyebrow: null, title: "Photosynthesis", imageSpec: null,
      annotations: null, cards: null, lead: "Plants convert light to energy.", bullets: ["Chlorophyll absorbs light."], caption: null,
    }), { doc, courseId: doc.id, lessonId });
    const p = (out.patches ?? []).find((x) => x.action === "ADD_SLIDE");
    const sl = p && p.action === "ADD_SLIDE" ? p.slide : null;
    check("no image capability → degrades to a PROSE slide (no throw)", sl?.template?.layoutId === "prose" && /photosynthesis/i.test(sl.template.content.title.text), sl?.template?.layoutId);
    check("the degraded prose keeps the spec stamp (coverage holds)", sl?.ai?.specId === "s1");
  }

  console.log("\n# 10. The lesson validator enforces REQUIRED visuals");
  const outline: LessonOutline = {
    objective: "Understand equilibrium",
    targetStudent: "Beginners",
    estimatedMinutes: 10,
    microLesson: false,
    teachingArc: { hook: "", coreConcepts: [], workedExamples: [], commonMisconceptions: [], recapGoal: "" },
    segments: [],
    speakerNotesGoal: "",
    slides: [
      {
        id: "s1", segmentId: "seg", title: "Equilibrium", teachingGoal: "See where curves cross",
        role: "visual_model", kind: "core", layout: "diagram", depth: "mechanism", keyPoints: [], notes: "",
        visualIntent: { required: true, role: "graph", mustBeAccurate: true, priority: "required" },
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
    check("required visual MISSING on a prose slide → flagged (still reported)", report.missingRequiredVisualSpecIds.includes("s1") && report.issues.some((i) => i.code === "REQUIRED_VISUAL_MISSING"));
    // KEEP COVERAGE, DROP FIT: a missing recommended visual is now SOFT — it does
    // NOT block `ok` and does NOT trigger the repair loop (no "reshape" repairs).
    check("REQUIRED_VISUAL_MISSING is SOFT — coverage complete → ok, no repair", report.ok && !hasModelRepairableFailure(report), JSON.stringify({ ok: report.ok }));
  }

  console.log("\n# 10. diagramRequiredElements describe the visual");
  check("array diagram requiredElements mention cells", diagramRequiredElements({ kind: "array_diagram", values: ["1"], sorted: true }).some((e) => /cell/i.test(e)));

  console.log("\n# 11. A diagram persists through the Supabase doc↔rows map (back-compat, no migration)");
  {
    const { doc } = deckDoc();
    const deck = doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
    const slide = createStructuredSlide("diagram", "editorial-warm");
    // A RETIRED-kind (graph_diagram) diagram already on a slide must still round-trip
    // through storage (the storage schema keeps all kinds) — inlined since the catalog
    // no longer exposes the template.
    slide.template = {
      layoutId: "diagram",
      content: {
        title: { text: "Shortest path" },
        caption: { text: "S→A→B→T costs 6." },
        spec: { role: "tree_or_graph", pedagogicalPurpose: "Show Dijkstra.", altText: "A weighted directed graph.", source: "programmatic", mustBeAccurate: true, requiredElements: ["nodes", "edges", "edge weights"] },
        diagram: {
          kind: "graph_diagram",
          directed: true,
          weighted: true,
          nodes: [{ id: "S" }, { id: "A" }, { id: "B" }, { id: "C" }, { id: "T" }],
          edges: [
            { from: "S", to: "A", weight: 2 },
            { from: "S", to: "B", weight: 5 },
            { from: "A", to: "B", weight: 1 },
            { from: "A", to: "C", weight: 4 },
            { from: "B", to: "T", weight: 3 },
            { from: "C", to: "T", weight: 1 },
          ],
          highlightPath: ["S", "A", "B", "T"],
        },
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
