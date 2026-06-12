/**
 * Zod schemas for the course document model.
 *
 * The hand-written interfaces in types.ts are the source of truth for the
 * document; each schema here is pinned with `satisfies z.ZodType<X>` so the
 * two can never silently drift. Patches (the actual validation boundary for
 * AI-generated input) are Zod-first instead — see patches.ts.
 */

import { z } from "zod";
import type {
  AIMeta,
  CourseDocument,
  CourseModule,
  CourseTheme,
  ElementStyle,
  HomeworkExercise,
  LectureParagraph,
  LessonBlock,
  LessonNode,
  QuizQuestion,
  RubricCriterion,
  Slide,
  SlideBackground,
  SlideElement,
  SlideStyle,
  SlideThemeRef,
} from "./types";

export const AIMetaSchema = z.object({
  purpose: z.string(),
  editable: z.boolean(),
  allowedActions: z.array(z.string()),
  semanticTags: z.array(z.string()),
  qualityHints: z.array(z.string()).optional(),
}) satisfies z.ZodType<AIMeta>;

/* ───────────────────────────── Slides ─────────────────────────────────── */

export const FontFamilyIdSchema = z.enum(["sans", "serif", "mono"]);
export const FontWeightSchema = z.enum(["regular", "medium", "semibold", "bold"]);

export const ElementShadowSchema = z.object({
  color: z.string(),
  blur: z.number().min(0),
  offsetX: z.number(),
  offsetY: z.number(),
  opacity: z.number().min(0).max(1),
});

export const ElementStyleSchema = z.object({
  fontFamily: FontFamilyIdSchema.optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: FontWeightSchema.optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: z.string().optional(),
  backgroundColor: z.string().optional(),
  borderColor: z.string().optional(),
  borderWidth: z.number().min(0).optional(),
  borderStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  borderRadius: z.number().min(0).optional(),
  opacity: z.number().min(0).max(1).optional(),
  textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  lineHeight: z.number().positive().optional(),
  letterSpacing: z.number().optional(),
  padding: z.number().min(0).optional(),
  shadow: ElementShadowSchema.optional(),
}) satisfies z.ZodType<ElementStyle>;

export const ShapeKindSchema = z.enum(["rectangle", "ellipse", "triangle", "line", "arrow"]);

/** Frame-fraction endpoints for line/arrow shapes. */
export const LineGeometrySchema = z.object({
  x1: z.number().min(0).max(1),
  y1: z.number().min(0).max(1),
  x2: z.number().min(0).max(1),
  y2: z.number().min(0).max(1),
});
export const CalloutVariantSchema = z.enum([
  "info",
  "tip",
  "warning",
  "definition",
  "important",
]);

const elementBaseShape = {
  id: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  // NOTE: `rotation` exists on the TS type (and still renders for legacy
  // data) but is deliberately ABSENT here — selection chrome, snapping, and
  // hit-testing are axis-aligned, so validated patches must not introduce
  // rotated elements until rotation gets first-class editor support
  // (AUDIT.md #3). Zod strips the key from any incoming element.
  zIndex: z.number().int(),
  locked: z.boolean().optional(),
  visible: z.boolean().optional(),
  groupPath: z.array(z.string()).optional(),
  style: ElementStyleSchema,
  ai: AIMetaSchema,
};

export const ImageCropSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** Exported separately so INSERT_IMAGE can require an image element without
 *  wrapping the discriminated union in a refinement. */
export const ImageElementSchema = z.object({
  ...elementBaseShape,
  type: z.literal("image"),
  src: z.string(),
  alt: z.string(),
  objectFit: z.enum(["cover", "contain"]),
  crop: ImageCropSchema.optional(),
  caption: z.string().optional(),
  attribution: z.string().optional(),
});

export const TextMarksSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: z.string().optional(),
});

export const TextRunSchema = z.object({
  text: z.string(),
  marks: TextMarksSchema.optional(),
});

export const SlideElementSchema = z.discriminatedUnion("type", [
  z.object({
    ...elementBaseShape,
    type: z.literal("text"),
    text: z.string(),
    runs: z.array(TextRunSchema).optional(),
  }),
  z.object({
    ...elementBaseShape,
    type: z.literal("heading"),
    text: z.string(),
    runs: z.array(TextRunSchema).optional(),
  }),
  z.object({
    ...elementBaseShape,
    type: z.literal("bullet_list"),
    items: z.array(z.string()),
  }),
  z.object({
    ...elementBaseShape,
    type: z.literal("code_block"),
    code: z.string(),
    language: z.string(),
  }),
  ImageElementSchema,
  z.object({
    ...elementBaseShape,
    type: z.literal("shape"),
    shape: ShapeKindSchema,
    points: LineGeometrySchema.optional(),
  }),
  z.object({
    ...elementBaseShape,
    type: z.literal("callout"),
    text: z.string(),
    variant: CalloutVariantSchema,
    runs: z.array(TextRunSchema).optional(),
  }),
  z.object({
    ...elementBaseShape,
    type: z.literal("divider"),
    orientation: z.enum(["horizontal", "vertical"]),
  }),
  z.object({
    ...elementBaseShape,
    type: z.literal("table"),
    rows: z.array(z.array(z.string())),
    headerRow: z.boolean(),
  }),
]) satisfies z.ZodType<SlideElement>;

export const GradientDirectionSchema = z.enum(["to-r", "to-br", "to-b", "to-tr"]);

export const SlideBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solid"), color: z.string() }),
  z.object({
    type: z.literal("gradient"),
    gradient: z.object({
      from: z.string(),
      to: z.string(),
      direction: GradientDirectionSchema,
    }),
  }),
  z.object({
    type: z.literal("image"),
    imageSrc: z.string(),
    overlayColor: z.string().optional(),
    overlayOpacity: z.number().min(0).max(1).optional(),
  }),
]) satisfies z.ZodType<SlideBackground>;

export const SlideThemeIdSchema = z.enum([
  "minimal-light",
  "editorial-warm",
  "dark-classroom",
  "competition-prep",
  "warm-notebook",
]);

export const SlideThemeRefSchema = z.object({
  id: SlideThemeIdSchema,
  name: z.string(),
  accentColor: z.string(),
  fontFamily: FontFamilyIdSchema,
}) satisfies z.ZodType<SlideThemeRef>;

export const SlideStyleSchema = z.object({
  background: SlideBackgroundSchema,
  theme: SlideThemeRefSchema,
}) satisfies z.ZodType<SlideStyle>;

export const SlideSchema = z.object({
  id: z.string(),
  type: z.literal("slide"),
  title: z.string().optional(),
  layout: z.string(),
  style: SlideStyleSchema,
  elements: z.array(SlideElementSchema),
  speakerNotes: z.string().optional(),
  order: z.number().int(),
  ai: z.object({
    purpose: z.string().optional(),
    formattingRules: z.array(z.string()),
    qualityChecks: z.array(z.string()),
    allowedActions: z.array(z.string()),
  }),
}) satisfies z.ZodType<Slide>;

export const LayoutPlaceholderSchema = z.object({
  role: z.string(),
  type: z.enum([
    "text",
    "heading",
    "bullet_list",
    "code_block",
    "image",
    "shape",
    "callout",
    "divider",
    "table",
  ]),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  seedText: z.string().optional(),
  style: ElementStyleSchema.optional(),
});

/* ───────────────────────────── Blocks ─────────────────────────────────── */

const baseBlockShape = {
  id: z.string(),
  title: z.string().optional(),
  order: z.number().int(),
  ai: AIMetaSchema,
};

export const LectureToneSchema = z.enum([
  "beginner",
  "concise",
  "detailed",
  "socratic",
]);

export const LectureParagraphSchema = z.object({
  id: z.string(),
  kind: z.enum(["paragraph", "key_idea", "aside"]),
  text: z.string(),
}) satisfies z.ZodType<LectureParagraph>;

export const QuizDifficultySchema = z.enum(["easy", "medium", "hard"]);

const quizQuestionBaseShape = {
  id: z.string(),
  prompt: z.string(),
  explanation: z.string().optional(),
  difficulty: QuizDifficultySchema,
};

export const QuizQuestionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...quizQuestionBaseShape,
    kind: z.literal("multiple_choice"),
    choices: z.array(z.object({ id: z.string(), text: z.string() })),
    correctChoiceId: z.string(),
  }),
  z.object({
    ...quizQuestionBaseShape,
    kind: z.literal("true_false"),
    correctAnswer: z.boolean(),
  }),
  z.object({
    ...quizQuestionBaseShape,
    kind: z.literal("short_answer"),
    expectedAnswer: z.string(),
  }),
]) satisfies z.ZodType<QuizQuestion>;

export const HomeworkExerciseSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  hint: z.string().optional(),
  solution: z.string().optional(),
}) satisfies z.ZodType<HomeworkExercise>;

export const RubricCriterionSchema = z.object({
  id: z.string(),
  name: z.string(),
  points: z.number(),
  description: z.string().optional(),
}) satisfies z.ZodType<RubricCriterion>;

export const LessonBlockSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseBlockShape,
    type: z.literal("slide_deck"),
    slides: z.array(SlideSchema),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("lecture_text"),
    tone: LectureToneSchema,
    paragraphs: z.array(LectureParagraphSchema),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("quiz"),
    questions: z.array(QuizQuestionSchema),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("homework"),
    instructions: z.string(),
    exercises: z.array(HomeworkExerciseSchema),
    rubric: z.array(RubricCriterionSchema).optional(),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("exercise"),
    prompt: z.string(),
    hint: z.string().optional(),
    solution: z.string().optional(),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("example"),
    context: z.string(),
    explanation: z.string(),
    steps: z.array(z.string()),
    takeaway: z.string(),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("resource"),
    links: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        url: z.string(),
        note: z.string().optional(),
      })
    ),
  }),
]) satisfies z.ZodType<LessonBlock>;

/* ─────────────────────── Lessons / modules / course ───────────────────── */

export const LessonNodeSchema = z.object({
  id: z.string(),
  type: z.literal("lesson"),
  title: z.string(),
  objective: z.string().optional(),
  order: z.number().int(),
  estimatedMinutes: z.number().optional(),
  blocks: z.array(LessonBlockSchema),
}) satisfies z.ZodType<LessonNode>;

export const CourseModuleSchema = z.object({
  id: z.string(),
  type: z.literal("module"),
  title: z.string(),
  description: z.string().optional(),
  order: z.number().int(),
  lessons: z.array(LessonNodeSchema),
}) satisfies z.ZodType<CourseModule>;

export const CourseThemeSchema = z.object({
  name: z.string(),
  accent: z.enum(["violet", "emerald", "sky", "amber"]),
  slideDefaults: z.object({
    layout: z.string(),
    themeId: SlideThemeIdSchema,
  }),
}) satisfies z.ZodType<CourseTheme>;

export const CourseDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  audience: z.string().optional(),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  modules: z.array(CourseModuleSchema),
  theme: CourseThemeSchema,
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    ownerId: z.string().optional(),
    aiReadableVersion: z.literal("1.0"),
  }),
}) satisfies z.ZodType<CourseDocument>;
