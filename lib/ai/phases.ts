/**
 * Phased content-agent pipeline — PLAN → GENERATE → CRITIQUE.
 *
 * One agent (gpt-5.4-mini), reasoning effort set PER CALL (PLAN high · GENERATE
 * medium · CRITIQUE high). The entrypoint classifies the turn: small edits keep
 * the existing single-turn loop; a "build the lesson" request runs the pipeline.
 *
 * - PLAN: a structured-output turn emits a slide-by-slide outline. Manual approve
 *   by default (emit `plan_outline` + pause, mirroring the delete confirm flow);
 *   the outline round-trips through the client and is consumed by the next
 *   invocation — it is TRANSIENT (never persisted). An auto-approve toggle
 *   collapses both phases into one request.
 * - GENERATE: the shared loop with the teaching bar + layout guide + outline.
 * - CRITIQUE: ONE fresh-eyes pass with the deck passed in AS DATA; revisions go
 *   through the same ops tools. The whole pipeline reconciles once and stages ONE
 *   reviewable change-set (baseline = the doc before GENERATE).
 *
 * Lives separate from agentLoop.ts (which owns the loop primitives) to avoid an
 * import cycle: phases → agentLoop, never the reverse.
 */

import { createLesson, createModule } from "@/lib/course/factories";
import { applyCoursePatch } from "@/lib/course/patches";
import { findLesson } from "@/lib/course/queries";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import {
  logModelCall,
  loopContext,
  reconcileAndStage,
  runConversationLoop,
  type AgentRunParams,
  type LoopContext,
  type LoopContextSource,
  type LoopResult,
  type PhaseUsage,
} from "./agentLoop";
import { courseContextLines } from "./context";
import { computePlanCoverage, templateTextLength, THIN_SLIDE_CHARS } from "./generationState";
import { editHistoryPolicy } from "./historyPolicy";
import { saveUserMessage } from "./conversations";
import type { PlanOutline } from "./events";
import { classifyIntent } from "./intent";
import type { FinishReason, JsonSchema, ModelTurnResult } from "./modelClient";
import {
  coerceModuleOutline,
  coerceOutline,
  moduleLessonToOutline,
  MODULE_PLAN_SYSTEM_PROMPT,
  moduleOutlineResponseFormat,
  outlinePromptFragment,
  outlineResponseFormat,
  planLayoutCatalogText,
  PLAN_SYSTEM_PROMPT,
  validateModuleOutline,
  validateOutline,
  type LessonOutline,
  type ModuleOutline,
} from "./outline";

/** PLAN runs at high reasoning effort; give it headroom so reasoning tokens
 *  can't starve the structured JSON (the 16k default could be consumed entirely
 *  by reasoning → an empty/incomplete response → a silent "invalid" failure). */
const PLAN_MAX_OUTPUT_TOKENS = 32000;
import { loadCourseDoc } from "./serverPersistence";
import { AI_PHASE_MODELS } from "./modelConfig";

function addUsage(a: PhaseUsage, u: ModelTurnResult["usage"]): PhaseUsage {
  return {
    inputTokens: a.inputTokens + (u?.inputTokens ?? 0),
    outputTokens: a.outputTokens + (u?.outputTokens ?? 0),
    reasoningTokens: a.reasoningTokens + (u?.reasoningTokens ?? 0),
    cachedTokens: a.cachedTokens + (u?.cachedTokens ?? 0),
  };
}

const ZERO_USAGE: PhaseUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };

function nowIso(): string {
  return new Date().toISOString();
}

/** One structured instrumentation line per phase (grep `agent_phase`). `model`
 *  is the per-call model actually used (not the client default). `cachedTokens`
 *  is the prompt-cache hit (vs `inputTokens` total). */
function logPhase(
  c: LoopContext,
  phase: string,
  model: string,
  effort: string,
  usage: PhaseUsage,
  toolCalls: number,
  latencyMs: number,
  layered?: boolean,
  turns?: number
) {
  console.log(
    JSON.stringify({
      tag: "agent_phase",
      phase,
      model,
      effort,
      layered: layered ?? false,
      turns: turns ?? 0,
      toolCalls,
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      latencyMs,
      courseId: c.courseId,
      lessonId: c.lessonId,
    })
  );
}

/** A structured-output PLAN turn (effort high, large output budget) with ONE
 *  validate→repair re-ask. Suppresses the raw-JSON deltas; logs the `plan` phase.
 *  On failure logs the REAL cause (finishReason, tokens, raw head) and returns
 *  the last finishReason so the caller can give an accurate message. */
async function runStructuredPlan<T>(
  c: LoopContext,
  system: string,
  contextMessage: string,
  responseFormat: { name: string; schema: JsonSchema },
  validate: (raw: string) => { outline?: T; errors: string[] },
  userMessage: string
): Promise<{ outline: T | null; finishReason: FinishReason }> {
  c.emit({ type: "phase", phase: "plan" });
  const t0 = Date.now();
  let usage: PhaseUsage = ZERO_USAGE;
  const turn = { tools: [], effort: AI_PHASE_MODELS.plan.effort, model: AI_PHASE_MODELS.plan.model, responseFormat, maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, signal: c.signal };
  // Static system + tools cache; the variable course context rides in input.
  const ctx = { role: "developer" as const, content: contextMessage };

  // PLAN bypasses runConversationLoop, so count its calls against the shared run
  // budget + emit the same per-call line here (the 1–2 PLAN calls won't exhaust
  // the budget, but they must subtract from what GENERATE sees).
  if (c.callBudget) c.callBudget.remaining -= 1;
  let res = await c.model.runTurn({ system, input: [ctx, { role: "user", content: userMessage }], ...turn }, () => {});
  logModelCall("plan", AI_PHASE_MODELS.plan.model, 0, res.usage);
  usage = addUsage(usage, res.usage);
  let { outline, errors } = validate(res.text);

  if (!outline) {
    if (c.callBudget) c.callBudget.remaining -= 1;
    res = await c.model.runTurn(
      {
        system,
        input: [
          ctx,
          { role: "user", content: userMessage },
          { role: "assistant", content: res.text },
          { role: "user", content: `That outline was invalid: ${errors.join("; ")}. Return ONLY a corrected outline object.` },
        ],
        ...turn,
      },
      () => {}
    );
    logModelCall("plan", AI_PHASE_MODELS.plan.model, 1, res.usage);
    usage = addUsage(usage, res.usage);
    ({ outline, errors } = validate(res.text));
  }

  logPhase(c, "plan", AI_PHASE_MODELS.plan.model, AI_PHASE_MODELS.plan.effort, usage, 0, Date.now() - t0);
  if (!outline) {
    // Surface the REAL cause instead of a generic "invalid outline".
    console.log(
      JSON.stringify({
        tag: "agent_plan_fail",
        finishReason: res.finishReason,
        reasoningTokens: res.usage?.reasoningTokens,
        outputTokens: res.usage?.outputTokens,
        rawLength: res.text.length,
        rawHead: res.text.slice(0, 300),
        errors,
        courseId: c.courseId,
        lessonId: c.lessonId,
      })
    );
  }
  return { outline: outline ?? null, finishReason: res.finishReason };
}

/** A user-facing message for a PLAN that produced no usable outline, accurate to
 *  WHY (cut off vs service error vs malformed) rather than always "invalid". */
function planFailureMessage(finishReason: FinishReason, kind: "lesson" | "module"): string {
  const what = kind === "module" ? "module plan" : "lesson outline";
  if (finishReason === "incomplete") return `The ${what} got cut off before it finished — try again, or narrow the request.`;
  if (finishReason === "error") return `The AI service hit an error while planning the ${what} — please try again.`;
  return `I couldn't produce a valid ${what} — try rephrasing the request.`;
}

const CRITIQUE_SYSTEM_PROMPT = `You are reviewing a generated slide deck against a teaching standard. You did NOT write it — be a tough editor. You are given the deck as data and the lesson objective + approved outline.

FAIL-AND-REVISE on any of these (fix the worst first):
- SKELETAL slides: near-empty slots, or 3–6-word fragments standing in for an explanation. A body/definition/explanation slot must be 1–3 real sentences. Rewrite it to actually teach.
- LAYOUT MISMATCH: a slide whose layout doesn't match the plan's assigned layout WITHOUT a justified upgrade (an upgrade is a better-fitting STRUCTURED layout; a downgrade to plain/prose/a bare tip list is NOT allowed unless the plan chose it). Convert it to the right structured layout.
- NO WORKED EXAMPLE: a concept taught with zero concrete example. Add one (concept_example or a steps slide).
- SHOULD-BUILD-UP: a weight-bearing concept crammed into one slide that should be decomposed into building slides. Split it.
Also check: every term defined before use; concrete specifics present (costs, quantities, conditions, formulas), not vague; layout variety (not five identical slides); motivation→definition→mechanism→example→analysis progression.

Apply the highest-impact fixes via the STRUCTURED tools you have: set_structured_slide (rewrite a slide's content / convert its layout), add_structured_slide (insert a missing slide), set_text_style, add_sticker, and write_quiz for a knowledge check. (There is no flat-deck tool here.) Make ONE revision pass — do NOT loop. Keep rich text as structured data and respect slot limits.`;

/** Depth-floor observability: log how many of a lesson's structured slides came
 *  out skeletal (very little text). Modules run with no critique, so this is the
 *  signal that GENERATE under-filled. Non-blocking. */
function logThinSlides(c: LoopContext, doc: CourseDocument, lessonId: string) {
  const lesson = findLesson(doc, lessonId)?.lesson;
  if (!lesson) return;
  const slides = lesson.blocks
    .filter((b): b is SlideDeckBlock => b.type === "slide_deck")
    .flatMap((d) => d.slides);
  const structured = slides.filter((s) => s.template);
  const thin = structured.filter((s) => templateTextLength(s.template!.content) < THIN_SLIDE_CHARS).length;
  console.log(JSON.stringify({ tag: "agent_thin_slides", lessonId, structured: structured.length, thin, flat: slides.length - structured.length }));
}

/** Serialize the active lesson's slide deck(s) as lean JSON for CRITIQUE input
 *  (drops the heavy `ai`/`style` envelopes; keeps ids so edits can target). */
function serializeLessonDecks(doc: CourseDocument, lessonId: string): string {
  const lesson = findLesson(doc, lessonId)?.lesson;
  if (!lesson) return "(no lesson found)";
  const decks = lesson.blocks.filter((b): b is SlideDeckBlock => b.type === "slide_deck");
  if (!decks.length) return "(no slide deck was generated)";
  const lean = decks.map((d) => ({
    blockId: d.id,
    title: d.title,
    slides: d.slides.map((s) => ({
      slideId: s.id,
      layout: s.layout,
      ...(s.template ? { template: s.template } : { elements: s.elements }),
    })),
  }));
  return JSON.stringify(lean);
}

/** GENERATE one lesson's deck through the layered loop (effort medium). Mutates
 *  + returns the shared doc; finalize is the caller's job (deferFinalize). */
async function generateLesson(
  c: LoopContext,
  lessonId: string,
  doc: CourseDocument,
  baseline: CourseDocument,
  outline: LessonOutline,
  detail?: string
): Promise<LoopResult> {
  const lc: LoopContext = { ...c, lessonId };
  c.emit({ type: "phase", phase: "generate", detail });
  const t = Date.now();
  const r = await runConversationLoop(lc, doc, baseline, false, {
    effort: AI_PHASE_MODELS.generate.effort,
    model: AI_PHASE_MODELS.generate.model,
    layered: true,
    outline,
    deferFinalize: true,
    generateTools: true,
    callLabel: "generate",
  });
  logPhase(lc, "generate", AI_PHASE_MODELS.generate.model, AI_PHASE_MODELS.generate.effort, r.usage, r.toolCalls, Date.now() - t, true, r.turns);
  logThinSlides(lc, r.doc, lessonId);
  const coverage = computePlanCoverage(r.doc, lessonId, outline);
  console.log(JSON.stringify({ tag: "agent_plan_coverage", lessonId, ...coverage }));
  return r;
}

/** Single-lesson pipeline: GENERATE → (optional CRITIQUE) → one change-set.
 *  `startDoc` is the live doc; baseline is captured here. CRITIQUE is gated by
 *  `AI_PHASE_MODELS.critique.enabled` (OFF by default — testing/free tier): when
 *  disabled the deck ships straight from GENERATE with the SAME single reconcile +
 *  one reviewable change-set. PLAN + the user are the primary critics; AI review
 *  is a premium add-on. */
async function runGenerateThenCritique(c: LoopContext, startDoc: CourseDocument, outline: LessonOutline): Promise<void> {
  const baseline = structuredClone(startDoc);

  const gen = await generateLesson(c, c.lessonId, startDoc, baseline, outline);

  if (!AI_PHASE_MODELS.critique.enabled) {
    // Skip CRITIQUE — finalize from GENERATE (one reconcile, one change-set).
    c.emit({ type: "phase", phase: "critique_skipped", reason: "disabled_by_config" });
    if (gen.docMutated) await reconcileAndStage(c, gen.doc, baseline, gen.lastAssistantMessageId);
    c.emit({ type: "assistant_message", content: gen.assistantText });
    c.emit({ type: "done" });
    return;
  }

  // CRITIQUE — one bounded fresh-eyes pass, deck handed in as data.
  c.emit({ type: "phase", phase: "critique" });
  const tC = Date.now();
  const critiqueSystem = [
    CRITIQUE_SYSTEM_PROMPT,
    "",
    ...courseContextLines(gen.doc, c.lessonId),
    "",
    outlinePromptFragment(outline),
    "",
    "DECK UNDER REVIEW (as data — target edits by blockId/slideId):",
    serializeLessonDecks(gen.doc, c.lessonId),
  ].join("\n");
  const crit: LoopResult = await runConversationLoop(c, gen.doc, baseline, false, {
    effort: AI_PHASE_MODELS.critique.effort,
    model: AI_PHASE_MODELS.critique.model,
    maxTurns: 4,
    deferFinalize: true,
    systemOverride: critiqueSystem,
    generateTools: true,
    callLabel: "critique",
  });
  logPhase(c, "critique", AI_PHASE_MODELS.critique.model, AI_PHASE_MODELS.critique.effort, crit.usage, crit.toolCalls, Date.now() - tC, true, crit.turns);

  // Finalize ONCE: one reconcile + one change-set spanning generate + critique.
  const doc = crit.doc;
  const mutated = gen.docMutated || crit.docMutated;
  const lastMsgId = crit.lastAssistantMessageId ?? gen.lastAssistantMessageId;
  if (mutated) await reconcileAndStage(c, doc, baseline, lastMsgId);
  c.emit({ type: "assistant_message", content: crit.assistantText || gen.assistantText });
  c.emit({ type: "done" });
}

/** Module pipeline: create the module + its lessons, GENERATE each lesson's deck
 *  (layered, NO critique — a deliberate cost trade-off for big builds), then ONE
 *  reconcile + ONE change-set spanning the whole module. */
async function runGenerateModule(c: LoopContext, startDoc: CourseDocument, outline: ModuleOutline): Promise<void> {
  const baseline = structuredClone(startDoc);
  let doc = startDoc;

  // Create the module + lessons structurally (in-memory), capturing real ids.
  const mod = createModule(outline.moduleTitle, doc.modules.length);
  const addMod = applyCoursePatch(doc, { action: "ADD_MODULE", module: mod }, nowIso());
  if (!addMod.ok) {
    c.emit({ type: "error", message: `Couldn't create the module: ${addMod.error}` });
    c.emit({ type: "done" });
    return;
  }
  doc = addMod.doc;

  const lessonIds: string[] = [];
  for (let i = 0; i < outline.lessons.length; i++) {
    const l = outline.lessons[i];
    const lesson = createLesson(l.title, i);
    lesson.objective = l.objective;
    const res = applyCoursePatch(doc, { action: "ADD_LESSON", moduleId: mod.id, lesson }, nowIso());
    if (!res.ok) continue;
    doc = res.doc;
    lessonIds.push(lesson.id);
  }

  // GENERATE each lesson's deck (layered, no critique). Thread the shared doc.
  let mutated = false;
  let lastMsgId: string | null = null;
  const n = lessonIds.length;
  for (let i = 0; i < n; i++) {
    // The run's shared budget is spent — stop here rather than spawning a loop
    // per remaining lesson that would each just trip the guard + checkpoint.
    if (c.callBudget && c.callBudget.remaining <= 0) break;
    const l = outline.lessons[i];
    const r = await generateLesson(c, lessonIds[i], doc, baseline, moduleLessonToOutline(l), `${l.title} (${i + 1}/${n})`);
    doc = r.doc;
    mutated = mutated || r.docMutated;
    lastMsgId = r.lastAssistantMessageId ?? lastMsgId;
  }

  // Finalize ONCE across module creation + every lesson's deck.
  if (mutated || addMod.ok) await reconcileAndStage(c, doc, baseline, lastMsgId);
  c.emit({ type: "assistant_message", content: `Built "${outline.moduleTitle}" — ${n} lesson${n === 1 ? "" : "s"}, each with a deck. Review the changes when you're ready.` });
  c.emit({ type: "done" });
}

/** The lesson generate path: PLAN → (pause for approval | auto-approve → run). */
export async function runGenerateLessonTurn(
  p: AgentRunParams & { autoApprove?: boolean },
  preloaded?: CourseDocument
): Promise<void> {
  const c = loopContext(p);
  const doc = preloaded ?? (await loadCourseDoc(p.supabase, p.courseId));
  if (!doc) {
    c.emit({ type: "error", message: "Course not found or you don't have access." });
    c.emit({ type: "done" });
    return;
  }
  const system = [PLAN_SYSTEM_PROMPT, "", planLayoutCatalogText()].join("\n"); // static → cacheable
  const context = courseContextLines(doc, c.lessonId).join("\n"); // variable → input
  const { outline, finishReason } = await runStructuredPlan(c, system, context, outlineResponseFormat(), validateOutline, p.userMessage);
  if (!outline) {
    c.emit({ type: "error", message: planFailureMessage(finishReason, "lesson") });
    c.emit({ type: "done" });
    return;
  }
  if (p.autoApprove) {
    await runGenerateThenCritique(c, doc, outline);
  } else {
    c.emit({ type: "plan_outline", plan: { kind: "lesson", lessonId: p.lessonId, outline } });
    c.emit({ type: "done" });
  }
}

/** The module generate path: PLAN (module) → (pause for approval | auto-approve → run). */
export async function runGenerateModuleTurn(
  p: AgentRunParams & { autoApprove?: boolean },
  preloaded?: CourseDocument
): Promise<void> {
  const c = loopContext(p);
  const doc = preloaded ?? (await loadCourseDoc(p.supabase, p.courseId));
  if (!doc) {
    c.emit({ type: "error", message: "Course not found or you don't have access." });
    c.emit({ type: "done" });
    return;
  }
  const system = [MODULE_PLAN_SYSTEM_PROMPT, "", planLayoutCatalogText()].join("\n"); // static → cacheable
  const context = courseContextLines(doc, c.lessonId).join("\n"); // variable → input
  const { outline, finishReason } = await runStructuredPlan(c, system, context, moduleOutlineResponseFormat(), validateModuleOutline, p.userMessage);
  if (!outline) {
    c.emit({ type: "error", message: planFailureMessage(finishReason, "module") });
    c.emit({ type: "done" });
    return;
  }
  if (p.autoApprove) {
    await runGenerateModule(c, doc, outline);
  } else {
    c.emit({ type: "plan_outline", plan: { kind: "module", outline } });
    c.emit({ type: "done" });
  }
}

/** The route entrypoint: persist the user msg, classify, then branch to the
 *  module build, the single-lesson pipeline, or the single-turn edit loop. The
 *  edit loop is LAYERED (teaching bar + layout guide) so any content it creates
 *  still meets the bar — it just skips the plan gate + critique (stays fast). */
export async function runContentAgentTurn(p: AgentRunParams & { autoApprove?: boolean }): Promise<void> {
  await saveUserMessage(p.supabase, p.conversationId, p.courseId, p.userMessage);
  const doc = await loadCourseDoc(p.supabase, p.courseId);
  if (!doc) {
    p.emit({ type: "error", message: "Course not found or you don't have access." });
    p.emit({ type: "done" });
    return;
  }
  const lesson = findLesson(doc, p.lessonId)?.lesson;
  const hasDeck = !!lesson?.blocks.some((b) => b.type === "slide_deck");
  const mode = await classifyIntent(p.model, { hasDeck }, p.userMessage);

  if (mode === "generate_module") {
    await runGenerateModuleTurn(p, doc);
  } else if (mode === "generate_lesson") {
    await runGenerateLessonTurn(p, doc);
  } else {
    const c = loopContext(p);
    const t = Date.now();
    const r = await runConversationLoop(c, doc, structuredClone(doc), false, {
      effort: AI_PHASE_MODELS.edit.effort,
      model: AI_PHASE_MODELS.edit.model,
      layered: true,
      callLabel: "edit",
      historyPolicy: editHistoryPolicy(),
    });
    logPhase(c, "edit", AI_PHASE_MODELS.edit.model, AI_PHASE_MODELS.edit.effort, r.usage, r.toolCalls, Date.now() - t, true, r.turns);
  }
}

export interface GenerateResumeParams extends LoopContextSource {
  /** The approved plan, round-tripped from the client (re-validated here). */
  plan: unknown;
  decision: "approve" | "discard";
}

/** Invocation 2: the user approved (or discarded) the planned outline. On
 *  approve, re-validate the transient plan and run the matching pipeline
 *  (single lesson → generate+critique; module → generate every lesson). */
export async function resumeGeneratePlan(p: GenerateResumeParams): Promise<void> {
  const c = loopContext(p);
  if (p.decision === "discard") {
    c.emit({ type: "assistant_message", content: "Okay — I've set that plan aside. Tell me what to change and I'll re-plan." });
    c.emit({ type: "done" });
    return;
  }

  const plan = p.plan as Partial<PlanOutline> | null;
  const doc = await loadCourseDoc(p.supabase, p.courseId);
  if (!doc) {
    c.emit({ type: "error", message: "Course not found or you don't have access." });
    c.emit({ type: "done" });
    return;
  }

  if (plan?.kind === "module") {
    const { outline, errors } = coerceModuleOutline(plan.outline);
    if (!outline) {
      c.emit({ type: "error", message: `That module plan was invalid (${errors[0] ?? "unknown"}); please re-run the request.` });
      c.emit({ type: "done" });
      return;
    }
    await runGenerateModule(c, doc, outline);
    return;
  }

  const { outline, errors } = coerceOutline(plan?.kind === "lesson" ? plan.outline : undefined);
  if (!outline) {
    c.emit({ type: "error", message: `That plan outline was invalid (${errors[0] ?? "unknown"}); please re-run the request.` });
    c.emit({ type: "done" });
    return;
  }
  await runGenerateThenCritique(c, doc, outline);
}
