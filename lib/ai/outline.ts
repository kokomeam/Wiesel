/**
 * The PLAN phase's artifact — a lesson TEACHING CONTRACT.
 *
 * The agent plans before it writes: a structured-output turn (json_schema, high
 * effort) produces an objective + target student + teaching arc + pedagogical
 * SEGMENTS, each with slide specs, plus optional quiz/homework plans. It is
 * surfaced for approval, then fed into GENERATE as the authoring spec. The
 * outline is TRANSIENT — it round-trips client→server for the run and is never
 * persisted (no course.plan growth, no migration).
 *
 * Design: the MODEL emits a nested plan with NO slide ids and NO segment→slide
 * back-references — it only tags each slide with its `segmentId`. `coerceOutline`
 * deterministically assigns stable slide ids (`s1`, `s2`, …) and derives each
 * segment's `slideSpecIds`, so the contract is robust (the LLM can't desync ids)
 * and idempotent (re-coercing the round-tripped flat form is a no-op). GENERATE
 * stamps each built slide with its spec id (`slide.ai.specId`) so plan coverage
 * is exact.
 */

import { z } from "zod";
import { VISUAL_ROLES, type VisualPlacement, type VisualPriority, type VisualRole } from "@/lib/course/diagram/types";
import { STRUCTURED_LAYOUT_IDS, structuredLayoutCatalog } from "@/lib/course/slide/structuredLayouts";
import { toStrictJsonSchema } from "./schema";
import { AI_LESSON_FLOORS } from "./modelConfig";
import type { JsonSchema } from "./modelClient";

/** `none` + every visual role — the planner's per-slide visual decision. */
export const VISUAL_INTENT_ROLES = ["none", ...VISUAL_ROLES] as const;
const VISUAL_PLACEMENTS = ["left", "right", "center", "full_width", "background", "inline"] as const;
const VISUAL_PRIORITIES = ["required", "recommended", "optional"] as const;

/** Allowed outline layouts = ALL structured layouts (incl. `prose`, the
 *  deliberate plain teaching slide). No bare "text" fallback. */
export const OUTLINE_LAYOUTS = [...STRUCTURED_LAYOUT_IDS] as [string, ...string[]];

export const OUTLINE_DEPTHS = ["motivation", "definition", "mechanism", "example", "analysis"] as const;

/** The pedagogical ROLE a single slide plays. Drives the deepening checklist (a
 *  normal lesson should carry a worked_example + a common_mistake + a
 *  conceptual_check + a recap) and lets the linter check a slide does its job
 *  (a worked_example slide must carry a concrete example; a code_walkthrough must
 *  carry code). */
export const SLIDE_ROLES = [
  "hook",
  "concept_intro",
  "definition",
  "worked_example",
  "code_walkthrough",
  "visual_model",
  "comparison",
  "common_mistake",
  "edge_case",
  "conceptual_check",
  "mini_practice",
  "recap",
  "transition",
] as const;

/** Whether a slide is essential to the objective (`core`) or deepens it
 *  (`enrichment` — a worked example, a check, an edge case, practice). The
 *  planner marks each slide so a thin lesson can be deepened with enrichment
 *  rather than padded with filler. */
export const SLIDE_KINDS = ["core", "enrichment"] as const;

/** Pedagogical role of a segment (1–3 slides that teach one beat together). */
export const SEGMENT_PURPOSES = [
  "hook",
  "concept_intro",
  "worked_example",
  "guided_practice",
  "common_mistakes",
  "recap",
  "assessment",
] as const;

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

/** Element types a slide MUST contain (a check, not a layout). */
export const REQUIRED_ELEMENTS = ["heading", "bullets", "image", "callout", "code", "diagram", "example"] as const;

/* Slide / array COUNT caps. The PLAN's spec list is the real length target — the
 * prompt guidance (6–14 slides / 3–7 lessons) sets the SHAPE; these are only the
 * runaway SAFETY RAILS (a model emitting hundreds), set far above any real plan so
 * a legitimately long lesson/module is NEVER truncated. Token budget + the per-turn
 * cap are the operative limits, not these. */
export const MAX_LESSON_SLIDES = 40;
export const MAX_LESSON_SEGMENTS = 16;
export const MAX_MODULE_LESSONS = 20;

/* ─────────────────────── Model-facing schema (PLAN output) ─────────────────
 * Counts/lengths are stripped by toStrictJsonSchema (strict mode), so floors/
 * ceilings live in `.describe()` + the prompt and are clamped in coerce. */

const TeachingArcSchema = z.object({
  hook: z.string().describe("The opening that motivates the lesson — why a learner should care."),
  coreConcepts: z.array(z.string()).describe("The 1–4 load-bearing ideas the lesson teaches."),
  workedExamples: z.array(z.string()).describe("The concrete example(s) the lesson works through."),
  commonMisconceptions: z.array(z.string()).describe("Mistakes/misconceptions to pre-empt."),
  recapGoal: z.string().describe("What the closing recap must consolidate."),
});

/** Structured visual intent (spec §2): whether THIS slide needs a visual, what
 *  kind, why, where, and how precise it must be. Most slides need none. */
const VisualIntentSchema = z.object({
  required: z.boolean().describe("True when the slide genuinely needs its visual to teach (the structure/process it is about). Use priority='recommended' generously for visuals that clearly help but aren't essential."),
  role: z.enum(VISUAL_INTENT_ROLES).describe("The kind of visual the slide needs, or 'none' if it genuinely needs none."),
  reason: z.string().nullable().describe("Why a visual helps here — the teaching it enables (or null)."),
  expectedVisualType: z.string().nullable().describe("The concrete visual, e.g. 'supply & demand equilibrium graph', 'binary-search array', 'a historical scene of the signing' (or null)."),
  placement: z.enum(VISUAL_PLACEMENTS).nullable().describe("Where it sits on the slide (or null = let the layout decide)."),
  priority: z.enum(VISUAL_PRIORITIES).nullable().describe("'required' (the slide needs it), 'recommended' (clearly helps — use generously), or 'optional'."),
  mustBeAccurate: z.boolean().nullable().describe("True when label/number/shape accuracy is correctness-critical (a graph, a search interval, a weighted graph) — forces a programmatic diagram over an illustration."),
});

// CONTENT-FIRST ORDER (Method 1): the model finalizes the slide's POINTS first,
// then picks the `layout` that fits THOSE points (and splits if they overflow one
// card). The field order mirrors that reasoning — keyPoints precede layout.
const SlideSpecSchema = z.object({
  segmentId: z.string().describe("The id of the segment this slide belongs to (must match a segment.id)."),
  title: z.string().describe("The slide's working title. For a CONTINUATION slide, this is the parent's title + ' (cont.)'."),
  teachingGoal: z.string().describe("The single thing a learner should understand after this slide."),
  role: z.enum(SLIDE_ROLES).describe("The pedagogical role this slide plays (hook / concept_intro / definition / worked_example / code_walkthrough / visual_model / comparison / common_mistake / edge_case / conceptual_check / mini_practice / recap / transition)."),
  kind: z.enum(SLIDE_KINDS).describe("'core' = essential to the objective; 'enrichment' = a worked example / check / edge case / practice that deepens it."),
  keyPoints: z
    .array(z.string())
    .describe("FINALIZE THIS FIRST — the slide's actual content: the real points / claims / worked-example steps / definition it will make, each a full clause (NOT a title). The layout is chosen to fit THESE. A continuation slide must NOT repeat any of its parent's points. Aim 2–5; if more would genuinely overflow one card, SPLIT into another slide instead."),
  layout: z.enum(OUTLINE_LAYOUTS).describe("Chosen AFTER the points, to FIT them: the structured layout whose shape holds this slide's keyPoints well (e.g. a definition → key_concept; 2–3 compared options → comparison_columns; a sequence → process_steps; key numbers → metrics_overview; a plain explanation → prose). Vary the layout across the deck — don't default every slide to the same one."),
  depth: z.enum(OUTLINE_DEPTHS).describe("Where this slide sits in the learning arc."),
  continuationOf: z
    .string()
    .nullable()
    .describe("If this slide CONTINUES a previous one — the SAME single idea overflowing one card — put the EXACT title of that parent slide here; else null. A continuation carries the parent's heading + ' (cont.)', adds a 'continuing from …' cue, and must NOT repeat the parent's points. When the overflowing points instead form TWO distinct sub-ideas, do a SUB-TOPIC split: two slides with distinct descriptive titles (e.g. 'Causes of X' / 'Effects of X'), both continuationOf=null. Prefer a sub-topic split over a bare continuation when the points naturally group."),
  notes: z.string().describe("Load-bearing specifics to get exactly right (a runtime O(log n), a quantity, a formula, exact conditions, term(s) to define)."),
  visualIntent: VisualIntentSchema.nullable().describe("Whether this slide needs a visual, and what kind — see the VISUALS rules. Default to required=false / role='none' when no visual materially helps."),
  requiredElements: z.array(z.enum(REQUIRED_ELEMENTS)).nullable().describe("Elements this slide MUST contain (else null)."),
  speakerNotesGoal: z.string().describe("What the speaker notes for this slide should cover (the spoken explanation behind the slide)."),
});

const SegmentSchema = z.object({
  id: z.string().describe("A short stable id for this segment (e.g. 'hook', 'concept', 'practice'). Slides reference it via segmentId."),
  name: z.string().describe("A human label for the segment."),
  purpose: z.enum(SEGMENT_PURPOSES).describe("The pedagogical role of this segment."),
  targetSlideCount: z.number().int().describe("How many slides this segment should contain (1–3 ideal)."),
});

const QuizPlanSchema = z.object({
  questionCount: z.number().int().describe("How many knowledge-check questions (typically 3–5)."),
  targetSkills: z
    .array(z.object({ skill: z.string(), difficulty: z.enum(DIFFICULTIES) }))
    .describe("The skills each question checks, with difficulty."),
});

const HomeworkPlanSchema = z.object({
  exerciseCount: z.number().int().describe("How many practice exercises."),
  targetSkills: z.array(z.string()).describe("The skills the homework practices."),
  difficulty: z.enum(DIFFICULTIES).describe("Overall difficulty."),
});

/** The PLAN structured-output schema (what the model returns). */
export const LessonOutlineSchema = z.object({
  objective: z.string().describe("The lesson's single learning objective."),
  targetStudent: z.string().describe("Who this lesson is for + what they already know."),
  estimatedMinutes: z.number().int().describe("Rough minutes to complete the lesson."),
  microLesson: z
    .boolean()
    .describe(
      "TRUE only if the user EXPLICITLY asked for a short / micro / quick lesson (3–4 slides). Otherwise FALSE — a normal instructional lesson plans 6+ slides (technical lessons 7+)."
    ),
  teachingArc: TeachingArcSchema,
  segments: z.array(SegmentSchema).describe("Ordered pedagogical segments (2–6); each groups 1–3 slides."),
  slides: z.array(SlideSpecSchema).describe("Ordered slide specs; each tagged with its segmentId. A normal lesson has 6–10, technical 7–12, complex 9–14. Only 3–4 if microLesson is true."),
  quizPlan: QuizPlanSchema.nullable().describe("A knowledge-check plan if the lesson should have one (else null)."),
  homeworkPlan: HomeworkPlanSchema.nullable().describe("A homework plan if applicable (else null)."),
});

/* ──────────────────────────── Internal (coerced) types ─────────────────────
 * GENERATE / GenerationState / coverage consume THIS shape: slides carry an
 * assigned `id`, segments carry derived `slideSpecIds`. */

/** The planner's per-slide visual decision (the contract GENERATE + validation
 *  read). `role: "none"` / `required: false` ⇒ no visual. */
export interface PlannedVisualIntent {
  required: boolean;
  role: VisualRole | "none";
  reason?: string;
  expectedVisualType?: string;
  placement?: VisualPlacement;
  priority?: VisualPriority;
  mustBeAccurate?: boolean;
}

export interface PlannedSlide {
  id: string;
  segmentId: string;
  title: string;
  teachingGoal: string;
  role: (typeof SLIDE_ROLES)[number];
  kind: (typeof SLIDE_KINDS)[number];
  layout: string;
  depth: (typeof OUTLINE_DEPTHS)[number];
  keyPoints: string[];
  notes: string;
  /** Set on a CONTINUATION slide — the title of the parent slide it continues
   *  (same idea overflowing one card). Its title carries "(cont.)" and it never
   *  repeats the parent's points. Undefined for normal / sub-topic-split slides. */
  continuationOf?: string;
  visualIntent?: PlannedVisualIntent;
  requiredElements?: (typeof REQUIRED_ELEMENTS)[number][];
  speakerNotesGoal: string;
}

/** True when a planned slide REQUIRES a visual (a hard contract item). */
export function slideRequiresVisual(s: PlannedSlide): boolean {
  const vi = s.visualIntent;
  if (!vi) return false;
  return (vi.required || vi.priority === "required") && vi.role !== "none";
}

export interface PlannedSegment {
  id: string;
  name: string;
  purpose: (typeof SEGMENT_PURPOSES)[number];
  targetSlideCount: number;
  slideSpecIds: string[];
}

export interface LessonOutline {
  objective: string;
  targetStudent: string;
  estimatedMinutes: number;
  microLesson: boolean;
  teachingArc: z.infer<typeof TeachingArcSchema>;
  segments: PlannedSegment[];
  slides: PlannedSlide[];
  quizPlan?: z.infer<typeof QuizPlanSchema>;
  homeworkPlan?: z.infer<typeof HomeworkPlanSchema>;
}

/* Bounds-relaxed mirror used to PARSE the model's output (and the round-tripped
 * flat form on resume). Tolerant: nullable optionals, slide `id` accepted if
 * present (resume) else assigned, segment `slideSpecIds` ignored + rederived. */
const RelaxedSlideSchema = z.object({
  id: z.string().optional(),
  segmentId: z.string().optional().default(""),
  title: z.string().optional().default(""),
  teachingGoal: z.string().optional().default(""),
  role: z.enum(SLIDE_ROLES).optional().default("concept_intro"),
  kind: z.enum(SLIDE_KINDS).optional().default("core"),
  layout: z.enum(OUTLINE_LAYOUTS),
  depth: z.enum(OUTLINE_DEPTHS).optional().default("definition"),
  keyPoints: z.array(z.string()).optional().default([]),
  continuationOf: z.string().nullish(),
  notes: z.string().optional().default(""),
  // Tolerant: accept the structured object, a legacy free-text string, or null.
  visualIntent: z
    .union([
      z.object({
        required: z.boolean().nullish(),
        role: z.enum(VISUAL_INTENT_ROLES).nullish(),
        reason: z.string().nullish(),
        expectedVisualType: z.string().nullish(),
        placement: z.enum(VISUAL_PLACEMENTS).nullish(),
        priority: z.enum(VISUAL_PRIORITIES).nullish(),
        mustBeAccurate: z.boolean().nullish(),
      }),
      z.string(),
    ])
    .nullish(),
  requiredElements: z.array(z.enum(REQUIRED_ELEMENTS)).nullish(),
  speakerNotesGoal: z.string().optional().default(""),
});
const RelaxedSegmentSchema = z.object({
  id: z.string(),
  name: z.string().optional().default(""),
  purpose: z.enum(SEGMENT_PURPOSES).optional().default("concept_intro"),
  targetSlideCount: z.number().int().optional().default(1),
  slideSpecIds: z.array(z.string()).optional(),
});
const RelaxedLessonOutlineSchema = z.object({
  objective: z.string().optional().default(""),
  targetStudent: z.string().optional().default(""),
  estimatedMinutes: z.number().int().optional().default(10),
  microLesson: z.boolean().optional().default(false),
  teachingArc: TeachingArcSchema.partial().optional(),
  segments: z.array(RelaxedSegmentSchema).optional().default([]),
  slides: z.array(RelaxedSlideSchema),
  quizPlan: QuizPlanSchema.nullish(),
  homeworkPlan: HomeworkPlanSchema.nullish(),
});

const EMPTY_ARC: LessonOutline["teachingArc"] = {
  hook: "",
  coreConcepts: [],
  workedExamples: [],
  commonMisconceptions: [],
  recapGoal: "",
};

/** Strict JSON Schema for the PLAN structured-output turn. */
export function outlineResponseFormat(): { name: string; schema: JsonSchema } {
  return { name: "lesson_outline", schema: toStrictJsonSchema(LessonOutlineSchema) };
}

/** Heuristic: a lesson is "technical" if any planned slide is code-bearing
 *  (a code walkthrough layout or role). Technical lessons carry a higher floor. */
export function isTechnicalOutline(outline: LessonOutline): boolean {
  return outline.slides.some(
    (s) => s.layout === "code_walkthrough_steps" || s.role === "code_walkthrough"
  );
}

/**
 * PLAN depth floor: a NON-micro lesson plan that came back too thin gets ONE
 * re-ask to deepen it (the central fix for "a normal lesson planned only 3
 * slides"). Returns the re-ask instruction, or null when the plan is deep enough
 * / is an explicit micro-lesson. Pure — the caller decides whether to act on it.
 */
export function lessonDepthShortfall(outline: LessonOutline): string | null {
  if (outline.microLesson) return null;
  const floor = isTechnicalOutline(outline) ? AI_LESSON_FLOORS.technical : AI_LESSON_FLOORS.normal;
  if (outline.slides.length >= floor) return null;
  return (
    `This is a normal (non-micro) lesson, but the plan has only ${outline.slides.length} slide(s) — too thin. ` +
    `Expand it to at least ${floor} slides by DEEPENING the teaching where it genuinely helps (do NOT pad with filler): ` +
    `add a concrete motivating example, a full worked example, a common mistake / misconception to pre-empt, a check-for-understanding, ` +
    `a short practice prompt, an edge case or limitation, and a recap. Mark the added slides kind="enrichment". ` +
    `Keep microLesson=false and return the COMPLETE corrected contract.`
  );
}

/** Normalize a parsed visualIntent (structured object, legacy free-text string,
 *  or null) into PlannedVisualIntent — or undefined when no visual is intended. */
function coerceVisualIntent(v: unknown): PlannedVisualIntent | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return undefined;
    // Legacy free-text intent → treat as a recommended (not required) visual.
    return { required: false, role: "none", priority: "recommended", expectedVisualType: s, reason: s };
  }
  if (typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const role = (typeof o.role === "string" && (VISUAL_INTENT_ROLES as readonly string[]).includes(o.role) ? o.role : "none") as VisualRole | "none";
  const required = o.required === true;
  let priority = (typeof o.priority === "string" && (VISUAL_PRIORITIES as readonly string[]).includes(o.priority) ? o.priority : undefined) as VisualPriority | undefined;
  if (!priority) priority = required ? "required" : role !== "none" ? "recommended" : undefined;
  // No visual intended at all → undefined (keeps the contract clean).
  if (!required && role === "none" && priority !== "required" && priority !== "recommended") return undefined;
  return {
    required: required || priority === "required",
    role,
    reason: typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : undefined,
    expectedVisualType: typeof o.expectedVisualType === "string" && o.expectedVisualType.trim() ? o.expectedVisualType.trim() : undefined,
    placement: (typeof o.placement === "string" && (VISUAL_PLACEMENTS as readonly string[]).includes(o.placement) ? o.placement : undefined) as VisualPlacement | undefined,
    priority,
    mustBeAccurate: o.mustBeAccurate === true ? true : undefined,
  };
}

/** A slide is a TITLED OPENER iff it uses the section_break (chapter divider)
 *  layout. A non-micro deck must open with one (house style — fixes the
 *  "cold-open on a hook with no title" inconsistency). */
function isOpenerSlide(s: PlannedSlide): boolean {
  return s.layout === "section_break";
}

/** The closing recap (role=recap) every full lesson ends on. */
function isRecapSlide(s: PlannedSlide): boolean {
  return s.role === "recap";
}

/** The recap's key points — the lesson's core concepts (or its recap goal). */
function recapKeyPoints(arc: { coreConcepts?: string[]; recapGoal?: string } | undefined): string[] {
  const core = (arc?.coreConcepts ?? []).filter((c) => c && c.trim()).slice(0, 4);
  if (core.length) return core;
  return [arc?.recapGoal?.trim() || "The key takeaways from this lesson."];
}

/** Prepend a titled opener / append a recap spec when missing. Returns the SAME
 *  ref when both are already present (a micro-lesson never gets here). */
function withArcSpecs(slides: PlannedSlide[], objective: string, arc: { coreConcepts?: string[]; recapGoal?: string } | undefined): PlannedSlide[] {
  if (slides.length === 0) return slides;
  const needOpener = !isOpenerSlide(slides[0]);
  const needRecap = !isRecapSlide(slides[slides.length - 1]);
  if (!needOpener && !needRecap) return slides; // unchanged ref → caller keeps ids

  const out = [...slides];
  if (needOpener) {
    out.unshift({
      id: "s_open",
      segmentId: slides[0].segmentId,
      title: objective.trim() || "Lesson overview",
      teachingGoal: "Frame what this lesson covers and why it matters before diving in.",
      role: "hook",
      kind: "core",
      layout: "section_break",
      depth: "motivation",
      keyPoints: [objective.trim() || "What we'll cover and why it matters."],
      notes: "",
      visualIntent: undefined,
      requiredElements: undefined,
      speakerNotesGoal: "Open the lesson: name the topic and the payoff for the learner.",
    });
  }
  if (needRecap) {
    out.push({
      id: "s_recap",
      segmentId: slides[slides.length - 1].segmentId,
      title: "Recap",
      teachingGoal: "Consolidate the key takeaways the learner should leave with.",
      role: "recap",
      kind: "core",
      layout: "outline_list",
      depth: "analysis",
      keyPoints: recapKeyPoints(arc),
      notes: "",
      visualIntent: undefined,
      requiredElements: undefined,
      speakerNotesGoal: "Summarize the main points and point to what comes next.",
    });
  }
  return out;
}

/* ─────────────────── Method 1 — content-first split helpers ───────────────── */

const CONT_RE = /\s*\(cont\.?\)\s*$/i;
/** The base (parent) title with any "(cont.)" marker stripped. */
const stripCont = (title: string): string => title.replace(CONT_RE, "").trim();

/** True when a planned slide is a CONTINUATION (it links to a parent and/or carries
 *  the "(cont.)" title marker). The renderer/title convention shows the marker. */
export function isContinuationSlide(s: PlannedSlide): boolean {
  return !!s.continuationOf || CONT_RE.test(s.title);
}

/**
 * Normalize CONTINUATION splits (Method 1): for each slide whose `continuationOf`
 * names a parent, (1) ensure its title ends with "(cont.)" off the parent's base
 * title, and (2) drop any point it repeats VERBATIM from the parent (an exact dup is
 * not information — the point lives on the parent). PURE; preserves every UNIQUE
 * point (never truncates). Only non-continuation slides are eligible parents, so a
 * "X" / "X (cont.)" pair resolves correctly.
 */
function normalizeContinuations(slides: PlannedSlide[]): PlannedSlide[] {
  const parents = new Map<string, PlannedSlide>();
  for (const s of slides) if (!s.continuationOf) parents.set(stripCont(s.title), s);
  return slides.map((s) => {
    if (!s.continuationOf) return s;
    const parent = parents.get(stripCont(s.continuationOf));
    const base = stripCont(parent?.title ?? s.title);
    const title = CONT_RE.test(s.title) ? s.title : `${base} (cont.)`;
    let keyPoints = s.keyPoints;
    if (parent) {
      const parentPts = new Set(parent.keyPoints.map((p) => p.trim().toLowerCase()).filter(Boolean));
      keyPoints = s.keyPoints.filter((p) => !parentPts.has(p.trim().toLowerCase()));
    }
    return { ...s, title, keyPoints, continuationOf: base };
  });
}

/** Coerce a parsed value into a lesson outline: assign stable slide ids (keeping
 *  any already present), clamp slide + segment counts, and DERIVE each segment's
 *  slideSpecIds from the slides' segmentId grouping. Idempotent on the flat form.
 *  PURE — the opener/recap arc guarantee is applied separately (ensureLessonArc),
 *  AFTER the depth-floor re-ask, so the floor measures the model's real content. */
export function coerceOutline(value: unknown): { outline?: LessonOutline; errors: string[] } {
  const res = RelaxedLessonOutlineSchema.safeParse(value);
  if (!res.success) return { errors: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const d = res.data;
  if (d.slides.length === 0) return { errors: ["slides: the outline has no slides."] };

  const mapped: PlannedSlide[] = d.slides.slice(0, MAX_LESSON_SLIDES).map((s, i) => ({
    id: s.id && s.id.trim() ? s.id : `s${i + 1}`,
    segmentId: s.segmentId,
    title: s.title,
    teachingGoal: s.teachingGoal,
    role: s.role,
    kind: s.kind,
    layout: s.layout,
    depth: s.depth,
    keyPoints: s.keyPoints,
    notes: s.notes,
    continuationOf: s.continuationOf?.trim() || undefined,
    visualIntent: coerceVisualIntent(s.visualIntent),
    requiredElements: s.requiredElements ?? undefined,
    speakerNotesGoal: s.speakerNotesGoal,
  }));
  // Method 1: normalize CONTINUATION splits — stamp "(cont.)" into the title and
  // strip any point the continuation duplicates from its parent (no info loss — the
  // point stays on the parent; we only drop an exact repeat). Never truncates.
  const slides = normalizeContinuations(mapped);

  // Derive each segment's slide ids from the slides' segmentId grouping (order
  // preserved). Drop empty segments; cap segment count.
  const segments: PlannedSegment[] = d.segments
    .slice(0, MAX_LESSON_SEGMENTS)
    .map((seg) => ({
      id: seg.id,
      name: seg.name,
      purpose: seg.purpose,
      targetSlideCount: seg.targetSlideCount,
      slideSpecIds: slides.filter((sl) => sl.segmentId === seg.id).map((sl) => sl.id),
    }))
    .filter((seg) => seg.slideSpecIds.length > 0);

  const outline: LessonOutline = {
    objective: d.objective,
    targetStudent: d.targetStudent,
    estimatedMinutes: d.estimatedMinutes,
    microLesson: d.microLesson,
    teachingArc: { ...EMPTY_ARC, ...(d.teachingArc ?? {}) },
    segments,
    slides,
    quizPlan: d.quizPlan ?? undefined,
    homeworkPlan: d.homeworkPlan ?? undefined,
  };
  return { outline, errors: [] };
}

/** Parse the model's outline JSON, then coerce. Errors feed the ONE repair re-ask. */
export function validateOutline(raw: string): { outline?: LessonOutline; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { errors: ["The outline was not valid JSON. Return ONLY the json_schema object."] };
  }
  return coerceOutline(parsed);
}

/**
 * ARC GUARANTEE (house style): a full (non-micro) lesson MUST open with a titled
 * section_break and close with a recap. The PLAN prompt asks for this directly;
 * this is the deterministic safety net the PIPELINE applies AFTER the depth-floor
 * re-ask (so the floor measures the model's real content) and BEFORE approval —
 * it PREPENDS a titled opener and/or APPENDS a recap spec when the model's plan
 * lacks them, re-ids contiguously, and re-derives segment slideSpecIds, so the
 * coverage driver then builds a consistent beginning→end every time. No-op when
 * both are already present (or for a micro-lesson). Idempotent.
 */
export function ensureLessonArc(outline: LessonOutline): LessonOutline {
  if (outline.microLesson) return outline;
  const arced = withArcSpecs(outline.slides, outline.objective, outline.teachingArc);
  if (arced === outline.slides) return outline; // already opens + closes correctly
  const slides = arced.map((s, i) => ({ ...s, id: `s${i + 1}` }));
  const segments = outline.segments
    .map((seg) => ({ ...seg, slideSpecIds: slides.filter((sl) => sl.segmentId === seg.id).map((sl) => sl.id) }))
    .filter((seg) => seg.slideSpecIds.length > 0);
  return { ...outline, slides, segments };
}

/** Render an approved outline into the GENERATE/CRITIQUE prompt — arc + segments
 *  with their slides (by spec id) + the quiz/homework plans. */
export function outlinePromptFragment(outline: LessonOutline): string {
  const slideById = new Map(outline.slides.map((s) => [s.id, s]));
  const renderSlide = (s: PlannedSlide): string => {
    const pre = `   - [${s.id} · ${s.role}/${s.kind} · layout=${s.layout} · ${s.depth}] ${s.title} — ${s.teachingGoal}`;
    const cont = s.continuationOf
      ? `\n     CONTINUATION of "${s.continuationOf}": keep its heading + add a brief "continuing from ${s.continuationOf}" cue; author ONLY the points below — do NOT repeat the parent slide's points.`
      : "";
    const cover = s.keyPoints.length ? `\n     cover: ${s.keyPoints.map((p) => `• ${p}`).join("  ")}` : "";
    const exact = s.notes ? `\n     exact: ${s.notes}` : "";
    const vi = s.visualIntent;
    const visual =
      vi && (vi.role !== "none" || vi.required)
        ? `\n     visual (${vi.priority ?? (vi.required ? "required" : "recommended")}${vi.mustBeAccurate ? ", accuracy-critical" : ""}): ${vi.expectedVisualType ?? vi.role}${vi.reason ? ` — ${vi.reason}` : ""} → author it with add_diagram`
        : "";
    const req = s.requiredElements?.length ? `\n     must include: ${s.requiredElements.join(", ")}` : "";
    const notes = s.speakerNotesGoal ? `\n     speaker notes: ${s.speakerNotesGoal}` : "";
    return `${pre}${cont}${cover}${exact}${visual}${req}${notes}`;
  };

  const segBlocks = outline.segments.length
    ? outline.segments
        .map((seg) => {
          const slides = seg.slideSpecIds.map((id) => slideById.get(id)).filter((s): s is PlannedSlide => !!s);
          return `SEGMENT "${seg.name}" (${seg.purpose}, target ${seg.targetSlideCount} slide(s)):\n${slides.map(renderSlide).join("\n")}`;
        })
        .join("\n")
    : outline.slides.map(renderSlide).join("\n");

  const arc = outline.teachingArc;
  const arcLine = `Arc: hook — ${arc.hook || "—"}; core — ${arc.coreConcepts.join("; ") || "—"}; examples — ${arc.workedExamples.join("; ") || "—"}; misconceptions — ${arc.commonMisconceptions.join("; ") || "—"}; recap — ${arc.recapGoal || "—"}.`;
  const quiz = outline.quizPlan
    ? `\nQUIZ PLAN: ${outline.quizPlan.questionCount} question(s) — ${outline.quizPlan.targetSkills.map((t) => `${t.skill} (${t.difficulty})`).join(", ")}.`
    : "";
  const hw = outline.homeworkPlan
    ? `\nHOMEWORK PLAN: ${outline.homeworkPlan.exerciseCount} exercise(s), ${outline.homeworkPlan.difficulty} — ${outline.homeworkPlan.targetSkills.join(", ")}.`
    : "";

  const specIds = outline.slides.map((s) => s.id).join(", ");
  return [
    `APPROVED LESSON CONTRACT — objective: ${outline.objective}`,
    `For: ${outline.targetStudent}.${outline.microLesson ? " (micro-lesson — short by request.)" : ""}`,
    arcLine,
    `THE CONTRACT IS BINDING: you MUST build ALL ${outline.slides.length} planned slides (spec ids: ${specIds})${outline.quizPlan ? " + the planned knowledge check" : ""}${outline.homeworkPlan ? " + the planned practice" : ""}. Do not stop early.`,
    `Author ONE SEGMENT per turn (in order) with add_structured_slides_batch, EXPANDING each slide's "cover" brief into real teaching content and writing its speaker notes. Stamp each slide with its exact slideSpecId so coverage can be measured; keep the planned order, layout, and depth. If a batch call fails, retry the SAME specs — never skip them.`,
    segBlocks,
    quiz + hw,
  ].join("\n");
}

/** The PLAN phase role prompt (catalog appended by the runner). */
export const PLAN_SYSTEM_PROMPT = `You are planning a lesson before any slides are written. Read the lesson objective and the Plan-page context, then produce a complete TEACHING CONTRACT as structured data. The contract is the BRIEF the writer follows exactly — it must carry the real content, not just titles. Invest here: a strong plan is worth more than any later review.

First decide the lesson-level frame:
- objective: the single thing the learner can do after the lesson.
- targetStudent: who it's for and what they already know.
- estimatedMinutes: a realistic completion time.
- microLesson: TRUE only if the user EXPLICITLY asked for a short / micro / quick lesson. Otherwise FALSE.
- teachingArc: the hook (why care), the core concepts, the worked example(s), the common misconceptions to pre-empt, and what the recap consolidates.

HOW MANY SLIDES (the single most important planning decision — a too-short deck is the #1 failure):
- Micro lesson: 3–4 slides — ONLY when microLesson is true (the user explicitly asked for a short one).
- Normal instructional lesson: 6–10 slides.
- Technical / conceptual lesson: 7–12 slides.
- Complex lesson with examples + practice: 9–14 slides.
Never plan a 3–5-slide deck for a normal lesson just because the topic "seems simple". Almost every real topic has depth to teach. Do NOT pad with filler — DEEPEN with useful instructional material: a concrete motivating example, a full worked example, a common mistake / misconception, a check-for-understanding, a short practice prompt, an edge case or limitation, and a recap. Add each only where it improves the lesson.

OPENING & CLOSING (house style — every full, non-micro lesson):
- OPEN with a titled overview slide: the FIRST slide is role="hook" on layout="section_break" — a chapter-style divider carrying the lesson title (and, if useful, a one-line "what we'll cover"). Never cold-open straight into content; a deck always announces itself first.
- CLOSE with a recap: the LAST slide is role="recap" — it consolidates the core takeaways. A lesson always lands, never just stops.
(A micro-lesson may skip these.)

Then DECOMPOSE the lesson into ordered SEGMENTS (2–6), each a pedagogical beat of 1–3 slides — e.g. hook → concept_intro → worked_example → guided_practice → common_mistakes → recap → assessment. Give every segment an id, a name, a purpose, and a targetSlideCount.

Then write the ordered SLIDES — CONTENT FIRST, layout SECOND. For each slide, finalize WHAT it says before deciding HOW it looks:
- segmentId: which segment it belongs to (must match a segment id).
- title + teachingGoal: the working title and the single thing the learner should understand.
- role: the slide's pedagogical job — hook / concept_intro / definition / worked_example / code_walkthrough / visual_model / comparison / common_mistake / edge_case / conceptual_check / mini_practice / recap / transition.
- kind: "core" (essential to the objective) or "enrichment" (a worked example / check / edge case / practice that deepens it). Mark them honestly — a normal lesson carries several enrichment slides.
- keyPoints — FINALIZE THESE FIRST: the slide's real content (the actual points / claims / worked-example steps / definition it will make), each a full clause (NOT a title), aim 2–5. This is the slide's substance; everything else fits around it.
- layout — choose AFTER the points, to FIT them: the structured layout whose shape best HOLDS those points (a definition → key_concept; 2–3 options compared → comparison_columns; many shared dimensions → comparison_matrix; a sequence → process_steps; headline numbers → metrics_overview; a plain explanation → prose). VARY the layout across the deck — pick the shape the content wants; do NOT default every slide to the same layout.
- SPLIT at plan time if the points overflow ONE card (don't cram, never drop a point — cards auto-grow, so split only for REAL overflow, not a fixed bullet count):
   · CONTINUATION (one idea, more points than a card holds): add a second slide — same heading + " (cont.)", set continuationOf to the parent's exact title, and put the OVERFLOW points there (NEVER repeat the parent's points).
   · SUB-TOPIC split (the points form two distinct sub-ideas): two slides with distinct DESCRIPTIVE titles ("Causes of X" / "Effects of X"), continuationOf=null on both. PREFER this over a bare continuation when the points naturally group.
- depth: motivation / definition / mechanism / example / analysis.
- notes: the exact load-bearing specifics (a runtime like O(log n), a quantity, a formula, a rule's exact conditions, term(s) to define).
- visualIntent: whether this slide needs a VISUAL, and what — see VISUALS below. Default to required=false / role="none".
- requiredElements: elements the slide MUST contain, or null.
- speakerNotesGoal: what the spoken explanation behind the slide should cover.

Finally, plan assessment where it fits: quizPlan (3–5 checks with target skills + difficulty) and/or homeworkPlan, or null.

VISUALS — a visual is a TEACHING OBJECT, not decoration. Plan a visual wherever a learner would understand the idea better by SEEING it — a structure, a process, a relationship, a comparison, a timeline, a spatial or quantitative idea, or a worked example traced step by step — not only for the few topics conventionally drawn with a graph. A typical full lesson carries 2–4 visuals; a lesson with none is usually under-using them. Two kinds of visual exist:
- ACCURATE programmatic diagrams (the "diagram" layout / add_diagram) — economics graphs (supply & demand, price ceiling/floor), function/distribution/regression plots, bar charts, arrays with pointers (two-pointers / sliding window / binary search), trees (BST, traversal, recursion, hierarchy), node-link graphs (BFS/DFS, weighted/Dijkstra), flowcharts, number lines, and 2-set Venn diagrams. These are correct by construction.
- ILLUSTRATIVE images (an AI-generated educational illustration) — for a concept that benefits from a picture but ISN'T one of the diagram types above (e.g. a historical scene, a biology structure, a real-world analogy, an evocative concept image). The generator renders these from the slide's visualIntent.
How to mark it:
- mustBeAccurate=true ⇒ the visual carries exact labels/numbers/shape (a graph, a search interval, a weighted graph): it MUST be a programmatic diagram. Set required=true and prefer layout="diagram".
- required=true (without mustBeAccurate) ⇒ the slide genuinely needs its visual to teach (a process the slide is ABOUT, a structure being explained). Set expectedVisualType + a one-line reason.
- priority="recommended" ⇒ a visual that clearly helps but the slide still teaches without it — use this GENEROUSLY (the generator will add it when it can). priority="optional" ⇒ a nice-to-have. role="none" / required=false ⇒ a visual would only decorate (a pure definition, a short recap) — those slides need none.
- Always give expectedVisualType (the concrete picture) + a one-line reason when any visual is set. Do NOT plan a visual that merely repeats the title, crowds the slide, or that a table/code/text conveys more precisely. Never fabricate chart data — a metrics_overview / data_chart needs real numbers or it's omitted.

Rules:
- Front-load foundations: vocabulary is defined before it is used; basics before advanced.
- Teach to the depth a beginner needs — never skip "obvious" basics a real course would teach.
- EVERY core concept gets at least one concrete WORKED EXAMPLE slide (a worked_example role on concept_example or a steps layout).
- A normal lesson should include at least one common_mistake AND one conceptual_check (or mini_practice). Deepen, don't pad.
- Completeness over brevity: plan more slides if the topic warrants it (up to 14). A weight-bearing idea is its own slide.
- "prose" is a FIRST-CLASS choice, picked deliberately for a substantive plain explanation.

Output only the structured contract. The user reviews + approves before generation.`;

/* ─────────────────────────── Module SKELETON plan ──────────────────────────
 * A module build's FIRST call is a COMPACT skeleton, NOT a slide-by-slide plan.
 * The old whole-module plan (full slide specs + keyPoints + notes for every
 * lesson) was the heaviest call in the system and routinely TIMED OUT during the
 * model's long silent reasoning phase. The skeleton answers only "what unit is
 * this + what lessons, in what order, teaching what, how big" — a few short text
 * fields per lesson, NO per-slide arrays — so it returns in seconds. Each lesson's
 * RICH contract (slide specs, speaker notes, quiz/homework) is planned LAZILY,
 * per lesson, at generation time (runRichLessonPlan). Module map ≠ teaching
 * contract; one call must not do both jobs. */

/** Block types a lesson brief can suggest (the rich plan fills the actual content). */
export const MODULE_BLOCK_TYPES = ["slide_deck", "quiz", "homework", "lecture_text"] as const;

const LessonBriefSchema = z.object({
  title: z.string().describe("Lesson title (≤ ~10 words)."),
  objective: z.string().describe("One-line objective — what the learner can do after this lesson."),
  rationale: z.string().describe("Why this lesson exists in the module / what gap it fills."),
  prerequisiteLessons: z.array(z.string()).describe("Titles of earlier lessons in THIS module this depends on; [] if none."),
  skillsIntroduced: z.array(z.string()).describe("New skills/ideas this lesson introduces."),
  skillsPracticed: z.array(z.string()).describe("Earlier skills this lesson reinforces; [] if none."),
  estimatedMinutes: z.number().int().describe("Rough completion time in minutes."),
  minSlides: z.number().int().describe("Lower end of the deck size (e.g. 6)."),
  maxSlides: z.number().int().describe("Upper end of the deck size (e.g. 9)."),
  suggestedBlocks: z.array(z.enum(MODULE_BLOCK_TYPES)).describe("Block types this lesson should eventually contain (always includes slide_deck)."),
  recommendQuiz: z.boolean().describe("Whether a low-stakes knowledge check fits this lesson."),
  recommendHomework: z.boolean().describe("Whether a practice exercise fits this lesson."),
  dependencyNotes: z.string().nullable().describe("Any sequencing caveat, or null."),
});

/** The compact module SKELETON the first plan call returns (NO per-slide content). */
export const ModuleSkeletonSchema = z.object({
  moduleTitle: z.string().describe("The new module's title."),
  moduleObjective: z.string().describe("The single thing the module as a whole teaches."),
  summary: z.string().describe("A 1–2 sentence overview of the module."),
  audienceLevel: z.string().describe("Who it's for + their level."),
  prerequisites: z.array(z.string()).describe("What a learner should already know before this module; [] if none."),
  lessons: z.array(LessonBriefSchema).describe("Ordered lesson briefs (1–8). NO per-slide content here — just the lesson map."),
  assessmentGoal: z.string().nullable().describe("What the module's assessments should confirm, or null."),
  pacingNotes: z.string().nullable().describe("Optional note on pacing/sequencing, or null."),
});

/** The ULTRA-LEAN fallback the system retries with if the skeleton call times out.
 *  No nested arrays beyond the lesson list — the smallest possible module map. */
export const ModuleFallbackSchema = z.object({
  moduleTitle: z.string().describe("The new module's title."),
  moduleObjective: z.string().describe("The single thing the module teaches."),
  lessons: z.array(z.object({ title: z.string(), objective: z.string() })).describe("Ordered lessons: title + objective ONLY."),
  estimatedLessonCount: z.number().int().describe("How many lessons the module should have."),
  notes: z.string().nullable().describe("Optional note, or null."),
});

/* ──────────────────────── Internal (coerced) types ─────────────────────── */

export interface LessonBrief {
  title: string;
  objective: string;
  rationale: string;
  prerequisiteLessons: string[];
  skillsIntroduced: string[];
  skillsPracticed: string[];
  estimatedMinutes: number;
  minSlides: number;
  maxSlides: number;
  suggestedBlocks: (typeof MODULE_BLOCK_TYPES)[number][];
  recommendQuiz: boolean;
  recommendHomework: boolean;
  dependencyNotes?: string;
}

export interface ModuleSkeleton {
  moduleTitle: string;
  moduleObjective: string;
  summary: string;
  audienceLevel: string;
  prerequisites: string[];
  lessons: LessonBrief[];
  assessmentGoal?: string;
  pacingNotes?: string;
}

export function moduleSkeletonResponseFormat(): { name: string; schema: JsonSchema } {
  return { name: "module_skeleton", schema: toStrictJsonSchema(ModuleSkeletonSchema) };
}
export function moduleFallbackResponseFormat(): { name: string; schema: JsonSchema } {
  return { name: "module_fallback", schema: toStrictJsonSchema(ModuleFallbackSchema) };
}

/* Bounds-relaxed mirrors for PARSING (strict ignores min/max; clamp in coerce). */
const RelaxedLessonBriefSchema = z.object({
  title: z.string(),
  objective: z.string().optional().default(""),
  rationale: z.string().optional().default(""),
  prerequisiteLessons: z.array(z.string()).optional().default([]),
  skillsIntroduced: z.array(z.string()).optional().default([]),
  skillsPracticed: z.array(z.string()).optional().default([]),
  estimatedMinutes: z.number().int().optional().default(12),
  minSlides: z.number().int().optional().default(6),
  maxSlides: z.number().int().optional().default(9),
  suggestedBlocks: z.array(z.enum(MODULE_BLOCK_TYPES)).optional().default(["slide_deck"]),
  recommendQuiz: z.boolean().optional().default(false),
  recommendHomework: z.boolean().optional().default(false),
  dependencyNotes: z.string().nullish(),
});
const RelaxedModuleSkeletonSchema = z.object({
  moduleTitle: z.string().optional().default("New module"),
  moduleObjective: z.string().optional().default(""),
  summary: z.string().optional().default(""),
  audienceLevel: z.string().optional().default(""),
  prerequisites: z.array(z.string()).optional().default([]),
  lessons: z.array(RelaxedLessonBriefSchema),
  assessmentGoal: z.string().nullish(),
  pacingNotes: z.string().nullish(),
});
const RelaxedFallbackSchema = z.object({
  moduleTitle: z.string().optional().default("New module"),
  moduleObjective: z.string().optional().default(""),
  lessons: z.array(z.object({ title: z.string(), objective: z.string().optional().default("") })).optional().default([]),
  estimatedLessonCount: z.number().int().optional().default(0),
  notes: z.string().nullish(),
});

function briefFrom(b: z.infer<typeof RelaxedLessonBriefSchema>): LessonBrief {
  const minSlides = Math.max(3, Math.min(b.minSlides, MAX_LESSON_SLIDES));
  const maxSlides = Math.max(minSlides, Math.min(b.maxSlides, MAX_LESSON_SLIDES));
  const blocks: (typeof MODULE_BLOCK_TYPES)[number][] = b.suggestedBlocks.includes("slide_deck")
    ? b.suggestedBlocks
    : ["slide_deck", ...b.suggestedBlocks];
  return {
    title: b.title,
    objective: b.objective,
    rationale: b.rationale,
    prerequisiteLessons: b.prerequisiteLessons,
    skillsIntroduced: b.skillsIntroduced,
    skillsPracticed: b.skillsPracticed,
    estimatedMinutes: b.estimatedMinutes,
    minSlides,
    maxSlides,
    suggestedBlocks: blocks,
    recommendQuiz: b.recommendQuiz,
    recommendHomework: b.recommendHomework,
    dependencyNotes: b.dependencyNotes ?? undefined,
  };
}

/** Coerce a parsed value into a ModuleSkeleton: clamp lessons, drop untitled ones,
 *  require ≥1, normalize slide ranges + block lists. */
export function coerceModuleSkeleton(value: unknown): { skeleton?: ModuleSkeleton; errors: string[] } {
  const res = RelaxedModuleSkeletonSchema.safeParse(value);
  if (!res.success) return { errors: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const lessons = res.data.lessons
    .filter((l) => l.title.trim())
    .slice(0, MAX_MODULE_LESSONS)
    .map(briefFrom);
  if (lessons.length === 0) return { errors: ["lessons: the module skeleton has no lessons."] };
  return {
    skeleton: {
      moduleTitle: res.data.moduleTitle,
      moduleObjective: res.data.moduleObjective,
      summary: res.data.summary,
      audienceLevel: res.data.audienceLevel,
      prerequisites: res.data.prerequisites,
      lessons,
      assessmentGoal: res.data.assessmentGoal ?? undefined,
      pacingNotes: res.data.pacingNotes ?? undefined,
    },
    errors: [],
  };
}

/** Coerce the ULTRA-LEAN fallback into the same ModuleSkeleton shape (sensible
 *  defaults for the fields it omits) so the rest of the pipeline is identical. */
export function coerceModuleFallback(value: unknown): { skeleton?: ModuleSkeleton; errors: string[] } {
  const res = RelaxedFallbackSchema.safeParse(value);
  if (!res.success) return { errors: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const lessons = res.data.lessons
    .filter((l) => l.title.trim())
    .slice(0, MAX_MODULE_LESSONS)
    .map((l) => briefFrom(RelaxedLessonBriefSchema.parse({ title: l.title, objective: l.objective })));
  if (lessons.length === 0) return { errors: ["lessons: the fallback module map has no lessons."] };
  return {
    skeleton: {
      moduleTitle: res.data.moduleTitle,
      moduleObjective: res.data.moduleObjective,
      summary: "",
      audienceLevel: "",
      prerequisites: [],
      lessons,
      notes: res.data.notes ?? undefined,
    } as ModuleSkeleton,
    errors: [],
  };
}

export function validateModuleSkeleton(raw: string): { skeleton?: ModuleSkeleton; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { errors: ["The module skeleton was not valid JSON. Return ONLY the json_schema object."] };
  }
  return coerceModuleSkeleton(parsed);
}
export function validateModuleFallback(raw: string): { skeleton?: ModuleSkeleton; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { errors: ["The fallback module map was not valid JSON. Return ONLY the json_schema object."] };
  }
  return coerceModuleFallback(parsed);
}

/** Turn a lesson brief into the user instruction for that lesson's RICH plan
 *  (runRichLessonPlan feeds this to the full lesson PLAN, lazily, per lesson). */
export function lessonBriefToPlanRequest(brief: LessonBrief, moduleTitle: string): string {
  const parts = [
    `Plan the lesson "${brief.title}" for the module "${moduleTitle}".`,
    `Objective: ${brief.objective}.`,
  ];
  if (brief.rationale) parts.push(brief.rationale.endsWith(".") ? brief.rationale : `${brief.rationale}.`);
  if (brief.skillsIntroduced.length) parts.push(`It introduces: ${brief.skillsIntroduced.join(", ")}.`);
  if (brief.skillsPracticed.length) parts.push(`It reinforces: ${brief.skillsPracticed.join(", ")}.`);
  parts.push(`Aim for ${brief.minSlides}–${brief.maxSlides} slides, ~${brief.estimatedMinutes} min.`);
  if (brief.recommendQuiz) parts.push("Include a low-stakes knowledge check (quizPlan).");
  if (brief.recommendHomework) parts.push("Include a practice exercise (homeworkPlan).");
  if (brief.dependencyNotes) parts.push(brief.dependencyNotes);
  return parts.join(" ");
}

export const MODULE_SKELETON_SYSTEM_PROMPT = `You are sketching a COMPACT skeleton for a whole NEW module — a coherent unit MAP, not a slide-by-slide plan. Keep it small: a few short text fields per lesson. The detailed teaching contract for each lesson (slides, speaker notes, quizzes) is planned LATER, lazily, one lesson at a time — do NOT plan slide content here, or this call gets too large to return reliably.

Decide:
- moduleTitle, moduleObjective, summary, audienceLevel, prerequisites.
- An ordered list of LESSONS (aim 3–7) forming a learning arc: foundations first, each building on the last.
- assessmentGoal (what the module's checks should confirm) and pacingNotes, or null.

For each lesson give ONLY: title, objective, rationale (why it's here), prerequisiteLessons (earlier lessons it depends on), skillsIntroduced, skillsPracticed, estimatedMinutes, minSlides + maxSlides (a sensible deck size, usually 6–9), suggestedBlocks (always include slide_deck; add quiz/homework/lecture_text where they fit), recommendQuiz, recommendHomework, dependencyNotes (or null).

Do NOT write: slide-by-slide content, slide specs, key points, speaker notes, full quiz questions, full homework, examples, or visual layouts. Those belong in the per-lesson rich plan.

Output only the compact skeleton. The user reviews + approves the lesson MAP before any content is generated.`;

export const MODULE_FALLBACK_SYSTEM_PROMPT = `Quick module map (fallback — the detailed plan timed out, so keep this MINIMAL). Return only: moduleTitle, moduleObjective, an ordered list of lessons (title + one-line objective each, aim 3–6), estimatedLessonCount, and an optional note. NOTHING else — no slides, no skills, no per-lesson detail. This must be tiny so it returns instantly.`;

/** The structured-layout catalog text the PLAN phase chooses layouts from. */
export function planLayoutCatalogText(): string {
  const lines = structuredLayoutCatalog().map((l) => {
    const avoid = l.avoidWhen.length ? `; avoid ${l.avoidWhen.join("/")}` : "";
    return `- ${l.id} — ${l.bestFor.join(", ")}${avoid}`;
  });
  return `LAYOUT CATALOG (id — best for):\n${lines.join("\n")}\n- text — a plain text slide; use only when no structured layout fits.`;
}
