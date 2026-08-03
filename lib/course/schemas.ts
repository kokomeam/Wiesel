/**
 * Zod schemas for the course document model.
 *
 * The hand-written interfaces in types.ts are the source of truth for the
 * document; each schema here is pinned with `satisfies z.ZodType<X>` so the
 * two can never silently drift. Patches (the actual validation boundary for
 * AI-generated input) are Zod-first instead — see patches.ts.
 */

import { z } from "zod";
import { DiagramContentStorageSchema } from "./diagram/schemas";
import type {
  AIMeta,
  CourseDocument,
  CourseModule,
  CoursePlan,
  CourseTheme,
  ElementStyle,
  HomeworkExercise,
  LectureParagraph,
  LessonBlock,
  LessonNode,
  QuizQuestion,
  QuizSettings,
  RichText,
  RubricCriterion,
  RubricLevel,
  Slide,
  SlideBackground,
  SlideElement,
  SlideListContent,
  SlideListItem,
  SlideListLevelStyle,
  SlideStyle,
  SlideTemplate,
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

export const FontFamilyIdSchema = z.enum(["sans", "serif", "mono", "display"]);
export const FontScaleSchema = z.enum(["display", "title", "heading", "body", "caption"]);
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
  fontScale: FontScaleSchema.optional(),
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
  // Additive provenance for materialize-on-eject (see types.ts). Optional so
  // every pre-existing slide validates unchanged; Zod would otherwise strip
  // these keys off a materialized element on the SET_SLIDE_CONTENT boundary.
  role: z.string().optional(),
  origin: z.enum(["ai", "human"]).optional(),
  userModified: z
    .object({
      frame: z.boolean().optional(),
      style: z.boolean().optional(),
      content: z.boolean().optional(),
    })
    .optional(),
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

export const ListMarkerKindSchema = z.enum([
  "disc",
  "circle",
  "square",
  "dash",
  "number",
  "alpha",
  "roman",
  "none",
]);

export const SlideListItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  runs: z.array(TextRunSchema).optional(),
  level: z.number().int().min(0),
  markerKind: ListMarkerKindSchema.optional(),
  markerText: z.string().optional(),
  markerColor: z.string().optional(),
  textColor: z.string().optional(),
}) satisfies z.ZodType<SlideListItem>;

export const SlideListLevelStyleSchema = z.object({
  markerKind: ListMarkerKindSchema.optional(),
  markerColor: z.string().optional(),
  textColor: z.string().optional(),
  fontSize: z.number().positive().optional(),
  lineHeight: z.number().positive().optional(),
  indent: z.number().optional(),
  hangingIndent: z.number().optional(),
}) satisfies z.ZodType<SlideListLevelStyle>;

export const SlideListContentSchema = z.object({
  items: z.array(SlideListItemSchema),
  defaultMarkerKind: ListMarkerKindSchema,
  startNumber: z.number().int().optional(),
  markerColor: z.string().optional(),
  textColor: z.string().optional(),
  levelStyles: z.array(SlideListLevelStyleSchema).optional(),
  paragraphSpacing: z.number().optional(),
}) satisfies z.ZodType<SlideListContent>;

export const SlideElementSchema = z.discriminatedUnion("type", [
  z.object({
    ...elementBaseShape,
    type: z.literal("text"),
    text: z.string(),
    runs: z.array(TextRunSchema).optional(),
    // Optional list layer: lines toggled to bullets/numbers inside a text box.
    list: SlideListContentSchema.optional(),
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
    // Optional rich layer (markers / nesting / per-item runs + colors). Absent
    // on legacy decks — `items` is the plain fallback the renderer normalizes.
    list: SlideListContentSchema.optional(),
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
  z.object({
    ...elementBaseShape,
    type: z.literal("sticker"),
    // Permissive at the storage layer (a removed registry id must not break
    // loading an old slide — the renderer falls back). The AI TOOL boundary
    // constrains this to the live registry with a strict enum.
    stickerId: z.string(),
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

/* ── Structured (renderer-owned) layout content — PERMISSIVE storage schema.
   No length/count caps here so loading an old slide never breaks; the TIGHT,
   length-enforcing schemas live in structuredLayouts.ts and gate AI input. */
export const RichTextSchema = z.object({
  text: z.string(),
  runs: z.array(TextRunSchema).optional(),
}) satisfies z.ZodType<RichText>;

const StepItemSchema = z.object({
  sticker: z.string().optional(),
  heading: RichTextSchema,
  body: RichTextSchema,
});
const MetricItemSchema = z.object({
  sticker: z.string().optional(),
  label: RichTextSchema,
  value: RichTextSchema,
  delta: z
    .object({
      direction: z.enum(["up", "down"]),
      text: RichTextSchema,
      sentiment: z.enum(["positive", "negative", "neutral"]),
    })
    .optional(),
});

const DecorLevelSchema = z.enum(["full", "minimal"]);
const TitleStyleSchema = z.enum(["sans", "serif"]);
const ConceptExampleBodyStorageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paragraphs"), paragraphs: z.array(RichTextSchema) }),
  z.object({
    kind: z.literal("steps"),
    steps: z.array(z.object({ heading: RichTextSchema, body: RichTextSchema })),
  }),
]);
const ComparisonFooterStorageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("summary"), text: RichTextSchema }),
  z.object({ kind: z.literal("similarities"), points: z.array(RichTextSchema) }),
]);
/** Permissive storage for the pending-image-generation marker on an image slide. */
const PendingGenStorageSchema = z.object({
  status: z.enum(["pending", "failed"]),
  visualWeight: z.enum(["reference", "supporting"]),
  prompt: z.string(),
  subject: z.string().optional(),
  requiredLabels: z.array(z.string()).optional(),
  axes: z.object({ x: z.string().optional(), y: z.string().optional() }).optional(),
  annotations: z.array(z.string()).optional(),
  alt: z.string(),
});

export const SlideTemplateSchema = z.discriminatedUnion("layoutId", [
  z.object({
    layoutId: z.literal("process_steps"),
    content: z.object({
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      subtitle: RichTextSchema.optional(),
      steps: z.array(StepItemSchema),
    }),
  }),
  z.object({
    layoutId: z.literal("key_concept"),
    content: z.object({
      variant: z.enum(["sans", "serif"]),
      spine: z.boolean().optional(),
      eyebrow: RichTextSchema.optional(),
      term: RichTextSchema,
      definition: RichTextSchema,
      items: z.array(z.object({ sticker: z.string().optional(), heading: RichTextSchema, body: RichTextSchema })),
    }),
  }),
  z.object({
    layoutId: z.literal("metrics_overview"),
    content: z.object({
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      metrics: z.array(MetricItemSchema),
    }),
  }),
  z.object({
    layoutId: z.literal("code_walkthrough_steps"),
    content: z.object({
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      code: z.object({ language: z.string(), code: z.string() }),
      steps: z.array(StepItemSchema),
    }),
  }),
  z.object({
    layoutId: z.literal("section_break"),
    content: z.object({
      number: z.string().optional(),
      label: RichTextSchema,
      title: RichTextSchema,
      subtitle: RichTextSchema.optional(),
      titleStyle: TitleStyleSchema.optional(),
      variant: z.enum(["standard", "hero_numeral"]).optional(),
      decor: DecorLevelSchema.optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("concept_example"),
    content: z.object({
      concept: z.object({
        badge: z.string().optional(),
        title: RichTextSchema,
        titleStyle: TitleStyleSchema.optional(),
        definition: RichTextSchema,
      }),
      example: z.object({
        badge: z.string().optional(),
        title: RichTextSchema.optional(),
        body: ConceptExampleBodyStorageSchema,
      }),
      footnote: RichTextSchema.optional(),
      decor: DecorLevelSchema.optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("outline_list"),
    content: z.object({
      title: RichTextSchema,
      items: z.array(
        z.object({ text: RichTextSchema, subItems: z.array(RichTextSchema).optional() })
      ),
      decor: DecorLevelSchema.optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("prose"),
    content: z.object({
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      body: RichTextSchema,
      points: z.array(RichTextSchema).optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("comparison_columns"),
    content: z.object({
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      subtitle: RichTextSchema.optional(),
      presentation: z.enum(["cards", "bare"]).optional(),
      options: z.array(
        z.object({
          name: RichTextSchema,
          icon: z.string().optional(),
          points: z.array(z.object({ label: RichTextSchema, detail: RichTextSchema.optional() })),
        })
      ),
      footer: ComparisonFooterStorageSchema.optional(),
      decor: DecorLevelSchema.optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("comparison_matrix"),
    content: z.object({
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      subtitle: RichTextSchema.optional(),
      options: z.array(z.object({ name: RichTextSchema, icon: z.string().optional() })),
      dimensions: z.array(
        z.object({
          label: RichTextSchema,
          icon: z.string().optional(),
          cells: z.array(z.object({ detail: RichTextSchema, example: RichTextSchema.optional() })),
        })
      ),
      footer: ComparisonFooterStorageSchema.optional(),
      decor: DecorLevelSchema.optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("diagram"),
    content: DiagramContentStorageSchema,
  }),
  z.object({
    layoutId: z.literal("illustration"),
    content: z.object({
      imageUrl: z.string(),
      alt: z.string(),
      title: RichTextSchema.optional(),
      caption: RichTextSchema.optional(),
      points: z.array(RichTextSchema).optional(),
      source: z.enum(["ai_generated", "upload"]).optional(),
      storagePath: z.string().optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("image_reference"),
    content: z.object({
      imageUrl: z.string(),
      alt: z.string(),
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      annotations: z.array(z.object({ label: RichTextSchema, description: RichTextSchema })).optional(),
      cards: z.array(z.object({ title: RichTextSchema, description: RichTextSchema })).optional(),
      source: z.enum(["ai_generated", "upload"]).optional(),
      storagePath: z.string().optional(),
      intentHash: z.string().optional(),
      pendingGen: PendingGenStorageSchema.optional(),
    }),
  }),
  z.object({
    layoutId: z.literal("image_supporting"),
    content: z.object({
      imageUrl: z.string(),
      alt: z.string(),
      eyebrow: RichTextSchema.optional(),
      title: RichTextSchema,
      lead: RichTextSchema.optional(),
      bullets: z.array(RichTextSchema).optional(),
      caption: RichTextSchema.optional(),
      source: z.enum(["ai_generated", "upload"]).optional(),
      storagePath: z.string().optional(),
      intentHash: z.string().optional(),
      pendingGen: PendingGenStorageSchema.optional(),
    }),
  }),
]) satisfies z.ZodType<SlideTemplate>;

export const SlideSchema = z.object({
  id: z.string(),
  type: z.literal("slide"),
  title: z.string().optional(),
  layout: z.string(),
  style: SlideStyleSchema,
  elements: z.array(SlideElementSchema),
  template: SlideTemplateSchema.optional(),
  backdrop: z.literal("structured").optional(),
  speakerNotes: z.string().optional(),
  order: z.number().int(),
  ai: z.object({
    purpose: z.string().optional(),
    formattingRules: z.array(z.string()),
    qualityChecks: z.array(z.string()),
    allowedActions: z.array(z.string()),
    specId: z.string().optional(),
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
    "sticker",
  ]),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  seedText: z.string().optional(),
  style: ElementStyleSchema.optional(),
});

/* ───────────────────────────── Blocks ─────────────────────────────────── */

/** Shared block envelope fields. Exported so the publish snapshot schema
 *  (lib/course/publish/schemas.ts) can build its answer-key-stripped quiz
 *  block without duplicating the shape. */
export const baseBlockShape = {
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

export const QuizSettingsSchema = z.object({
  shuffleQuestions: z.boolean().optional(),
  shuffleOptions: z.boolean().optional(),
}) satisfies z.ZodType<QuizSettings>;

const quizQuestionBaseShape = {
  id: z.string(),
  prompt: z.string(),
  explanation: z.string().optional(),
  objectiveId: z.string().optional(),
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
    kind: z.literal("multi_select"),
    choices: z.array(z.object({ id: z.string(), text: z.string() })),
    correctChoiceIds: z.array(z.string()),
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
    acceptedAnswers: z.array(z.string()).optional(),
  }),
]) satisfies z.ZodType<QuizQuestion>;

export const HomeworkExerciseSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  hint: z.string().optional(),
  solution: z.string().optional(),
}) satisfies z.ZodType<HomeworkExercise>;

export const RubricLevelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
}) satisfies z.ZodType<RubricLevel>;

export const RubricCriterionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  levels: z.array(RubricLevelSchema),
}) satisfies z.ZodType<RubricCriterion>;

export const LessonBlockSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseBlockShape,
    type: z.literal("slide_deck"),
    slides: z.array(SlideSchema),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("imported_deck"),
    deckImportId: z.string(),
    sourceType: z.enum(["upload", "google_drive", "onedrive"]),
    originalFileName: z.string(),
    originalMimeType: z.string(),
    originalFileSize: z.number().int().nonnegative(),
    status: z.enum(["uploaded", "processing", "ready", "failed"]),
    pageCount: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("video"),
    description: z.string().optional(),
    asset: z.object({
      provider: z.literal("mux"),
      status: z.enum(["empty", "uploading", "processing", "ready", "failed"]),
      videoAssetId: z.string().optional(),
      uploadId: z.string().optional(),
      assetId: z.string().optional(),
      playbackId: z.string().optional(),
      durationSeconds: z.number().nonnegative().optional(),
      aspectRatio: z.string().optional(),
      thumbnailUrl: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
    recording: z.object({
      mode: z.enum(["screen_camera", "camera_only", "screen_only"]).optional(),
      layout: z
        .enum(["screen_with_camera_bubble", "camera_full", "screen_full"])
        .optional(),
      cameraBubblePosition: z
        .enum(["bottom-right", "bottom-left", "top-right", "top-left"])
        .optional(),
      includeMic: z.boolean().optional(),
      // M-R: all optional — legacy recordings/uploads simply lack them.
      slideSync: z
        .array(z.object({ slideId: z.string(), atMs: z.number().int().nonnegative() }))
        .optional(),
      pipGeometry: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          corner: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]),
        })
        .optional(),
      dualCameraAssetRowId: z.string().optional(),
    }),
    edit: z.object({
      trimStartSeconds: z.number().nonnegative().optional(),
      trimEndSeconds: z.number().nonnegative().optional(),
    }),
    settings: z.object({
      showControls: z.boolean(),
      allowDownload: z.boolean(),
      showTranscript: z.boolean(),
      showChapters: z.boolean(),
    }),
    captions: z
      .object({
        status: z.enum(["none", "generating", "ready", "failed"]),
        trackId: z.string().optional(),
        trackName: z.string().optional(),
        languageCode: z.string().optional(),
        source: z.enum(["generated", "uploaded"]).optional(),
        error: z.string().optional(),
        updatedAt: z.string().optional(),
      })
      .optional(),
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
    settings: QuizSettingsSchema.optional(),
    questions: z.array(QuizQuestionSchema),
  }),
  z.object({
    ...baseBlockShape,
    type: z.literal("homework"),
    instructions: z.string(),
    deliverableType: z.enum(["none", "text_response", "file_upload", "external_link"]),
    estimatedMinutes: z.number().min(0).optional(),
    objectiveId: z.string().optional(),
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

export const CoursePlanSchema = z.object({
  category: z.string().optional(),
  outcomes: z.array(z.string()),
  prerequisites: z.array(z.string()),
  teachingStyle: z.string().optional(),
}) satisfies z.ZodType<CoursePlan>;

export const CourseDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  audience: z.string().optional(),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  plan: CoursePlanSchema,
  modules: z.array(CourseModuleSchema),
  theme: CourseThemeSchema,
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    ownerId: z.string().optional(),
    aiReadableVersion: z.literal("1.0"),
  }),
}) satisfies z.ZodType<CourseDocument>;
