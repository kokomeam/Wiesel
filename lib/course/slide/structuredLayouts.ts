/**
 * Structured (renderer-owned) layouts — the ONE registry the renderer, the
 * manual picker, and the AI all bind to. Each entry is a typed Zod CONTENT
 * SCHEMA (the definition of the fillable slots) + seed example + AI hints.
 *
 * The schemas here are STRICT: every text slot carries an enforced max length
 * (measured on plain text) + a `.describe()` hint, and item arrays carry tight
 * count bounds. This is the key reliability fix for variable-content layouts —
 * the validate→repair loop bounces an over-long heading / extra step BACK to
 * the model before it can ever overflow a fixed card. (Storage validation in
 * schemas.ts is deliberately permissive so loading old slides never breaks.)
 */

import { z } from "zod";
import { findDiagramTemplate } from "../diagram/catalog";
import { DiagramContentInputSchema } from "../diagram/schemas";
import type { DiagramContent } from "../diagram/types";
import type {
  CodeWalkthroughContent,
  ComparisonColumnsContent,
  ComparisonMatrixContent,
  ConceptExampleContent,
  IllustrationContent,
  KeyConceptContent,
  MetricsContent,
  OutlineListContent,
  ProcessContent,
  ProseContent,
  RichText,
  SectionBreakContent,
  SlideTemplate,
  StructuredLayoutId,
} from "../types";

/* ── Length budget (plain-text chars / line counts). Tuned to the card geometry;
      these are COMMITTED limits, not advice. ── */
export const LIMITS = {
  eyebrow: 24,
  title: 48,
  subtitle: 90,
  term: 26,
  definition: 170,
  heading: 32,
  body: 120,
  metricLabel: 22,
  metricValue: 10,
  metricDelta: 22,
  codeLines: 20,
  // ── section_break
  sbNumber: 4,
  sbLabel: 24,
  sbTitle: 40,
  sbSubtitle: 90,
  // ── concept_example
  ceBadge: 16,
  ceTitle: 40,
  ceDefinition: 140,
  ceExampleBadge: 20,
  ceExampleTitle: 48,
  ceParagraph: 160,
  ceStepHeading: 40,
  ceStepBody: 120,
  ceFootnote: 90,
  // ── outline_list
  olTitle: 80,
  olItem: 80,
  olSubItem: 70,
  // ── prose (a substantive teaching text slide — body cap is GENEROUS on purpose)
  proseEyebrow: 24,
  proseTitle: 60,
  proseBody: 700,
  prosePoint: 120,
  // ── illustration (a generated/uploaded image slide)
  illTitle: 60,
  illAlt: 320,
  illCaption: 180,
  illPoint: 120,
  // ── comparison (shared header + columnar + matrix). Caps lean GENEROUS/soft:
  //    tight caps cause reshape churn; the renderer reflows, it doesn't clip.
  cmpEyebrow: 24,
  cmpTitle: 56,
  cmpSubtitle: 120,
  cmpOptionName: 30,
  cmpPointLabel: 48,
  cmpPointDetail: 130,
  cmpDimLabel: 30,
  cmpCellDetail: 100,
  cmpCellExample: 90,
  cmpSummary: 170,
  cmpSimilarity: 72,
} as const;

/**
 * Run-level marks, tolerant of what the AGENT sends for "no mark".
 *
 * This is the AI INPUT boundary: the strict tool schema (lib/ai/schema.ts)
 * presents every optional key to the model as NULLABLE, so a structured-slide
 * call emits `color: null` (and null bold/italic/underline) on any emphasized
 * run that carries no such mark. We accept that null and normalize it to
 * "absent" HERE, so the produced patch is CLEAN and the downstream storage
 * schema (strict `string | undefined`, never null) validates it — no raw
 * validate→repair error ever surfaces. Storage's own TextRunSchema is left
 * untouched; this tolerance lives only on the model-facing edge. The
 * model-facing JSON Schema still advertises null because it's generated from
 * the INPUT type (`io: "input"` in lib/ai/schema.ts). */
const aiMarkBool = z.boolean().nullish().transform((v) => v ?? undefined);
const aiMarkColor = z.string().nullish().transform((v) => v ?? undefined);
const AiTextRunSchema = z.object({
  text: z.string(),
  marks: z
    .object({ bold: aiMarkBool, italic: aiMarkBool, underline: aiMarkBool, color: aiMarkColor })
    .optional(),
});

/** A strict rich-text slot: caps the PLAIN text and documents the limit for the
 *  model. Optional `runs` carry emphasis; the renderer reads `.text` for layout. */
function rich(max: number, hint: string) {
  return z
    .object({
      text: z.string().min(1).max(max, `Keep this ≤ ${max} characters (≈ tight). Shorten it.`),
      runs: z.array(AiTextRunSchema).optional(),
    })
    .describe(hint);
}

const stickerSlot = z
  .string()
  .optional()
  .describe("Optional sticker id (icon) from the sticker registry; omit if no icon clarifies it.");

/* ───────────────────────────── Content schemas ────────────────────────── */

const StepSchema = z.object({
  sticker: stickerSlot,
  heading: rich(LIMITS.heading, "Step heading: ≤ 6 words."),
  body: rich(LIMITS.body, "Step body: one short supporting sentence."),
});

export const ProcessContentSchema = z.object({
  eyebrow: rich(LIMITS.eyebrow, "Short kicker above the title, e.g. 'Process overview'.").optional(),
  title: rich(LIMITS.title, "Slide title: ≤ ~8 words."),
  subtitle: rich(LIMITS.subtitle, "One-line framing under the title.").optional(),
  steps: z
    .array(StepSchema)
    .min(3)
    .max(5)
    .describe("3–5 sequential steps; the renderer numbers and arranges them in a row with arrows."),
}) satisfies z.ZodType<ProcessContent>;

const ConceptItemSchema = z.object({
  sticker: stickerSlot,
  heading: rich(LIMITS.heading, "Point heading: ≤ 6 words."),
  body: rich(LIMITS.body, "Point body: one short supporting sentence."),
});

export const KeyConceptContentSchema = z.object({
  variant: z.enum(["sans", "serif"]).describe("'serif' = editorial display title; 'sans' = plainer."),
  spine: z.boolean().optional().describe("Draw a thin connector spine + node dots between items."),
  eyebrow: rich(LIMITS.eyebrow, "Kicker, e.g. 'Key concept'.").optional(),
  term: rich(LIMITS.term, "The term being defined: 1–3 words, shown large."),
  definition: rich(LIMITS.definition, "A plain-language definition: 1–2 sentences."),
  items: z
    .array(ConceptItemSchema)
    .min(2)
    .max(4)
    .describe("2–4 supporting points, each an icon + heading + one sentence."),
}) satisfies z.ZodType<KeyConceptContent>;

const MetricSchema = z.object({
  sticker: stickerSlot,
  label: rich(LIMITS.metricLabel, "What the number measures, e.g. 'New signups'."),
  value: rich(LIMITS.metricValue, "The headline value as text: '12,345', '67.8%', '3.2×'."),
  delta: z
    .object({
      direction: z.enum(["up", "down"]),
      text: rich(LIMITS.metricDelta, "Change label, e.g. '8.6% vs last period'."),
      sentiment: z.enum(["positive", "negative", "neutral"]).describe("Colors the delta (accent / cool / muted)."),
    })
    .optional()
    .describe("Optional change indicator."),
});

export const MetricsContentSchema = z.object({
  eyebrow: rich(LIMITS.eyebrow, "Kicker, e.g. 'Summary overview'.").optional(),
  title: rich(LIMITS.title, "Slide title: ≤ ~8 words."),
  metrics: z.array(MetricSchema).min(2).max(4).describe("2–4 stat cards."),
}) satisfies z.ZodType<MetricsContent>;

export const CodeWalkthroughContentSchema = z.object({
  eyebrow: rich(LIMITS.eyebrow, "Kicker, e.g. 'Code walkthrough'.").optional(),
  title: rich(LIMITS.title, "Slide title: ≤ ~8 words."),
  code: z
    .object({
      language: z.string().min(1).describe("Language id for highlighting: python, ts, cpp, …"),
      code: z
        .string()
        .min(1)
        .refine((c) => c.split("\n").length <= LIMITS.codeLines, `Keep the code to ≤ ${LIMITS.codeLines} lines.`)
        .describe("The code to show (deterministic; ≤ 20 lines). Never style it yourself."),
    })
    .describe("A single code block, highlighted by the renderer."),
  steps: z
    .array(StepSchema)
    .min(2)
    .max(4)
    .describe("2–4 numbered explanations. Reference lines in text ('Line 1: …'); never draw connectors."),
}) satisfies z.ZodType<CodeWalkthroughContent>;

/* ── New layouts. NOTE: none expose `decor` — flair level is renderer-owned and
      human-toggled only, so the model can never request or position decoration. */

const titleStyleSlot = z
  .enum(["sans", "serif"])
  .optional()
  .describe("'serif' = editorial display title (also drives the two-tone accent); 'sans' = plainer.");

export const SectionBreakContentSchema = z.object({
  number: z
    .string()
    .max(LIMITS.sbNumber, `Keep the number ≤ ${LIMITS.sbNumber} characters, e.g. '02'.`)
    .optional()
    .describe("Short section number, e.g. '02' (shown large in the hero_numeral variant)."),
  label: rich(LIMITS.sbLabel, "Section name beside the number, e.g. 'Foundations'."),
  title: rich(LIMITS.sbTitle, "The section title: ≤ 6 words."),
  subtitle: rich(LIMITS.sbSubtitle, "One-line framing under the title.").optional(),
  titleStyle: titleStyleSlot,
  variant: z
    .enum(["standard", "hero_numeral"])
    .optional()
    .describe("'hero_numeral' shows the giant outline number; 'standard' is the default."),
}) satisfies z.ZodType<SectionBreakContent>;

const ConceptExampleStepSchema = z.object({
  heading: rich(LIMITS.ceStepHeading, "Step heading: ≤ 6 words."),
  body: rich(LIMITS.ceStepBody, "Step body: one short sentence."),
});

const ConceptExampleBodySchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("paragraphs"),
      paragraphs: z
        .array(rich(LIMITS.ceParagraph, "One short paragraph of the worked example."))
        .min(1)
        .max(3)
        .describe("1–3 prose paragraphs."),
    }),
    z.object({
      kind: z.literal("steps"),
      steps: z.array(ConceptExampleStepSchema).min(2).max(4).describe("2–4 numbered steps."),
    }),
  ])
  .describe("Pick 'steps' for a procedure, 'paragraphs' for prose. The renderer numbers steps.");

export const ConceptExampleContentSchema = z.object({
  concept: z.object({
    badge: z
      .string()
      .max(LIMITS.ceBadge, `Badge ≤ ${LIMITS.ceBadge} characters, e.g. 'Rule'.`)
      .optional()
      .describe("Small label pill, e.g. 'Rule' or 'Concept'."),
    title: rich(LIMITS.ceTitle, "The rule/concept name: ≤ 6 words."),
    titleStyle: titleStyleSlot,
    definition: rich(LIMITS.ceDefinition, "A plain-language definition: 1–2 sentences."),
  }),
  example: z.object({
    badge: z
      .string()
      .max(LIMITS.ceExampleBadge, `Badge ≤ ${LIMITS.ceExampleBadge} characters, e.g. 'Worked Example'.`)
      .optional()
      .describe("Small label pill, e.g. 'Worked Example'."),
    title: rich(LIMITS.ceExampleTitle, "Optional example title.").optional(),
    body: ConceptExampleBodySchema,
  }),
  footnote: rich(LIMITS.ceFootnote, "Optional bottom callout: a caveat or 'in practice' note.").optional(),
}) satisfies z.ZodType<ConceptExampleContent>;

const OutlineItemSchema = z.object({
  text: rich(LIMITS.olItem, "Outline item: ≤ ~12 words."),
  subItems: z
    .array(rich(LIMITS.olSubItem, "A brief sub-point: ≤ ~10 words."))
    .max(2)
    .optional()
    .describe("Optional 0–2 sub-points; add only when an item needs a brief breakdown."),
});

export const OutlineListContentSchema = z.object({
  title: rich(LIMITS.olTitle, "List title, e.g. 'By the end of this module…'."),
  items: z
    .array(OutlineItemSchema)
    .min(2)
    .max(5)
    .describe("2–5 items; the renderer numbers them and indents any sub-items."),
}) satisfies z.ZodType<OutlineListContent>;

export const ProseContentSchema = z.object({
  eyebrow: rich(LIMITS.proseEyebrow, "Optional kicker above the title.").optional(),
  title: rich(LIMITS.proseTitle, "Slide title: ≤ ~9 words."),
  body: rich(
    LIMITS.proseBody,
    "The explanation — REAL teaching prose (2–5 full sentences) that actually conveys the idea, not a fragment. Define terms; give the concrete specifics."
  ),
  points: z
    .array(rich(LIMITS.prosePoint, "A key takeaway — a full clause, not 2–3 words."))
    .max(5)
    .optional()
    .describe("Optional 0–5 key takeaways."),
}) satisfies z.ZodType<ProseContent>;

/** Illustration (image) slide. NOTE: this layout is authored by the `add_image`
 *  tool (it generates + stores the image and supplies `imageUrl`), NOT by the
 *  hand-authored structured-slide union — so the model can never invent a URL.
 *  The schema validates the stored/edited content + the inspector. */
export const IllustrationContentSchema = z.object({
  imageUrl: z.string().describe("Public URL of the stored image (set by add_image / upload)."),
  alt: z.string().min(1).max(LIMITS.illAlt, `Alt text ≤ ${LIMITS.illAlt} characters.`).describe("Required alt text describing the image."),
  title: rich(LIMITS.illTitle, "Optional title above the image.").optional(),
  caption: rich(LIMITS.illCaption, "Optional caption: what the learner should notice.").optional(),
  points: z.array(rich(LIMITS.illPoint, "An optional supporting point beside the image.")).max(4).optional(),
  source: z.enum(["ai_generated", "upload"]).optional(),
  storagePath: z.string().optional(),
}) satisfies z.ZodType<IllustrationContent>;

/* ── comparison layouts (contrast 2–3 options). Option colors, letter badges,
      the VS divider, row striping, and footer icon/tint are renderer-owned —
      NONE of them appear here, so the model can never request them. ── */

const ComparisonFooterSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("summary"),
      text: rich(LIMITS.cmpSummary, "A single bottom-line takeaway from the comparison: one sentence."),
    }),
    z.object({
      kind: z.literal("similarities"),
      points: z
        .array(rich(LIMITS.cmpSimilarity, "A trait the options SHARE: a short phrase."))
        .min(2)
        .max(3)
        .describe("2–3 traits the options have in common."),
    }),
  ])
  .describe(
    "Optional footer. 'summary' = one takeaway (renderer tints it warm + a star icon); 'similarities' = shared traits (renderer tints it cool + a people icon). The renderer owns the icon and tint."
  );

const ComparisonPointSchema = z.object({
  label: rich(LIMITS.cmpPointLabel, "A point about this option: a short phrase (≤ ~8 words)."),
  detail: rich(LIMITS.cmpPointDetail, "Optional one-line elaboration of the point.").optional(),
});

const ComparisonOptionSchema = z.object({
  name: rich(LIMITS.cmpOptionName, "The option's name: 1–3 words."),
  icon: stickerSlot,
  points: z.array(ComparisonPointSchema).min(2).max(4).describe("2–4 points characterising this option."),
});

export const ComparisonColumnsContentSchema = z.object({
  eyebrow: rich(LIMITS.cmpEyebrow, "Short kicker above the title, e.g. 'Compare'.").optional(),
  title: rich(LIMITS.cmpTitle, "Slide title: ≤ ~9 words."),
  subtitle: rich(LIMITS.cmpSubtitle, "One-line framing under the title.").optional(),
  presentation: z
    .enum(["cards", "bare"])
    .optional()
    .describe("'cards' = boxed columns (default); 'bare' = a big letter badge over an open column. Cosmetic only."),
  options: z
    .array(ComparisonOptionSchema)
    .min(2)
    .max(3)
    .describe(
      "2–3 options, drawn as side-by-side columns. The renderer colors and letter-badges them by position (A/B/C) and draws the 'VS.' divider when there are exactly two."
    ),
  footer: ComparisonFooterSchema.optional(),
}) satisfies z.ZodType<ComparisonColumnsContent>;

const ComparisonMatrixOptionSchema = z.object({
  name: rich(LIMITS.cmpOptionName, "The option's name: 1–3 words."),
  icon: stickerSlot,
});

const ComparisonCellSchema = z.object({
  detail: rich(LIMITS.cmpCellDetail, "This option's value for this dimension: a short phrase."),
  example: rich(LIMITS.cmpCellExample, "Optional concrete example for this cell.").optional(),
});

const ComparisonDimensionSchema = z.object({
  label: rich(LIMITS.cmpDimLabel, "The dimension being compared, e.g. 'Cost'."),
  icon: stickerSlot,
  cells: z
    .array(ComparisonCellSchema)
    .min(2)
    .max(3)
    .describe("EXACTLY one cell per option, in the SAME order as `options`."),
});

const ComparisonMatrixBaseSchema = z.object({
  eyebrow: rich(LIMITS.cmpEyebrow, "Short kicker above the title, e.g. 'Compare'.").optional(),
  title: rich(LIMITS.cmpTitle, "Slide title: ≤ ~9 words."),
  subtitle: rich(LIMITS.cmpSubtitle, "One-line framing under the title.").optional(),
  options: z
    .array(ComparisonMatrixOptionSchema)
    .min(2)
    .max(3)
    .describe("2–3 options, drawn as the matrix COLUMNS."),
  dimensions: z
    .array(ComparisonDimensionSchema)
    .min(2)
    .max(4)
    .describe("2–4 dimensions, drawn as the matrix ROWS. Each dimension's `cells` must hold one cell per option."),
  footer: ComparisonFooterSchema.optional(),
}) satisfies z.ZodType<ComparisonMatrixContent>;

/** Cross-field invariant: every dimension row has exactly one cell per option,
 *  so the renderer's grid stays aligned. Bounced back to the model on mismatch. */
export const ComparisonMatrixContentSchema = ComparisonMatrixBaseSchema.refine(
  (val) => val.dimensions.every((d) => d.cells.length === val.options.length),
  { message: "Each dimension must have exactly one cell per option, in the same order as `options`.", path: ["dimensions"] }
);

/** The strict, length-enforcing AI input: pick a layoutId, fill its content.
 *  Generates the tool's JSON schema AND validates the model's args (the
 *  validate→repair boundary). */
export const StructuredTemplateInputSchema = z.discriminatedUnion("layoutId", [
  z.object({ layoutId: z.literal("process_steps"), content: ProcessContentSchema }),
  z.object({ layoutId: z.literal("key_concept"), content: KeyConceptContentSchema }),
  z.object({ layoutId: z.literal("metrics_overview"), content: MetricsContentSchema }),
  z.object({ layoutId: z.literal("code_walkthrough_steps"), content: CodeWalkthroughContentSchema }),
  z.object({ layoutId: z.literal("section_break"), content: SectionBreakContentSchema }),
  z.object({ layoutId: z.literal("concept_example"), content: ConceptExampleContentSchema }),
  z.object({ layoutId: z.literal("outline_list"), content: OutlineListContentSchema }),
  z.object({ layoutId: z.literal("prose"), content: ProseContentSchema }),
  z.object({ layoutId: z.literal("comparison_columns"), content: ComparisonColumnsContentSchema }),
  z.object({ layoutId: z.literal("comparison_matrix"), content: ComparisonMatrixContentSchema }),
  z.object({ layoutId: z.literal("diagram"), content: DiagramContentInputSchema }),
]);

/* ───────────────────────────── Registry ───────────────────────────────── */

export interface StructuredLayoutDef {
  id: StructuredLayoutId;
  name: string;
  description: string;
  ai: { bestFor: string[]; avoidWhen: string[] };
  /** Strict content schema (the fillable-slot definition + length limits). */
  schema: z.ZodTypeAny;
  /** Example content for the manual picker / seeding. */
  seed: () => SlideTemplate;
}

const t = (text: string): RichText => ({ text });

export const STRUCTURED_LAYOUTS: StructuredLayoutDef[] = [
  {
    id: "process_steps",
    name: "Process / steps",
    description: "A repeatable process as 3–5 numbered step cards in a row with arrows.",
    ai: {
      bestFor: ["a sequence", "a workflow", "how it works", "numbered steps"],
      avoidWhen: ["non-sequential content", "a single idea", "raw data"],
    },
    schema: ProcessContentSchema,
    seed: () => ({
      layoutId: "process_steps",
      content: {
        eyebrow: t("Process overview"),
        title: t("Our four-step process"),
        subtitle: t("A simple, repeatable way to go from concept to outcome."),
        steps: [
          { sticker: "lightbulb", heading: t("Define the goal"), body: t("Align on the outcome and key priorities.") },
          { sticker: "document", heading: t("Map the plan"), body: t("Sequence the approach before you start.") },
          { sticker: "gear", heading: t("Execute"), body: t("Do the work with focus and precision.") },
          { sticker: "bar-chart", heading: t("Review & refine"), body: t("Measure results and improve continuously.") },
        ],
      },
    }),
  },
  {
    id: "key_concept",
    name: "Key concept / definition",
    description: "A big term + definition on the left, with supporting icon points on the right.",
    ai: {
      bestFor: ["defining a term", "a key concept", "vocabulary", "a principle + examples"],
      avoidWhen: ["multiple unrelated concepts", "a process", "raw data"],
    },
    schema: KeyConceptContentSchema,
    seed: () => ({
      layoutId: "key_concept",
      content: {
        variant: "sans",
        spine: false,
        eyebrow: t("Core concept"),
        term: t("Opportunity cost"),
        definition: t("The value of the next best alternative you give up when you make a choice."),
        items: [
          { sticker: "signpost", heading: t("Every choice is a tradeoff"), body: t("Resources are limited, so choosing one option means giving up another.") },
          { sticker: "user-star", heading: t("The next best alternative"), body: t("It's measured by the value of the best option you didn't choose.") },
          { sticker: "bar-chart", heading: t("Better decisions"), body: t("Understanding it helps you choose options that create the most value.") },
        ],
      },
    }),
  },
  {
    id: "metrics_overview",
    name: "Metrics overview",
    description: "2–4 headline stat cards, each with a value and an up/down change.",
    ai: {
      bestFor: ["key numbers", "results at a glance", "KPIs", "before/after metrics"],
      avoidWhen: ["a time-series chart (deferred)", "prose", "a single idea"],
    },
    schema: MetricsContentSchema,
    seed: () => ({
      layoutId: "metrics_overview",
      content: {
        eyebrow: t("Summary overview"),
        title: t("Performance at a glance"),
        metrics: [
          { sticker: "trending-up", label: t("New signups"), value: t("12,345"), delta: { direction: "up", text: t("8.6% vs last period"), sentiment: "positive" } },
          { sticker: "target", label: t("Conversion"), value: t("67.8%"), delta: { direction: "up", text: t("5.2% vs last period"), sentiment: "positive" } },
          { sticker: "users", label: t("Active users"), value: t("1,234"), delta: { direction: "down", text: t("3.1% vs last period"), sentiment: "negative" } },
        ],
      },
    }),
  },
  {
    id: "code_walkthrough_steps",
    name: "Code walkthrough",
    description: "A highlighted code block beside 2–4 numbered explanations.",
    ai: {
      bestFor: ["explaining code", "an implementation", "a function step by step"],
      avoidWhen: ["concept intros", "no code", "more than ~20 lines of code"],
    },
    schema: CodeWalkthroughContentSchema,
    seed: () => ({
      layoutId: "code_walkthrough_steps",
      content: {
        eyebrow: t("Code walkthrough"),
        title: t("A simple function, step by step"),
        code: {
          language: "python",
          code: 'def total_price(items, tax_rate=0.07):\n    subtotal = 0\n    for item in items:\n        subtotal += item["price"] * item["qty"]\n    tax = subtotal * tax_rate\n    return round(subtotal + tax, 2)',
        },
        steps: [
          { sticker: "document", heading: t("Define the function"), body: t("Line 1: accepts a list of items and an optional tax rate.") },
          { sticker: "gear", heading: t("Sum the subtotal"), body: t("Lines 3–4: iterate items and add price × quantity.") },
          { sticker: "coins", heading: t("Add tax and return"), body: t("Lines 5–6: apply the tax and return the rounded total.") },
        ],
      },
    }),
  },
  {
    id: "section_break",
    name: "Section break",
    description: "A chapter/section transition: a numbered kicker, a big two-tone title, and a one-line framing.",
    ai: {
      bestFor: ["opening a new module/section", "a chapter divider", "a transition slide"],
      avoidWhen: ["mid-lesson content", "a slide that teaches something"],
    },
    schema: SectionBreakContentSchema,
    seed: () => ({
      layoutId: "section_break",
      content: {
        number: "02",
        label: t("Foundations"),
        title: t("Core Principles"),
        subtitle: t("An introduction to the key ideas that guide everything we build."),
        titleStyle: "serif",
        variant: "standard",
      },
    }),
  },
  {
    id: "concept_example",
    name: "Concept → example",
    description: "An abstract rule/definition on the left paired with a worked example (prose or numbered steps) on the right.",
    ai: {
      bestFor: ["pairing a rule/definition with a concrete worked example", "concept then application"],
      avoidWhen: ["a pure definition with no example (use key_concept)", "a standalone process"],
    },
    schema: ConceptExampleContentSchema,
    seed: () => ({
      layoutId: "concept_example",
      content: {
        concept: {
          badge: "Rule",
          title: t("Supply and demand"),
          titleStyle: "serif",
          definition: t("Price settles where the quantity buyers want equals the quantity sellers offer."),
        },
        example: {
          badge: "Worked Example",
          title: t("Pricing a new product"),
          body: {
            kind: "steps",
            steps: [
              { heading: t("Estimate demand"), body: t("Survey how many units sell at each candidate price.") },
              { heading: t("Estimate supply"), body: t("Work out how many you can make at each price.") },
              { heading: t("Find the balance"), body: t("The price where the two meet is the market price.") },
            ],
          },
        },
        footnote: t("In practice, taxes and shortages shift these curves."),
      },
    }),
  },
  {
    id: "outline_list",
    name: "Outline / objectives",
    description: "A titled nested list — lesson objectives or a module table of contents, with optional sub-points.",
    ai: {
      bestFor: ["lesson objectives", "a module table of contents", "a learning agenda"],
      avoidWhen: ["a sequence/procedure (use process_steps)", "raw data"],
    },
    schema: OutlineListContentSchema,
    seed: () => ({
      layoutId: "outline_list",
      content: {
        title: t("By the end of this module…"),
        items: [
          { text: t("Explain what a market price is"), subItems: [t("Define supply and demand"), t("Read a simple price chart")] },
          { text: t("Calculate a market equilibrium") },
          { text: t("Predict how a shock moves prices"), subItems: [t("Tax, subsidy, and shortage cases")] },
        ],
      },
    }),
  },
  {
    id: "prose",
    name: "Explainer (prose)",
    description: "A title + a real explanatory paragraph (and optional key points) — a deliberate plain teaching slide, not a tip stack.",
    ai: {
      bestFor: ["explaining an idea in full sentences", "intuition / motivation prose", "background a learner must read"],
      avoidWhen: ["a process (use process_steps)", "a term + supports (use key_concept)", "a list of objectives (use outline_list)"],
    },
    schema: ProseContentSchema,
    seed: () => ({
      layoutId: "prose",
      content: {
        eyebrow: t("Intuition"),
        title: t("Why greedy works here"),
        body: t("A greedy algorithm builds the answer one safe choice at a time. At each step it adds the cheapest option that can't break a later solution — for a minimum spanning tree, the cheapest edge that doesn't form a cycle. Because every such choice is provably part of some optimal tree, repeating it never paints us into a corner, so the locally cheapest move adds up to the globally cheapest tree."),
        points: [
          t("Make the cheapest choice that stays valid."),
          t("A 'safe' edge never closes a cycle."),
          t("Local optima compose into the global optimum here."),
        ],
      },
    }),
  },
  {
    id: "comparison_columns",
    name: "Comparison · columns",
    description:
      "Contrast 2–3 options as side-by-side columns (cards or bare badges), each a name + a few points; optional takeaway / shared-traits footer.",
    ai: {
      bestFor: ["comparing 2–3 options", "pros and cons side by side", "this vs that", "approach A vs approach B"],
      avoidWhen: ["many shared dimensions (use comparison_matrix)", "a single option", "a sequence (use process_steps)"],
    },
    schema: ComparisonColumnsContentSchema,
    seed: () => ({
      layoutId: "comparison_columns",
      content: {
        eyebrow: t("Compare"),
        title: t("Two ways to manage state"),
        subtitle: t("When to reach for each approach."),
        presentation: "cards",
        options: [
          {
            name: t("Local state"),
            icon: "lightbulb",
            points: [
              { label: t("Lives in one component"), detail: t("Simple to reason about and quick to add.") },
              { label: t("No extra libraries"), detail: t("Built into the framework.") },
              { label: t("Hard to share widely"), detail: t("Passing it deep gets unwieldy.") },
            ],
          },
          {
            name: t("Global store"),
            icon: "users",
            points: [
              { label: t("Shared across the app"), detail: t("Any component can read or update it.") },
              { label: t("Predictable updates"), detail: t("One place to trace every change.") },
              { label: t("More setup"), detail: t("Boilerplate and a learning curve.") },
            ],
          },
        ],
        footer: { kind: "summary", text: t("Start local; reach for a global store only when state is truly shared.") },
      },
    }),
  },
  {
    id: "comparison_matrix",
    name: "Comparison · matrix",
    description:
      "Contrast 2–3 options across shared dimensions as a matrix (options = columns, dimensions = rows); optional takeaway / shared-traits footer.",
    ai: {
      bestFor: ["comparing options across several shared dimensions", "a feature / spec matrix", "tradeoffs across criteria"],
      avoidWhen: ["only one or two attributes per option (use comparison_columns)", "a single option", "raw time-series data"],
    },
    schema: ComparisonMatrixContentSchema,
    seed: () => ({
      layoutId: "comparison_matrix",
      content: {
        eyebrow: t("Compare"),
        title: t("Choosing a database"),
        options: [
          { name: t("SQL"), icon: "document" },
          { name: t("Document"), icon: "search" },
          { name: t("Key-value"), icon: "gear" },
        ],
        dimensions: [
          {
            label: t("Data shape"),
            icon: "signpost",
            cells: [
              { detail: t("Rigid tables + relations") },
              { detail: t("Flexible JSON documents") },
              { detail: t("Simple key → value pairs") },
            ],
          },
          {
            label: t("Best for"),
            icon: "target",
            cells: [
              { detail: t("Complex queries"), example: t("e.g. reporting") },
              { detail: t("Evolving schemas"), example: t("e.g. catalogs") },
              { detail: t("Fast lookups"), example: t("e.g. caching") },
            ],
          },
          {
            label: t("Scaling"),
            icon: "trending-up",
            cells: [
              { detail: t("Vertical, then sharding") },
              { detail: t("Horizontal by design") },
              { detail: t("Horizontal, very fast") },
            ],
          },
        ],
        footer: {
          kind: "similarities",
          points: [t("All persist data durably"), t("All offer managed cloud options")],
        },
      },
    }),
  },
  {
    id: "diagram",
    name: "Diagram / graph",
    description:
      "A programmatic teaching VISUAL the renderer draws as crisp SVG — an economics graph, a chart, an array/search diagram, a tree, a node-link graph, a flowchart, a number line, or a Venn diagram. Accurate by construction; pick a diagram.kind (or an add_diagram templateId).",
    ai: {
      bestFor: [
        "a supply & demand / price-control graph",
        "a function, distribution, or regression plot",
        "a bar chart / data chart",
        "an array with pointers (two-pointers / sliding window / binary search)",
        "a tree (BST, traversal, recursion, hierarchy)",
        "a node-link graph (BFS/DFS, weighted/Dijkstra)",
        "a flowchart / decision diagram",
        "a number line / interval",
        "a 2-set Venn diagram",
      ],
      avoidWhen: ["a decorative picture", "content a text/table/code slide conveys more accurately", "a photo or illustration"],
    },
    schema: DiagramContentInputSchema,
    seed: (): SlideTemplate => ({
      layoutId: "diagram",
      content: {
        title: t("Market equilibrium"),
        caption: t("Price settles where the upward-sloping supply curve meets the downward-sloping demand curve — the equilibrium point E."),
        spec: {
          role: "graph",
          pedagogicalPurpose: "Show how the equilibrium price and quantity arise where supply meets demand.",
          altText:
            "A supply and demand graph with an upward-sloping supply curve and a downward-sloping demand curve intersecting at equilibrium point E, with dashed guides to P* on the price axis and Q* on the quantity axis.",
          requiredElements: ["upward-sloping supply curve", "downward-sloping demand curve", "labeled price/quantity axes", "equilibrium point"],
          placement: "center",
          source: "programmatic",
          mustBeAccurate: true,
          reason: "Supply and demand is conventionally taught with intersecting curves and a labeled equilibrium.",
        },
        diagram: findDiagramTemplate("supply_demand_equilibrium")!.seed(),
      } satisfies DiagramContent,
    }),
  },
  {
    id: "illustration",
    name: "Illustration (image)",
    description:
      "An educational IMAGE — generated by the AI (add_image) or uploaded — with required alt text, an optional title, caption, and supporting points. For a concept a picture conveys better than text when NO diagram type fits (a historical scene, a biological structure, a real-world analogy). Never for accuracy-critical figures — those are programmatic diagrams.",
    ai: {
      bestFor: ["a concept image", "a historical / real-world scene", "a biological or physical structure", "an evocative analogy picture"],
      avoidWhen: ["anything accuracy-critical (use a diagram)", "a chart / graph / labeled figure", "decorative-only filler", "content text conveys precisely"],
    },
    schema: IllustrationContentSchema,
    seed: (): SlideTemplate => ({
      layoutId: "illustration",
      content: {
        imageUrl: "",
        alt: "An educational illustration relevant to the lesson.",
        title: t("Illustration"),
        caption: t("A short caption explaining what the image shows and why it matters."),
        source: "upload",
      } satisfies IllustrationContent,
    }),
  },
];

export const STRUCTURED_LAYOUT_IDS = STRUCTURED_LAYOUTS.map((l) => l.id) as [
  StructuredLayoutId,
  ...StructuredLayoutId[],
];

/** The single repeating-item slot of the FLAT structured layouts, with its count
 *  bounds — drives the inspector's generic add/remove/reorder controls. Layouts
 *  with bespoke structure (section_break, concept_example, outline_list) are
 *  absent here and edited by their own inspector panels. */
export const ITEM_BOUNDS: Partial<
  Record<
    StructuredLayoutId,
    { key: string; min: number; max: number; blank: () => Record<string, unknown> }
  >
> = {
  process_steps: { key: "steps", min: 3, max: 5, blank: () => ({ sticker: "lightbulb", heading: { text: "New step" }, body: { text: "" } }) },
  key_concept: { key: "items", min: 2, max: 4, blank: () => ({ sticker: "lightbulb", heading: { text: "New point" }, body: { text: "" } }) },
  metrics_overview: { key: "metrics", min: 2, max: 4, blank: () => ({ sticker: "bar-chart", label: { text: "Metric" }, value: { text: "0" } }) },
  code_walkthrough_steps: { key: "steps", min: 2, max: 4, blank: () => ({ sticker: "lightbulb", heading: { text: "New step" }, body: { text: "" } }) },
};

export function findStructuredLayout(id: string): StructuredLayoutDef | undefined {
  return STRUCTURED_LAYOUTS.find((l) => l.id === id);
}

export function isStructuredLayoutId(id: string): id is StructuredLayoutId {
  return STRUCTURED_LAYOUTS.some((l) => l.id === id);
}

/**
 * Validate content for a layout against its STRICT schema. Returns [] on success
 * or human-readable errors (incl. length overflow with the max + actual) so the
 * agent self-corrects in-loop.
 */
export function validateStructuredContent(layoutId: string, content: unknown): string[] {
  const layout = findStructuredLayout(layoutId);
  if (!layout) {
    return [`Unknown structured layout "${layoutId}". Valid: ${STRUCTURED_LAYOUT_IDS.join(", ")}.`];
  }
  const res = layout.schema.safeParse(content);
  if (res.success) return [];
  return res.error.issues.map((i) => {
    const path = i.path.join(".") || "(root)";
    return `${path}: ${i.message}`;
  });
}

/** Compact AI catalog: id + when-to-use + slot summary. */
export function structuredLayoutCatalog() {
  return STRUCTURED_LAYOUTS.map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    bestFor: l.ai.bestFor,
    avoidWhen: l.ai.avoidWhen,
  }));
}
