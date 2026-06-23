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

import { addBlockPatch } from "@/lib/course/commands";
import { createLesson, createModule } from "@/lib/course/factories";
import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import { findLesson } from "@/lib/course/queries";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import {
  logModelCall,
  loopContext,
  reconcileDoc,
  runConversationLoop,
  stageChangeSet,
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
import { lintLessonGeneration, type LintWarning } from "./lintGeneration";
import { runLightReview, shouldRunLightReview, type ReviewSuggestion } from "./lightReview";
import {
  AI_GENERATE_MAX_OUTPUT_TOKENS,
  AI_LESSON_PLAN_MAX_OUTPUT_TOKENS,
  AI_LESSON_RETRY_BACKOFF_MS,
  AI_LIGHT_REVIEW,
  AI_PHASE_MODELS,
  AI_PLAN_MAX_RETRIES,
  AI_PLAN_STREAMING,
  AI_PLAN_TIMEOUT_MS,
  AI_USE_BACKGROUND_FOR_PLANS,
  AI_VALIDATION,
} from "./modelConfig";
import type { FinishReason, JsonSchema, ModelErrorKind, ModelTurnResult, ReasoningEffort } from "./modelClient";
import {
  coerceModuleSkeleton,
  coerceOutline,
  ensureLessonArc,
  lessonBriefToPlanRequest,
  lessonDepthShortfall,
  MODULE_FALLBACK_SYSTEM_PROMPT,
  MODULE_SKELETON_SYSTEM_PROMPT,
  moduleFallbackResponseFormat,
  moduleSkeletonResponseFormat,
  outlinePromptFragment,
  outlineResponseFormat,
  planLayoutCatalogText,
  slideRequiresVisual,
  PLAN_SYSTEM_PROMPT,
  validateModuleFallback,
  validateModuleSkeleton,
  validateOutline,
  type LessonBrief,
  type LessonOutline,
  type ModuleSkeleton,
  type PlannedSlide,
} from "./outline";
import {
  hasModelRepairableFailure,
  placeholderRepairPatches,
  pruneEmptyDeckPatches,
  validateLessonGeneration,
  validationSummaryLine,
  type ValidationReport,
} from "./validation";

/** PLAN runs at high reasoning effort; give it headroom so reasoning tokens
 *  can't starve the structured JSON (the 16k default could be consumed entirely
 *  by reasoning → an empty/incomplete response → a silent "invalid" failure). */
const PLAN_MAX_OUTPUT_TOKENS = 32000;
import { loadCourseDoc } from "./serverPersistence";

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

/** What kind of plan a call is producing — distinguishes the compact module
 *  skeleton, its ultra-lean fallback, and the (rich) lesson plans in the logs. */
type PlanType = "lesson" | "lesson_rich" | "module_skeleton" | "module_fallback";

/** The OUTCOME category of a plan call — kept SEPARATE so a transport timeout is
 *  never logged/messaged as a JSON/schema problem (the core mis-report we're
 *  fixing). `ok` = a usable plan; the rest are failure categories. */
type PlanErrorType = ModelErrorKind | "schema_error" | "ok";

interface PlanCallOpts<T> {
  planType: PlanType;
  model: string;
  effort: ReasoningEffort;
  /** Optional depth/quality gate on a VALID outline → a re-ask reason, or null. */
  postValidate?: (outline: T) => string | null;
  /** Run in OpenAI background mode (poll instead of holding a long connection). */
  background?: boolean;
  /** Output-token budget for this plan call. Lesson plans pass a SMALL budget
   *  (structurally caps the reasoning spiral); the module skeleton keeps the
   *  larger default. Falls back to PLAN_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /** Per-lesson / fallback progress label for the `phase` event. */
  detail?: string;
}

interface PlanResult<T> {
  outline: T | null;
  finishReason: FinishReason;
  providerError?: string;
  errorType: PlanErrorType;
}

/**
 * A structured-output PLAN call (NON-STREAMING — a plan needs reliability, not
 * token streaming; optional background mode for long ones) with ONE validate→
 * repair / deepen re-ask. Cleanly separates failure modes: a TRANSPORT error
 * (timeout/connection — empty output) is NEVER parsed as "invalid JSON"; a model
 * that returned text but didn't validate is `schema_error`. Logs `agent_plan_request`
 * before the call and `agent_plan_fail` (with the error category) on failure.
 */
async function runStructuredPlan<T>(
  c: LoopContext,
  system: string,
  contextMessage: string,
  responseFormat: { name: string; schema: JsonSchema },
  validate: (raw: string) => { outline?: T; errors: string[] },
  userMessage: string,
  opts: PlanCallOpts<T>
): Promise<PlanResult<T>> {
  c.emit({ type: "phase", phase: "plan", detail: opts.detail });
  const t0 = Date.now();
  const ctx = { role: "developer" as const, content: contextMessage };
  const schemaChars = JSON.stringify(responseFormat.schema).length;
  const inputChars = system.length + contextMessage.length + userMessage.length;
  const planMaxOutputTokens = opts.maxOutputTokens ?? PLAN_MAX_OUTPUT_TOKENS;
  const turn = {
    tools: [],
    effort: opts.effort,
    model: opts.model,
    responseFormat,
    maxOutputTokens: planMaxOutputTokens,
    timeoutMs: AI_PLAN_TIMEOUT_MS,
    // STREAM (default): keeps the proxy connection active so an idle socket isn't
    // dropped mid-reasoning (the cause of every plan death in the logs). Background
    // mode, when enabled, still takes precedence in the provider.
    stream: AI_PLAN_STREAMING,
    background: opts.background,
    maxRetries: AI_PLAN_MAX_RETRIES, // don't retry a dead socket 5×
    signal: c.signal,
  };

  // Instrument BEFORE the call so a hang/timeout still leaves a record of WHAT was
  // attempted (model/effort/timeout/sizes/mode) — the diagnostic the old logs lacked.
  console.log(
    JSON.stringify({
      tag: "agent_plan_request",
      planType: opts.planType,
      model: opts.model,
      effort: opts.effort,
      timeoutMs: AI_PLAN_TIMEOUT_MS,
      approxInputChars: inputChars,
      approxSchemaChars: schemaChars,
      maxOutputTokens: planMaxOutputTokens,
      maxRetries: AI_PLAN_MAX_RETRIES,
      background: !!opts.background,
      streaming: AI_PLAN_STREAMING,
      courseId: c.courseId,
      lessonId: c.lessonId,
    })
  );

  let usage: PhaseUsage = ZERO_USAGE;
  let providerError: string | undefined;
  let providerErrorKind: ModelErrorKind | undefined;
  const onPlanEvent = (ev: { type: string; message?: string; kind?: ModelErrorKind }) => {
    if (ev.type === "error" && ev.message) {
      providerError = ev.message;
      providerErrorKind = ev.kind;
    }
  };

  if (c.callBudget) c.callBudget.remaining -= 1;
  let res = await c.model.runTurn({ system, input: [ctx, { role: "user", content: userMessage }], ...turn }, onPlanEvent);
  logModelCall(opts.planType, opts.model, 0, res.usage);
  usage = addUsage(usage, res.usage);

  // Parse ONLY when the call actually returned. A transport error → empty text;
  // running validate on "" yields a misleading "not valid JSON" — so skip it.
  let outline: T | undefined;
  let errors: string[] = [];
  if (res.finishReason !== "error") ({ outline, errors } = validate(res.text));

  // ONE re-ask — to fix invalid output OR deepen a thin valid plan. NEVER after a
  // transport error (it just burns a second timeout).
  const reask =
    res.finishReason === "error"
      ? null
      : !outline
        ? `That output was invalid: ${errors.join("; ")}. Return ONLY a corrected object.`
        : opts.postValidate
          ? opts.postValidate(outline)
          : null;
  if (reask) {
    const prev = outline;
    if (c.callBudget) c.callBudget.remaining -= 1;
    res = await c.model.runTurn(
      {
        system,
        input: [ctx, { role: "user", content: userMessage }, { role: "assistant", content: res.text }, { role: "user", content: reask }],
        ...turn,
      },
      onPlanEvent
    );
    logModelCall(opts.planType, opts.model, 1, res.usage);
    usage = addUsage(usage, res.usage);
    const r2 = res.finishReason !== "error" ? validate(res.text) : { outline: undefined, errors };
    outline = r2.outline ?? prev; // keep a previously-valid plan if the re-ask broke
    errors = r2.errors;
  }

  const latencyMs = Date.now() - t0;
  logPhase(c, "plan", opts.model, opts.effort, usage, 0, latencyMs);

  const errorType: PlanErrorType = outline
    ? "ok"
    : res.finishReason === "error"
      ? res.errorKind ?? providerErrorKind ?? "transport"
      : "schema_error";

  if (!outline) {
    console.log(
      JSON.stringify({
        tag: "agent_plan_fail",
        planType: opts.planType,
        errorType, // transport_timeout | model_error | transport | schema_error — SEPARATED
        finishReason: res.finishReason,
        providerError,
        latencyMs,
        rawLength: res.text.length,
        rawHead: res.text.slice(0, 200),
        // schemaErrors only meaningful for schema_error (NOT a transport timeout)
        schemaErrors: errorType === "schema_error" ? errors : undefined,
        courseId: c.courseId,
        lessonId: c.lessonId,
      })
    );
  }
  return { outline: outline ?? null, finishReason: res.finishReason, providerError, errorType };
}

/** A user-facing message for a failed PLAN, categorized by error type so a TIMEOUT
 *  reads differently from a malformed plan (and never as "invalid JSON"). */
function planFailureMessage(errorType: PlanErrorType, kind: "lesson" | "module", providerError?: string): string {
  const what = kind === "module" ? "module plan" : "lesson outline";
  if (errorType === "transport_timeout") {
    return kind === "module"
      ? "Module planning timed out before the model returned a plan. Try a smaller module request (fewer lessons), or break it into separate lessons."
      : `The ${what} timed out before the model returned anything — try again, or narrow the request.`;
  }
  if (errorType === "model_error" || errorType === "transport") {
    const reason = providerError ? ` (${providerError.slice(0, 160)})` : "";
    return `The AI service hit an error while planning the ${what}${reason} — please try again.`;
  }
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

/** The first slide_deck block id in a lesson, or null. */
function firstDeckId(doc: CourseDocument, lessonId: string): string | null {
  const lesson = findLesson(doc, lessonId)?.lesson;
  return lesson?.blocks.find((b) => b.type === "slide_deck")?.id ?? null;
}

/** Apply a list of patches to a doc in place-ish, returning the new doc + whether
 *  anything applied. (The pipeline mutates an in-memory doc; the loop owns the
 *  reconcile.) */
function applyAll(doc: CourseDocument, patches: CoursePatch[]): { doc: CourseDocument; applied: boolean } {
  let d = doc;
  let applied = false;
  for (const p of patches) {
    const r = applyCoursePatch(d, p, nowIso());
    if (r.ok) {
      d = r.doc;
      applied = true;
    }
  }
  return { doc: d, applied };
}

interface LessonGenResult extends LoopResult {
  /** The deck the model authored into (pre-created empty if the lesson had none). */
  deckBlockId: string | null;
  /** True if this call created the empty deck (a mutation even if the loop added nothing). */
  deckPreCreated: boolean;
}

/** Generous per-turn cap for a coverage-DRIVEN authoring loop, scaled to the plan.
 *  The driver stops the moment coverage is complete (or stalls via the no-progress
 *  guard), so this is only the runaway ceiling — a bigger plan gets more room. */
function coverageMaxTurns(plannedSlideCount: number): number {
  return Math.min(32, Math.max(16, plannedSlideCount + 8));
}

/** Per-turn cap for a coverage-driven REPAIR round, scaled to how much is still
 *  owed (a round that must rebuild 7 specs gets more room than one fixing 1). */
function repairMaxTurns(remainingSpecCount: number): number {
  return Math.min(24, Math.max(8, remainingSpecCount * 2 + 4));
}

/** GENERATE one lesson's deck through the layered loop (effort medium). PRE-CREATES
 *  an EMPTY deck if the lesson has none (so the model authors real structured slides
 *  into it and never seeds a "Section title" placeholder), then threads that
 *  deckBlockId into the loop. Mutates + returns the shared doc; finalize is the
 *  caller's job (deferFinalize). */
async function generateLesson(
  c: LoopContext,
  lessonId: string,
  doc: CourseDocument,
  outline: LessonOutline,
  detail?: string
): Promise<LessonGenResult> {
  const lc: LoopContext = { ...c, lessonId };

  let workingDoc = doc;
  let deckBlockId = firstDeckId(workingDoc, lessonId);
  let deckPreCreated = false;
  if (!deckBlockId) {
    const patch = addBlockPatch(lessonId, "slide_deck", undefined, { emptySlideDeck: true });
    const res = applyCoursePatch(workingDoc, patch, nowIso());
    if (res.ok && patch.action === "ADD_BLOCK") {
      workingDoc = res.doc;
      deckBlockId = patch.block.id;
      deckPreCreated = true;
    }
  }

  c.emit({ type: "phase", phase: "generate", detail });
  const t = Date.now();
  const r = await runConversationLoop(lc, workingDoc, workingDoc, false, {
    effort: AI_PHASE_MODELS.generate.effort,
    model: AI_PHASE_MODELS.generate.model,
    layered: true,
    outline,
    deckBlockId: deckBlockId ?? undefined,
    deferFinalize: true,
    generateTools: true,
    driveToCoverage: true,
    // SCOPED: build the input from system + the full plan + generation-state + this
    // run's tool I/O — never the conversation transcript (so the plan can't be lost).
    scopedInput: true,
    maxTurns: coverageMaxTurns(outline.slides.length),
    maxOutputTokens: AI_GENERATE_MAX_OUTPUT_TOKENS,
    callLabel: "generate",
  });
  logPhase(lc, "generate", AI_PHASE_MODELS.generate.model, AI_PHASE_MODELS.generate.effort, r.usage, r.toolCalls, Date.now() - t, true, r.turns);
  logThinSlides(lc, r.doc, lessonId);
  const coverage = computePlanCoverage(r.doc, lessonId, outline);
  console.log(JSON.stringify({ tag: "agent_plan_coverage", lessonId, ...coverage }));
  return { ...r, deckBlockId: firstDeckId(r.doc, lessonId) ?? deckBlockId, deckPreCreated };
}

/** A focused brief for ONE missing slide spec the repair pass must build. */
function renderSpecBrief(s: PlannedSlide): string {
  const cover = s.keyPoints.length ? ` cover: ${s.keyPoints.map((p) => `• ${p}`).join("  ")}` : "";
  const exact = s.notes ? ` exact: ${s.notes}` : "";
  const visual = slideRequiresVisual(s)
    ? ` VISUAL REQUIRED: add a ${s.visualIntent?.expectedVisualType ?? s.visualIntent?.role} with add_diagram${s.visualIntent?.mustBeAccurate ? " (use a templateId so it's accurate)" : ""}.`
    : "";
  return `  - [${s.id} · ${s.role} · layout=${s.layout}] ${s.title} — ${s.teachingGoal}.${cover}${exact}${visual}`;
}

/** The narrow REPAIR instruction: list ONLY the hard failures so the model fixes
 *  exactly those (and leaves correct slides alone). Appended to the context. */
function buildRepairInstruction(outline: LessonOutline, report: ValidationReport, deckBlockId: string | null): string {
  const byId = new Map(outline.slides.map((s) => [s.id, s]));
  const lines: string[] = [
    "REPAIR PASS — the generated lesson does NOT yet satisfy the approved plan. Fix ONLY the problems below; do NOT rewrite slides that are already correct.",
  ];
  if (report.missingSpecIds.length) {
    lines.push(
      `MISSING PLANNED SLIDES — build EACH of these into deck ${deckBlockId ?? "(the lesson's slide deck)"} with add_structured_slides_batch, stamping its slideSpecId:`
    );
    for (const id of report.missingSpecIds) {
      const s = byId.get(id);
      if (s) lines.push(renderSpecBrief(s));
    }
  }
  if (report.duplicateSpecIds.length) {
    lines.push(
      `DUPLICATE SLIDES: spec(s) ${report.duplicateSpecIds.join(", ")} appear on more than one slide. Keep the best one; repurpose the other to a missing spec.`
    );
  }
  if (report.requiredBlocksMissing.includes("quiz") && outline.quizPlan) {
    lines.push(
      `MISSING KNOWLEDGE CHECK: create it with write_quiz — ${outline.quizPlan.questionCount} question(s) on ${outline.quizPlan.targetSkills.map((t) => t.skill).join(", ")}.`
    );
  }
  if (report.requiredBlocksMissing.includes("homework") && outline.homeworkPlan) {
    lines.push(`MISSING PRACTICE: create it with write_homework — ${outline.homeworkPlan.exerciseCount} exercise(s).`);
  }
  if (report.missingRequiredVisualSpecIds.length) {
    lines.push(
      "MISSING REQUIRED VISUALS — these slides exist but the plan REQUIRED a visual they lack. Add the diagram with set_diagram (to convert the existing slide) or add_diagram, preferring a templateId so accuracy-critical diagrams are correct by construction:"
    );
    for (const id of report.missingRequiredVisualSpecIds) {
      const s = byId.get(id);
      if (s) lines.push(`  - [${s.id}] ${s.title}: ${s.visualIntent?.expectedVisualType ?? s.visualIntent?.role}${s.visualIntent?.reason ? ` — ${s.visualIntent.reason}` : ""}.`);
    }
  }
  lines.push("Build exactly what's listed, then stop.");
  return lines.join("\n");
}

interface RepairOutcome {
  doc: CourseDocument;
  mutated: boolean;
  lastMsgId: string | null;
  report: ValidationReport;
}

/**
 * VALIDATE → REPAIR for one lesson (the correctness gate that replaces critique).
 * Validates against the plan; deterministically strips placeholder/empty slides;
 * runs up to N targeted model-repair rounds for what only the model can fix
 * (missing planned slides, a missing required quiz/homework, duplicates),
 * re-validating each round. Emits calm progress + a final `validation` event, and
 * a `checkpoint` if the contract still isn't met (so a short deck is never
 * presented as complete). Returns the repaired doc — staging is the caller's job.
 */
async function validateAndRepairLesson(
  c: LoopContext,
  lessonId: string,
  doc: CourseDocument,
  outline: LessonOutline,
  opts: { deckBlockId: string | null; checkpointed: boolean; detail?: string }
): Promise<RepairOutcome> {
  const lc: LoopContext = { ...c, lessonId };
  let working = doc;
  let mutated = false;
  let lastMsgId: string | null = null;
  let deckBlockId = opts.deckBlockId;
  const budgetOut = () => !!c.callBudget && c.callBudget.remaining <= 0;

  c.emit({ type: "phase", phase: "validate", detail: opts.detail });
  let report = validateLessonGeneration(working, lessonId, outline, { checkpointed: opts.checkpointed });
  let placeholdersRemoved = 0;
  let repaired = false;
  // A user Stop (abort) ends repair promptly — no point spending passes that the
  // aborted signal will just break out of. Flush-on-exit still stages what's built.
  const stopRepair = () => budgetOut() || !!c.signal?.aborted;

  if (!report.ok) {
    // 1. DETERMINISTIC: strip placeholder + empty slides (and junk decks). No model.
    const det = placeholderRepairPatches(working, lessonId, report);
    if (det.length) {
      placeholdersRemoved = report.placeholderSlideIds.length + report.emptySlideIds.length;
      const r = applyAll(working, det);
      working = r.doc;
      mutated = mutated || r.applied;
      report = validateLessonGeneration(working, lessonId, outline, { checkpointed: opts.checkpointed });
    }

    // 2. TARGETED MODEL REPAIR for what's left, up to maxRepairPasses rounds.
    if (AI_VALIDATION.repairHardFailures && hasModelRepairableFailure(report)) {
      c.emit({
        type: "validation",
        ok: false,
        message: `${validationSummaryLine(report)} Repairing…`,
        missingSlides: report.missingSpecIds.length,
        placeholdersRemoved,
        repaired: false,
      });
      let pass = 0;
      while (!report.ok && hasModelRepairableFailure(report) && pass < AI_VALIDATION.maxRepairPasses && !stopRepair()) {
        // Ensure a deck exists to author into (deterministic repair may have dropped a junk one).
        deckBlockId = report.deckBlockId ?? deckBlockId ?? firstDeckId(working, lessonId);
        if (!deckBlockId) {
          const patch = addBlockPatch(lessonId, "slide_deck", undefined, { emptySlideDeck: true });
          const r = applyCoursePatch(working, patch, nowIso());
          if (r.ok && patch.action === "ADD_BLOCK") {
            working = r.doc;
            deckBlockId = patch.block.id;
            mutated = true;
          }
        }

        c.emit({ type: "phase", phase: "repair", detail: opts.detail });
        const t = Date.now();
        const rr = await runConversationLoop(lc, working, working, false, {
          effort: AI_PHASE_MODELS.repair.effort,
          model: AI_PHASE_MODELS.repair.model,
          layered: true,
          outline,
          deckBlockId: deckBlockId ?? undefined,
          extraInstruction: buildRepairInstruction(outline, report, deckBlockId),
          deferFinalize: true,
          generateTools: true,
          driveToCoverage: true,
          // SCOPED: same as GENERATE — system + plan + state + this run's I/O only.
          scopedInput: true,
          maxTurns: repairMaxTurns(report.missingSpecIds.length),
          maxOutputTokens: AI_GENERATE_MAX_OUTPUT_TOKENS,
          callLabel: "repair",
        });
        working = rr.doc;
        mutated = mutated || rr.docMutated;
        lastMsgId = rr.lastAssistantMessageId ?? lastMsgId;
        repaired = true;
        logPhase(lc, "repair", AI_PHASE_MODELS.repair.model, AI_PHASE_MODELS.repair.effort, rr.usage, rr.toolCalls, Date.now() - t, true, rr.turns);

        // The model could leave a stray placeholder (e.g. a second deck) — strip again.
        const interim = validateLessonGeneration(working, lessonId, outline, {});
        const det2 = placeholderRepairPatches(working, lessonId, interim);
        if (det2.length) {
          placeholdersRemoved += interim.placeholderSlideIds.length + interim.emptySlideIds.length;
          const r = applyAll(working, det2);
          working = r.doc;
          mutated = mutated || r.applied;
        }
        // Persist this repair round incrementally so the DB reflects each pass (live
        // render + never lose the round's work if the next pass dies / is aborted).
        if (rr.docMutated) await reconcileDoc(lc, working);
        // Re-check the contract after this repair round (its own validate phase).
        c.emit({ type: "phase", phase: "validate", detail: opts.detail });
        report = validateLessonGeneration(working, lessonId, outline, { checkpointed: opts.checkpointed || budgetOut() });
        pass++;
      }
    }
  }

  c.emit({
    type: "validation",
    ok: report.ok,
    message: report.ok ? "Final validation passed." : validationSummaryLine(report),
    missingSlides: report.missingSpecIds.length,
    placeholdersRemoved,
    repaired,
    incomplete: !report.ok,
  });
  if (!report.ok) {
    // Don't present an unmet contract as complete — say exactly what remains.
    const tail = report.budgetExhausted ? " (ran out of step budget — ask me to continue)." : ".";
    c.emit({
      type: "checkpoint",
      reason: `Couldn't fully satisfy the plan: ${validationSummaryLine(report)}${tail}`,
      completedSteps: report.coverage.coveredSlideSpecs,
    });
  }

  return { doc: working, mutated, lastMsgId, report };
}

/** Deterministic lint (always) + the OPTIONAL one-call light review (gated). Emits
 *  a single `quality_report` of soft, optional suggestions — never blocks staging. */
async function runLintAndReview(c: LoopContext, doc: CourseDocument, lessonId: string, outline: LessonOutline): Promise<void> {
  const warnings = lintLessonGeneration(doc, lessonId, outline);
  let suggestions: ReviewSuggestion[] = [];
  if (shouldRunLightReview(warnings) && (!c.callBudget || c.callBudget.remaining > 0)) {
    c.emit({ type: "phase", phase: "review" });
    const t = Date.now();
    suggestions = await runLightReview(c, doc, lessonId, outline, warnings);
    logPhase(c, "review", AI_LIGHT_REVIEW.model, AI_LIGHT_REVIEW.effort, ZERO_USAGE, 0, Date.now() - t);
  }
  if (warnings.length || suggestions.length) {
    c.emit({
      type: "quality_report",
      warnings: warnings.map((w) => ({ code: w.code, message: w.message, slideId: w.slideId })),
      suggestions,
    });
  }
}

/**
 * Single-lesson pipeline (the spec's shape): PLAN → GENERATE → VALIDATE/REPAIR →
 * (optional LIGHT REVIEW) → STAGE CHANGE-SET. The legacy CRITIQUE pass runs only
 * when explicitly enabled (off by default — superseded by validate/repair). The
 * whole run reconciles ONCE and stages one reviewable change-set.
 */
async function runLessonPipeline(c: LoopContext, startDoc: CourseDocument, outline: LessonOutline): Promise<void> {
  const baseline = structuredClone(startDoc);
  let doc = startDoc;
  let mutated = false;
  let lastMsgId: string | null = null;
  let finalized = false;

  // FLUSH-ON-EXIT: reconcile + stage whatever's built, on ANY termination (done /
  // abort / token cap / turn cap / no-progress / error). Idempotent (guarded) so a
  // clean finish and the finally block don't double-stage. Partial work is NEVER lost.
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    // Never stage a deck left with zero slides (generation produced nothing).
    const pruned = applyAll(doc, pruneEmptyDeckPatches(doc, c.lessonId));
    doc = pruned.doc;
    mutated = mutated || pruned.applied;
    if (mutated) {
      await reconcileDoc(c, doc);
      await stageChangeSet(c, doc, baseline, lastMsgId);
    }
  };

  try {
    const gen = await generateLesson(c, c.lessonId, startDoc, outline);
    doc = gen.doc;
    mutated = gen.docMutated || gen.deckPreCreated;
    lastMsgId = gen.lastAssistantMessageId;
    // Persist generation immediately so the DB has the deck before validate/repair
    // (so an abort/crash mid-repair still leaves the generated slides).
    if (mutated) await reconcileDoc(c, doc);

    // LEGACY CRITIQUE — off by default; validate/repair supersedes it.
    if (AI_PHASE_MODELS.critique.enabled) {
      const crit = await runLegacyCritique(c, doc, baseline, outline);
      doc = crit.doc;
      mutated = mutated || crit.docMutated;
      lastMsgId = crit.lastAssistantMessageId ?? lastMsgId;
    }

    // VALIDATE / REPAIR — the correctness gate (on by default).
    if (AI_VALIDATION.validateGeneration) {
      const vr = await validateAndRepairLesson(c, c.lessonId, doc, outline, {
        deckBlockId: gen.deckBlockId,
        checkpointed: gen.checkpointed,
      });
      doc = vr.doc;
      mutated = mutated || vr.mutated;
      lastMsgId = vr.lastMsgId ?? lastMsgId;
    }

    await finalize(); // STAGE once on the happy path.

    // OPTIONAL light review (soft suggestions) — after staging, never blocking.
    await runLintAndReview(c, doc, c.lessonId, outline);

    c.emit({ type: "assistant_message", content: gen.assistantText });
    c.emit({ type: "done" });
  } finally {
    await finalize(); // flush partial work on an abort / thrown error.
  }
}

/** The legacy CRITIQUE pass (deck-as-data, one bounded edit pass). Only invoked
 *  when AI_CRITIQUE_ENABLED — kept for parity; the default path uses validate/repair. */
async function runLegacyCritique(
  c: LoopContext,
  doc: CourseDocument,
  baseline: CourseDocument,
  outline: LessonOutline
): Promise<LoopResult> {
  c.emit({ type: "phase", phase: "critique" });
  const tC = Date.now();
  const critiqueSystem = [
    CRITIQUE_SYSTEM_PROMPT,
    "",
    ...courseContextLines(doc, c.lessonId),
    "",
    outlinePromptFragment(outline),
    "",
    "DECK UNDER REVIEW (as data — target edits by blockId/slideId):",
    serializeLessonDecks(doc, c.lessonId),
  ].join("\n");
  const crit = await runConversationLoop(c, doc, baseline, false, {
    effort: AI_PHASE_MODELS.critique.effort,
    model: AI_PHASE_MODELS.critique.model,
    maxTurns: 4,
    deferFinalize: true,
    systemOverride: critiqueSystem,
    generateTools: true,
    callLabel: "critique",
  });
  logPhase(c, "critique", AI_PHASE_MODELS.critique.model, AI_PHASE_MODELS.critique.effort, crit.usage, crit.toolCalls, Date.now() - tC, true, crit.turns);
  return crit;
}

/**
 * Plan the COMPACT module SKELETON (lean schema, low effort, non-streaming). If it
 * times out / transport-fails, retry ONCE with the ULTRA-LEAN fallback (always in
 * background mode — the held connection is exactly what just dropped). A schema
 * error is NOT retried (the model answered, just malformed). The skeleton is the
 * approval artifact; each lesson's RICH contract is planned LAZILY at gen time.
 */
async function runModuleSkeletonPlan(
  c: LoopContext,
  doc: CourseDocument,
  userMessage: string
): Promise<{ skeleton: ModuleSkeleton | null; errorType: PlanErrorType; providerError?: string }> {
  const context = courseContextLines(doc, c.lessonId).join("\n");
  const skeletonSystem = [MODULE_SKELETON_SYSTEM_PROMPT, "", planLayoutCatalogText()].join("\n");

  const primary = await runStructuredPlan<ModuleSkeleton>(
    c,
    skeletonSystem,
    context,
    moduleSkeletonResponseFormat(),
    (raw) => { const r = validateModuleSkeleton(raw); return { outline: r.skeleton, errors: r.errors }; },
    userMessage,
    {
      planType: "module_skeleton",
      model: AI_PHASE_MODELS.modulePlan.model,
      effort: AI_PHASE_MODELS.modulePlan.effort,
      background: AI_USE_BACKGROUND_FOR_PLANS,
    }
  );
  if (primary.outline) return { skeleton: primary.outline, errorType: "ok", providerError: primary.providerError };

  // Only fall back on a TRANSPORT failure (timeout/connection) — a schema_error
  // means the model answered but malformed, and a smaller schema won't help.
  const transport = primary.errorType === "transport_timeout" || primary.errorType === "transport";
  if (!transport) return { skeleton: null, errorType: primary.errorType, providerError: primary.providerError };

  const fallback = await runStructuredPlan<ModuleSkeleton>(
    c,
    MODULE_FALLBACK_SYSTEM_PROMPT,
    context,
    moduleFallbackResponseFormat(),
    (raw) => { const r = validateModuleFallback(raw); return { outline: r.skeleton, errors: r.errors }; },
    userMessage,
    {
      planType: "module_fallback",
      model: AI_PHASE_MODELS.modulePlan.model,
      effort: "low",
      background: true, // the held connection just timed out — poll instead
      detail: "quick plan",
    }
  );
  if (fallback.outline) return { skeleton: fallback.outline, errorType: "ok", providerError: fallback.providerError };
  return { skeleton: null, errorType: fallback.errorType, providerError: fallback.providerError ?? primary.providerError };
}

/** Plan ONE lesson's RICH contract lazily (the full lesson PLAN, seeded from the
 *  brief). Single lesson → small + fast (medium effort, bounded output budget). A
 *  transport failure here is surfaced via `errorType` so the module loop can retry
 *  the lesson once before skipping it (resumability). */
async function runRichLessonPlan(
  c: LoopContext,
  lessonId: string,
  brief: LessonBrief,
  moduleTitle: string,
  doc: CourseDocument,
  detail: string
): Promise<{ outline: LessonOutline | null; errorType: PlanErrorType }> {
  const lc: LoopContext = { ...c, lessonId };
  const system = [PLAN_SYSTEM_PROMPT, "", planLayoutCatalogText()].join("\n");
  const context = courseContextLines(doc, lessonId).join("\n");
  const r = await runStructuredPlan<LessonOutline>(lc, system, context, outlineResponseFormat(), validateOutline, lessonBriefToPlanRequest(brief, moduleTitle), {
    planType: "lesson_rich",
    model: AI_PHASE_MODELS.plan.model,
    effort: AI_PHASE_MODELS.plan.effort,
    maxOutputTokens: AI_LESSON_PLAN_MAX_OUTPUT_TOKENS,
    detail,
    // No depth-floor re-ask — the brief's slide range already sets the size, and a
    // second call per lesson would multiply latency across the module.
  });
  // Guarantee the titled-opener + recap-closer arc before generation.
  return { outline: r.outline ? ensureLessonArc(r.outline) : null, errorType: r.errorType };
}

/** True for a TRANSPORT failure category (timeout / connection drop) — the ONLY
 *  kind the module loop retries a lesson for (a schema/model error won't fix on a
 *  blind retry). */
function isTransportError(errorType: PlanErrorType): boolean {
  return errorType === "transport_timeout" || errorType === "transport";
}

/** Resolve the lesson plan after the SDK abort, then sleep (abortable). */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Plan one lesson's rich contract, retrying ONCE with backoff on a transport
 *  failure (a transient proxy blip shouldn't cost the whole lesson). Returns null
 *  only after the retry also fails (or on a non-transport error) → skip + surface. */
async function runRichLessonPlanResilient(
  c: LoopContext,
  lessonId: string,
  brief: LessonBrief,
  moduleTitle: string,
  doc: CourseDocument,
  detail: string
): Promise<LessonOutline | null> {
  const first = await runRichLessonPlan(c, lessonId, brief, moduleTitle, doc, detail);
  if (first.outline) return first.outline;
  if (!isTransportError(first.errorType) || c.signal?.aborted) return null;
  console.log(JSON.stringify({ tag: "agent_lesson_retry", lessonId, brief: brief.title, errorType: first.errorType }));
  await delay(AI_LESSON_RETRY_BACKOFF_MS, c.signal);
  if (c.signal?.aborted) return null;
  const second = await runRichLessonPlan(c, lessonId, brief, moduleTitle, doc, `${detail} — retry`);
  return second.outline;
}

/**
 * Module pipeline (lazy): create the module + lessons from the approved SKELETON,
 * then for EACH lesson — RICH lesson plan → GENERATE → VALIDATE/REPAIR — so no
 * single call has to plan the whole module. A lesson whose rich plan fails is
 * SKIPPED and reported; the rest still build. ONE reconcile + ONE change-set;
 * lint aggregated; a checkpoint lists any lessons still needing content.
 */
async function runGenerateModule(c: LoopContext, startDoc: CourseDocument, skeleton: ModuleSkeleton): Promise<void> {
  let doc = startDoc;

  const mod = createModule(skeleton.moduleTitle, doc.modules.length);
  const addMod = applyCoursePatch(doc, { action: "ADD_MODULE", module: mod }, nowIso());
  if (!addMod.ok) {
    c.emit({ type: "error", message: `Couldn't create the module: ${addMod.error}` });
    c.emit({ type: "done" });
    return;
  }
  doc = addMod.doc;

  // Create lessons up front from the briefs (title + objective); content is lazy.
  const lessons: { id: string; brief: LessonBrief }[] = [];
  for (let i = 0; i < skeleton.lessons.length; i++) {
    const brief = skeleton.lessons[i];
    const lesson = createLesson(brief.title, i);
    lesson.objective = brief.objective;
    const res = applyCoursePatch(doc, { action: "ADD_LESSON", moduleId: mod.id, lesson }, nowIso());
    if (!res.ok) continue;
    doc = res.doc;
    lessons.push({ id: lesson.id, brief });
  }

  // Persist the module + lesson SCAFFOLD immediately, so the module exists in the
  // DB the moment it's planned — even if every lesson's content later fails/aborts.
  // (This is the core fix for "the run spun for 10 min and the module has no data".)
  await reconcileDoc(c, doc);

  const baseline = structuredClone(doc); // the ONE change-set diffs against the scaffold
  let lastMsgId: string | null = null;
  const allWarnings: LintWarning[] = [];
  const skipped: string[] = [];
  const n = lessons.length;
  let built = 0;
  let finalized = false;

  // FLUSH-ON-EXIT: persist + stage everything built, as ONE change-set, on ANY exit
  // (completion / abort / budget / turn cap / error). Guarded so the happy path and
  // the `finally` don't double-stage. Each lesson is ALSO reconciled to the DB as it
  // completes (above), so a hard crash still leaves the built lessons persisted.
  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    for (const { id } of lessons) {
      const pr = applyAll(doc, pruneEmptyDeckPatches(doc, id));
      doc = pr.doc;
    }
    await reconcileDoc(c, doc);
    await stageChangeSet(c, doc, baseline, lastMsgId);
  };

  try {
    for (let i = 0; i < n; i++) {
      // User stopped (abort) or out of run budget — record the rest + stop. Flush
      // (in `finally`) still persists + stages everything built so far.
      if (c.signal?.aborted || (c.callBudget && c.callBudget.remaining <= 0)) {
        skipped.push(...lessons.slice(i).map((l) => l.brief.title));
        break;
      }
      const { id, brief } = lessons[i];
      const detail = `${brief.title} (${i + 1}/${n})`;

      // 1. RICH per-lesson plan (lazy), retried ONCE with backoff on a transport
      //    failure. Only after the retry also fails is the lesson skipped + surfaced
      //    — a single lesson's death never kills the module (prior lessons are
      //    already flushed; the remaining ones still build).
      const outline = await runRichLessonPlanResilient(c, id, brief, skeleton.moduleTitle, doc, detail);
      if (!outline) {
        skipped.push(brief.title);
        continue;
      }

      // 2. GENERATE → 3. VALIDATE/REPAIR.
      const gen = await generateLesson(c, id, doc, outline, detail);
      doc = gen.doc;
      lastMsgId = gen.lastAssistantMessageId ?? lastMsgId;

      if (AI_VALIDATION.validateGeneration) {
        const vr = await validateAndRepairLesson(c, id, doc, outline, {
          deckBlockId: gen.deckBlockId,
          checkpointed: gen.checkpointed,
          detail,
        });
        doc = vr.doc;
        lastMsgId = vr.lastMsgId ?? lastMsgId;
      }
      const pruned = applyAll(doc, pruneEmptyDeckPatches(doc, id));
      doc = pruned.doc;
      allWarnings.push(...lintLessonGeneration(doc, id, outline).map((w) => ({ ...w, message: `${brief.title}: ${w.message}` })));
      built++;
      // Persist this lesson's content now so it survives a later abort/crash mid-module.
      await reconcileDoc(c, doc);
    }
    await finalize(); // STAGE once on the happy path.
  } finally {
    await finalize(); // flush-on-exit (abort / thrown error)
  }

  if (allWarnings.length) {
    c.emit({
      type: "quality_report",
      warnings: allWarnings.map((w) => ({ code: w.code, message: w.message, slideId: w.slideId })),
      suggestions: [],
    });
  }

  if (skipped.length) {
    c.emit({
      type: "checkpoint",
      reason: `Built ${built} of ${n} lesson${n === 1 ? "" : "s"} in "${skeleton.moduleTitle}". Still need content: ${skipped.join(", ")}. Ask me to continue and I'll finish them.`,
      completedSteps: built,
    });
  }
  c.emit({
    type: "assistant_message",
    content: `Built "${skeleton.moduleTitle}" — ${built} of ${n} lesson${n === 1 ? "" : "s"}${skipped.length ? ` (${skipped.length} still to do)` : ""}. Review the changes when you're ready.`,
  });
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
  // The depth floor: a normal (non-micro) lesson that came back too thin gets ONE
  // re-ask to deepen it — the PLAN-time half of the 3-slide fix.
  const { outline, errorType, providerError } = await runStructuredPlan(c, system, context, outlineResponseFormat(), validateOutline, p.userMessage, {
    planType: "lesson",
    model: AI_PHASE_MODELS.plan.model,
    effort: AI_PHASE_MODELS.plan.effort,
    maxOutputTokens: AI_LESSON_PLAN_MAX_OUTPUT_TOKENS,
    postValidate: lessonDepthShortfall,
  });
  if (!outline) {
    c.emit({ type: "error", message: planFailureMessage(errorType, "lesson", providerError) });
    c.emit({ type: "done" });
    return;
  }
  // Guarantee the titled-opener + recap-closer arc (post depth-floor) before the
  // user approves, so the plan they see — and the deck built — opens + closes right.
  const arced = ensureLessonArc(outline);
  if (p.autoApprove) {
    await runLessonPipeline(c, doc, arced);
  } else {
    c.emit({ type: "plan_outline", plan: { kind: "lesson", lessonId: p.lessonId, outline: arced } });
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
  // FIRST call = the compact skeleton (with an ultra-lean fallback on timeout).
  // The rich per-lesson contracts are planned LAZILY, after approval, per lesson.
  const { skeleton, errorType, providerError } = await runModuleSkeletonPlan(c, doc, p.userMessage);
  if (!skeleton) {
    c.emit({ type: "error", message: planFailureMessage(errorType, "module", providerError) });
    c.emit({ type: "done" });
    return;
  }
  if (p.autoApprove) {
    await runGenerateModule(c, doc, skeleton);
  } else {
    c.emit({ type: "plan_outline", plan: { kind: "module", skeleton } });
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
    const { skeleton, errors } = coerceModuleSkeleton(plan.skeleton);
    if (!skeleton) {
      c.emit({ type: "error", message: `That module plan was invalid (${errors[0] ?? "unknown"}); please re-run the request.` });
      c.emit({ type: "done" });
      return;
    }
    await runGenerateModule(c, doc, skeleton);
    return;
  }

  const { outline, errors } = coerceOutline(plan?.kind === "lesson" ? plan.outline : undefined);
  if (!outline) {
    c.emit({ type: "error", message: `That plan outline was invalid (${errors[0] ?? "unknown"}); please re-run the request.` });
    c.emit({ type: "done" });
    return;
  }
  // Idempotent — the approved outline already carries the arc, but guarantee it.
  await runLessonPipeline(c, doc, ensureLessonArc(outline));
}
