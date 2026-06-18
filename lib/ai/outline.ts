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
import { STRUCTURED_LAYOUT_IDS, structuredLayoutCatalog } from "@/lib/course/slide/structuredLayouts";
import { toStrictJsonSchema } from "./schema";
import type { JsonSchema } from "./modelClient";

/** Allowed outline layouts = ALL structured layouts (incl. `prose`, the
 *  deliberate plain teaching slide). No bare "text" fallback. */
export const OUTLINE_LAYOUTS = [...STRUCTURED_LAYOUT_IDS] as [string, ...string[]];

export const OUTLINE_DEPTHS = ["motivation", "definition", "mechanism", "example", "analysis"] as const;

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

/* Slide / array COUNT caps (soft — guidance + runaway guards on parse). */
export const MAX_LESSON_SLIDES = 14;
export const MAX_LESSON_SEGMENTS = 6;
export const MAX_MODULE_LESSONS = 8;

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

const SlideSpecSchema = z.object({
  segmentId: z.string().describe("The id of the segment this slide belongs to (must match a segment.id)."),
  title: z.string().describe("The slide's working title."),
  teachingGoal: z.string().describe("The single thing a learner should understand after this slide."),
  layout: z.enum(OUTLINE_LAYOUTS).describe("The structured layout that best fits this slide's intent."),
  depth: z.enum(OUTLINE_DEPTHS).describe("Where this slide sits in the learning arc."),
  keyPoints: z
    .array(z.string())
    .describe("The ACTUAL CONTENT to convey — real points / worked-example steps / the definition, each a full clause (NOT a title). GENERATE's brief; aim 2–5."),
  notes: z.string().describe("Load-bearing specifics to get exactly right (a runtime O(log n), a quantity, a formula, exact conditions, term(s) to define)."),
  visualIntent: z.string().nullable().describe("What a visual/diagram on this slide should show, if any (else null)."),
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
  teachingArc: TeachingArcSchema,
  segments: z.array(SegmentSchema).describe("Ordered pedagogical segments (2–6); each groups 1–3 slides."),
  slides: z.array(SlideSpecSchema).describe("Ordered slide specs; each tagged with its segmentId. 3–14 total."),
  quizPlan: QuizPlanSchema.nullable().describe("A knowledge-check plan if the lesson should have one (else null)."),
  homeworkPlan: HomeworkPlanSchema.nullable().describe("A homework plan if applicable (else null)."),
});

/* ──────────────────────────── Internal (coerced) types ─────────────────────
 * GENERATE / GenerationState / coverage consume THIS shape: slides carry an
 * assigned `id`, segments carry derived `slideSpecIds`. */

export interface PlannedSlide {
  id: string;
  segmentId: string;
  title: string;
  teachingGoal: string;
  layout: string;
  depth: (typeof OUTLINE_DEPTHS)[number];
  keyPoints: string[];
  notes: string;
  visualIntent?: string;
  requiredElements?: (typeof REQUIRED_ELEMENTS)[number][];
  speakerNotesGoal: string;
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
  layout: z.enum(OUTLINE_LAYOUTS),
  depth: z.enum(OUTLINE_DEPTHS).optional().default("definition"),
  keyPoints: z.array(z.string()).optional().default([]),
  notes: z.string().optional().default(""),
  visualIntent: z.string().nullish(),
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

/** Coerce a parsed value into a lesson outline: assign stable slide ids (keeping
 *  any already present), clamp slide + segment counts, and DERIVE each segment's
 *  slideSpecIds from the slides' segmentId grouping. Idempotent on the flat form. */
export function coerceOutline(value: unknown): { outline?: LessonOutline; errors: string[] } {
  const res = RelaxedLessonOutlineSchema.safeParse(value);
  if (!res.success) return { errors: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const d = res.data;
  if (d.slides.length === 0) return { errors: ["slides: the outline has no slides."] };

  const slides: PlannedSlide[] = d.slides.slice(0, MAX_LESSON_SLIDES).map((s, i) => ({
    id: s.id && s.id.trim() ? s.id : `s${i + 1}`,
    segmentId: s.segmentId,
    title: s.title,
    teachingGoal: s.teachingGoal,
    layout: s.layout,
    depth: s.depth,
    keyPoints: s.keyPoints,
    notes: s.notes,
    visualIntent: s.visualIntent ?? undefined,
    requiredElements: s.requiredElements ?? undefined,
    speakerNotesGoal: s.speakerNotesGoal,
  }));

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

/** Render an approved outline into the GENERATE/CRITIQUE prompt — arc + segments
 *  with their slides (by spec id) + the quiz/homework plans. */
export function outlinePromptFragment(outline: LessonOutline): string {
  const slideById = new Map(outline.slides.map((s) => [s.id, s]));
  const renderSlide = (s: PlannedSlide): string => {
    const pre = `   - [${s.id} · layout=${s.layout} · ${s.depth}] ${s.title} — ${s.teachingGoal}`;
    const cover = s.keyPoints.length ? `\n     cover: ${s.keyPoints.map((p) => `• ${p}`).join("  ")}` : "";
    const exact = s.notes ? `\n     exact: ${s.notes}` : "";
    const visual = s.visualIntent ? `\n     visual: ${s.visualIntent}` : "";
    const req = s.requiredElements?.length ? `\n     must include: ${s.requiredElements.join(", ")}` : "";
    const notes = s.speakerNotesGoal ? `\n     speaker notes: ${s.speakerNotesGoal}` : "";
    return `${pre}${cover}${exact}${visual}${req}${notes}`;
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

  return [
    `APPROVED LESSON CONTRACT — objective: ${outline.objective}`,
    `For: ${outline.targetStudent}.`,
    arcLine,
    `Author ONE SEGMENT per turn (in order) with add_structured_slides_batch, EXPANDING each slide's "cover" brief into real teaching content and writing its speaker notes. Use each slide's spec id so coverage can be measured; keep the planned order, layout, and depth.`,
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
- teachingArc: the hook (why care), the core concepts, the worked example(s), the common misconceptions to pre-empt, and what the recap consolidates.

Then DECOMPOSE the lesson into ordered SEGMENTS (2–6), each a pedagogical beat of 1–3 slides — e.g. hook → concept_intro → worked_example → guided_practice → common_mistakes → recap → assessment. Give every segment an id, a name, a purpose, and a targetSlideCount.

Then write the ordered SLIDES (3–14 total). For each slide:
- segmentId: which segment it belongs to (must match a segment id).
- title + teachingGoal: the working title and the single thing the learner should understand.
- layout: the structured layout that best fits, from the catalog below.
- depth: motivation / definition / mechanism / example / analysis.
- keyPoints: the ACTUAL CONTENT to convey — real points / worked-example steps / the definition, each a full clause (NOT a title), 2–5.
- notes: the exact load-bearing specifics (a runtime like O(log n), a quantity, a formula, a rule's exact conditions, term(s) to define).
- visualIntent: what a diagram/visual should show, or null.
- requiredElements: elements the slide MUST contain, or null.
- speakerNotesGoal: what the spoken explanation behind the slide should cover.

Finally, plan assessment where it fits: quizPlan (3–5 checks with target skills + difficulty) and/or homeworkPlan, or null.

Rules:
- Front-load foundations: vocabulary is defined before it is used; basics before advanced.
- Teach to the depth a beginner needs — never skip "obvious" basics a real course would teach.
- EVERY core concept gets at least one concrete WORKED EXAMPLE slide (concept_example or a steps slide).
- Completeness over brevity: plan more slides if the topic warrants it (up to 14). A weight-bearing idea is its own slide.
- No slides that need diagrams/charts we can't render — put the explanation in prose or a worked example. "prose" is a FIRST-CLASS choice, picked deliberately.

Output only the structured contract. The user reviews + approves before generation.`;

/* ─────────────────────────── Module-level plan ─────────────────────────────
 * MODULE builds keep a LIGHTER per-lesson outline (the bulk path). Each lesson
 * is adapted into a LessonOutline before GENERATE via moduleLessonToOutline. */

export const ModuleOutlineSlideSchema = z.object({
  concept: z.string().min(1).describe("The single idea this slide teaches."),
  prerequisites: z.array(z.string()).describe("Terms/ideas that must already be defined before this slide."),
  layout: z.enum(OUTLINE_LAYOUTS).describe("The structured layout that best fits this slide's intent."),
  depth: z.enum(OUTLINE_DEPTHS).describe("Where this slide sits in the learning arc."),
  keyPoints: z.array(z.string()).describe("The ACTUAL CONTENT to convey — full clauses, 2–5. The writer's brief."),
  notes: z.string().describe("Load-bearing specifics to get exactly right."),
});
export type ModuleOutlineSlide = z.infer<typeof ModuleOutlineSlideSchema>;

export const ModuleLessonSchema = z.object({
  title: z.string().min(1).max(80).describe("Lesson title (≤ ~10 words)."),
  objective: z.string().min(1).max(160).describe("One-line lesson objective."),
  slides: z.array(ModuleOutlineSlideSchema).min(3).max(12).describe("This lesson's slide-by-slide outline."),
});
export type ModuleLesson = z.infer<typeof ModuleLessonSchema>;

export const ModuleOutlineSchema = z.object({
  moduleTitle: z.string().min(1).max(80).describe("The new module's title."),
  lessons: z.array(ModuleLessonSchema).min(1).max(8).describe("Ordered lessons; each carries its own slide outline."),
});
export type ModuleOutline = z.infer<typeof ModuleOutlineSchema>;

export function moduleOutlineResponseFormat(): { name: string; schema: JsonSchema } {
  return { name: "module_outline", schema: toStrictJsonSchema(ModuleOutlineSchema) };
}

/** Adapt a lighter module-lesson outline into a LessonOutline so GENERATE,
 *  generation-state, and coverage all consume one shape. One synthetic segment;
 *  slide ids assigned; spec fields mapped from the light outline. */
export function moduleLessonToOutline(lesson: ModuleLesson): LessonOutline {
  const slides: PlannedSlide[] = lesson.slides.slice(0, MAX_LESSON_SLIDES).map((s, i) => ({
    id: `s${i + 1}`,
    segmentId: "lesson",
    title: s.concept,
    teachingGoal: s.concept,
    layout: s.layout,
    depth: s.depth,
    keyPoints: s.keyPoints,
    notes: s.notes,
    speakerNotesGoal: `Explain: ${s.concept}`,
  }));
  return {
    objective: lesson.objective,
    targetStudent: "",
    estimatedMinutes: Math.max(5, slides.length * 2),
    teachingArc: EMPTY_ARC,
    segments: [
      { id: "lesson", name: lesson.title, purpose: "concept_intro", targetSlideCount: slides.length, slideSpecIds: slides.map((s) => s.id) },
    ],
    slides,
  };
}

/* Bounds-relaxed mirror for PARSING the module plan (see the lesson note). */
const RelaxedModuleSlideSchema = z.object({
  concept: z.string(),
  prerequisites: z.array(z.string()).optional().default([]),
  layout: z.enum(OUTLINE_LAYOUTS),
  depth: z.enum(OUTLINE_DEPTHS),
  keyPoints: z.array(z.string()).optional().default([]),
  notes: z.string().optional().default(""),
});
const RelaxedModuleLessonSchema = z.object({
  title: z.string(),
  objective: z.string(),
  slides: z.array(RelaxedModuleSlideSchema),
});
const RelaxedModuleOutlineSchema = z.object({
  moduleTitle: z.string(),
  lessons: z.array(RelaxedModuleLessonSchema),
});

/** Coerce a parsed value into a module outline: clamp lesson + per-lesson slide
 *  counts; drop any lesson with zero slides; require ≥1 usable lesson. */
export function coerceModuleOutline(value: unknown): { outline?: ModuleOutline; errors: string[] } {
  const res = RelaxedModuleOutlineSchema.safeParse(value);
  if (!res.success) return { errors: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const lessons = res.data.lessons
    .map((l) => ({ ...l, slides: l.slides.slice(0, MAX_LESSON_SLIDES) }))
    .filter((l) => l.slides.length > 0)
    .slice(0, MAX_MODULE_LESSONS);
  if (lessons.length === 0) return { errors: ["lessons: the module has no lessons with slides."] };
  return { outline: { moduleTitle: res.data.moduleTitle, lessons }, errors: [] };
}

/** Parse the model's module JSON, then coerce. */
export function validateModuleOutline(raw: string): { outline?: ModuleOutline; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { errors: ["The module outline was not valid JSON. Return ONLY the json_schema object."] };
  }
  return coerceModuleOutline(parsed);
}

export const MODULE_PLAN_SYSTEM_PROMPT = `You are planning a whole NEW module before any slides are written. Read the request and the course context, then produce the module as structured data: an ordered list of lessons, each with a slide-by-slide outline.

For the module:
- Title it clearly. Sequence lessons as a learning arc (foundations first; each lesson builds on the last).
- Give each lesson a one-line objective and 3–12 planned slides.

DECOMPOSE each lesson, don't list: break the concept into sub-problems that BUILD to the intuition; each weight-bearing sub-step is its OWN slide; go primitive -> improved.

For each slide specify concept, prerequisites (defined earlier — this lesson or an earlier one), layout (from the catalog), depth (motivation / definition / mechanism / example / analysis), keyPoints (the ACTUAL CONTENT — real points / worked-example steps / the definition, each a full clause, 2–5; this is the writer's brief), and notes (load-bearing specifics: a runtime like O(log n), a quantity, a ratio, a formula, a rule's exact conditions).

Rules:
- Front-load foundations across the module: vocabulary is defined before it is used.
- For an algorithm: intuition -> mechanism -> complexity -> a WORKED EXAMPLE -> when to use it. EVERY concept gets ≥1 worked-example slide; add a low-stakes check where it fits (no scores).
- Each lesson moves through the arc; the module as a whole does too.
- Completeness over brevity, but keep lessons focused (split an overloaded lesson in two).
- No slides needing diagrams/charts we can't render — use prose/worked examples. "prose" is a deliberate first-class choice for full-sentence explanation, not a fallback.

Output only the structured module outline. The user reviews + approves before generation.`;

/** The structured-layout catalog text the PLAN phase chooses layouts from. */
export function planLayoutCatalogText(): string {
  const lines = structuredLayoutCatalog().map((l) => {
    const avoid = l.avoidWhen.length ? `; avoid ${l.avoidWhen.join("/")}` : "";
    return `- ${l.id} — ${l.bestFor.join(", ")}${avoid}`;
  });
  return `LAYOUT CATALOG (id — best for):\n${lines.join("\n")}\n- text — a plain text slide; use only when no structured layout fits.`;
}
