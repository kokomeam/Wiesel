/**
 * CourseGen Pro — structured course document model.
 *
 * The entire course is one JSON-serializable document. Every node carries a
 * stable string `id`, an explicit integer `order`, and (for blocks) an `ai`
 * envelope describing purpose + allowed actions, so both humans and AI agents
 * can inspect and safely modify the course.
 *
 * Designed to map cleanly to Supabase/Postgres later: courses / modules /
 * lessons as rows, blocks as jsonb, ISO-8601 timestamps throughout.
 */

/* ───────────────────────── AI metadata envelope ───────────────────────── */

export interface AIMeta {
  /** What this node is for, in plain language an agent can reason about. */
  purpose: string;
  editable: boolean;
  /** Patch-action names this node supports (see patches.ts). */
  allowedActions: string[];
  semanticTags: string[];
  qualityHints?: string[];
}

/* ───────────────────────────── Slides ─────────────────────────────────── */
/* Slides are a 1280×720 logical canvas of absolutely positioned elements
 * (see lib/course/slide/geometry.ts). Styles are optional overrides — the
 * slide's theme supplies defaults (lib/course/slide/styleResolver.ts). */

/** `display` = the editorial Fraunces serif, for key-concept / section titles. */
export type FontFamilyId = "sans" | "serif" | "mono" | "display";
export type FontWeight = "regular" | "medium" | "semibold" | "bold";

/** Semantic type-scale token. Resolves to per-theme px (themes.ts `typeScale`).
 *  Preferred over raw `fontSize` so text stays on a consistent scale; the
 *  human picker and the AI both choose from this enum. */
export type FontScaleToken = "display" | "title" | "heading" | "body" | "caption";

/** Expressive shadow model; the UI exposes presets (None/Subtle/Medium/
 *  Strong) that map onto it, so AI/import paths can still set custom values. */
export interface ElementShadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
  /** 0..1 */
  opacity: number;
}

export interface ElementStyle {
  fontFamily?: FontFamilyId;
  /** Semantic size token; resolves to per-theme px and WINS over `fontSize`.
   *  New content sets this; the toolbar size control writes it. */
  fontScale?: FontScaleToken;
  /** Legacy raw px (1280×720 canvas units). Still rendered when no `fontScale`
   *  is set, but the toolbar no longer exposes it. */
  fontSize?: number;
  fontWeight?: FontWeight;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderStyle?: "solid" | "dashed" | "dotted";
  borderRadius?: number;
  /** 0..1 */
  opacity?: number;
  textAlign?: "left" | "center" | "right" | "justify";
  verticalAlign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  letterSpacing?: number;
  padding?: number;
  shadow?: ElementShadow;
}

export type ShapeKind = "rectangle" | "ellipse" | "triangle" | "line" | "arrow";

/** Line/arrow endpoint geometry as FRACTIONS of the element frame (0..1):
 *  moving/resizing the frame transforms the line for free, and the frame
 *  stays the selection/snap/marquee AABB. Absent = horizontal mid-line
 *  (legacy default), so old documents render unchanged. */
export interface LineGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export type CalloutVariant = "info" | "tip" | "warning" | "definition" | "important";

/** Character-level formatting marks for one run of text. */
export interface TextMarks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Overrides the element/theme text color for this run only. */
  color?: string;
}

/**
 * Rich text = an array of runs. INVARIANT (maintained by the reducer):
 * concat(runs[].text) === the element's plain `text`, so lint, AI rules,
 * measurement, and search keep reading `text` unchanged. Updating `text`
 * WITHOUT runs clears the runs (a plain rewrite resets formatting).
 */
export interface TextRun {
  text: string;
  marks?: TextMarks;
}

export interface SlideElementBase {
  id: string;
  /** Logical canvas coordinates (1280×720 space). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees; stored + rendered, no editing UI yet. */
  rotation?: number;
  zIndex: number;
  locked?: boolean;
  /** Default true. */
  visible?: boolean;
  /**
   * Nested-group membership: the chain of group ids from outermost to the
   * element's immediate group (Google-Slides-style groups-in-groups).
   * Absent/empty = ungrouped. Maintained exclusively by GROUP_ELEMENTS /
   * UNGROUP_ELEMENTS / normalizeGroups in patches.ts.
   */
  groupPath?: string[];
  style: ElementStyle;
  ai: AIMeta;
}

export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SlideElement = SlideElementBase &
  (
    | { type: "text"; text: string; runs?: TextRun[] }
    | { type: "heading"; text: string; runs?: TextRun[] }
    | { type: "bullet_list"; items: string[] }
    | { type: "code_block"; code: string; language: string }
    | {
        type: "image";
        src: string;
        /** Required — accessibility and AI both depend on it. */
        alt: string;
        objectFit: "cover" | "contain";
        crop?: ImageCrop;
        caption?: string;
        attribution?: string;
      }
    | { type: "shape"; shape: ShapeKind; points?: LineGeometry }
    | { type: "callout"; text: string; variant: CalloutVariant; runs?: TextRun[] }
    | { type: "divider"; orientation: "horizontal" | "vertical" }
    | { type: "table"; rows: string[][]; headerRow: boolean }
    /** Inline icon primitive: a lucide glyph referenced by id from the shared
     *  sticker registry, themed to the slide accent. Never raw SVG. */
    | { type: "sticker"; stickerId: string }
  );

export type SlideElementType = SlideElement["type"];

export type GradientDirection = "to-r" | "to-br" | "to-b" | "to-tr";

export type SlideBackground =
  | { type: "solid"; color: string }
  | {
      type: "gradient";
      gradient: { from: string; to: string; direction: GradientDirection };
    }
  | {
      type: "image";
      imageSrc: string;
      overlayColor?: string;
      /** 0..1 */
      overlayOpacity?: number;
    };

export type SlideThemeId =
  | "minimal-light"
  | "editorial-warm"
  | "dark-classroom"
  | "competition-prep"
  | "warm-notebook";

/** Denormalized theme snapshot stored on each slide so the document JSON is
 *  self-describing for AI agents. Resolved from lib/course/slide/themes.ts. */
export interface SlideThemeRef {
  id: SlideThemeId;
  name: string;
  accentColor: string;
  fontFamily: FontFamilyId;
}

export interface SlideStyle {
  background: SlideBackground;
  theme: SlideThemeRef;
}

/* ───────────── Structured (renderer-owned) layout content ──────────────── */

/** A rich-text value for a structured slot. Invariant: `text` === concat of
 *  `runs` (when present), so length checks + lint read plain text. */
export interface RichText {
  text: string;
  runs?: TextRun[];
}

export interface StepItem {
  /** Sticker id (icon) for the step card; renderer auto-numbers by position. */
  sticker?: string;
  heading: RichText;
  body: RichText;
}

export interface ProcessContent {
  eyebrow?: RichText;
  title: RichText;
  subtitle?: RichText;
  steps: StepItem[];
}

export interface ConceptItem {
  sticker?: string;
  heading: RichText;
  body: RichText;
}

export interface KeyConceptContent {
  /** `serif` uses the editorial display title (cgref2); `sans` is plainer (cgref4). */
  variant: "sans" | "serif";
  /** Draw the thin connector spine + node dots between the right-hand items. */
  spine?: boolean;
  eyebrow?: RichText;
  term: RichText;
  definition: RichText;
  items: ConceptItem[];
}

export interface MetricDelta {
  direction: "up" | "down";
  text: RichText;
  /** Colors the delta: positive = accent, negative = cool/muted, neutral = muted. */
  sentiment: "positive" | "negative" | "neutral";
}

export interface MetricItem {
  sticker?: string;
  label: RichText;
  /** Free-form display string: "67.8%", "12,345", "3.2×", "$4.1M". */
  value: RichText;
  delta?: MetricDelta;
}

export interface MetricsContent {
  eyebrow?: RichText;
  title: RichText;
  metrics: MetricItem[];
}

export interface CodeStepItem {
  sticker?: string;
  heading: RichText;
  body: RichText;
}

export interface CodeContent {
  language: string;
  code: string;
}

export interface CodeWalkthroughContent {
  eyebrow?: RichText;
  title: RichText;
  code: CodeContent;
  steps: CodeStepItem[];
}

/** How much renderer-owned flair a structured layout draws. `full` is the
 *  decorated default (corner arcs, dot-grids, giant numerals, rules); `minimal`
 *  dials it back so the layout still reads on a busy theme. Renderer-owned and
 *  human-toggled only — the AI never sets it (it's absent from the strict tool
 *  schema), so the model can never request or position decoration. */
export type DecorLevel = "full" | "minimal";

/** Chapter/section transition slide (refs 1–4 = one layout, variant flags).
 *  Renderer owns the kicker rule, accent underline, giant outline numeral
 *  (hero), corner arcs / dot-grids and two-tone title coloring. */
export interface SectionBreakContent {
  /** Short section number shown in the kicker (and giant in `hero_numeral`). */
  number?: string;
  /** Section name beside the number, e.g. "Foundations". */
  label: RichText;
  title: RichText;
  subtitle?: RichText;
  /** `serif` = editorial display title (default); `sans` = plainer. Serif also
   *  drives the renderer's two-tone accent on the last word. */
  titleStyle?: "sans" | "serif";
  /** `hero_numeral` draws the giant outline number; `standard` is the default. */
  variant?: "standard" | "hero_numeral";
  decor?: DecorLevel;
}

export interface ConceptExampleConcept {
  /** Small pill, e.g. "Rule" / "Concept". */
  badge?: string;
  title: RichText;
  titleStyle?: "sans" | "serif";
  definition: RichText;
}

export interface ConceptExampleStep {
  heading: RichText;
  body: RichText;
}

/** The worked example's body: free prose paragraphs OR numbered steps. */
export type ConceptExampleBody =
  | { kind: "paragraphs"; paragraphs: RichText[] }
  | { kind: "steps"; steps: ConceptExampleStep[] };

export interface ConceptExampleExample {
  badge?: string;
  title?: RichText;
  body: ConceptExampleBody;
}

/** Pairs an abstract rule/concept (left) with a worked example (right). */
export interface ConceptExampleContent {
  concept: ConceptExampleConcept;
  example: ConceptExampleExample;
  /** Optional bottom callout (a caveat / "in practice" note). */
  footnote?: RichText;
  decor?: DecorLevel;
}

export interface OutlineItem {
  text: RichText;
  /** Optional brief breakdown (renderer indents these); 0–2 per item. */
  subItems?: RichText[];
}

/** A titled nested list — a lesson's objectives or a module table of contents. */
export interface OutlineListContent {
  title: RichText;
  items: OutlineItem[];
  decor?: DecorLevel;
}

/** A plain-but-substantive teaching text slide — a deliberate, plan-selectable
 *  layout (NOT a fallback): a title + a real explanatory body + optional key
 *  points. The renderer owns the typography; the AI fills real prose. */
export interface ProseContent {
  eyebrow?: RichText;
  title: RichText;
  /** The explanation — full sentences that actually teach the point. */
  body: RichText;
  /** Optional key takeaways (0–5). */
  points?: RichText[];
}

/* ── Comparison layouts (contrast 2–3 options). The renderer owns ALL
 *    decoration: option colors + letter badges assigned BY INDEX (A/B/C), the
 *    "VS." divider (two-option columnar only), row striping, and the footer
 *    tint + icon. The AI only fills typed slots — it never picks a color, a
 *    badge, or the divider. */

/** One bullet under an option in the columnar comparison: a short label and an
 *  optional supporting detail. */
export interface ComparisonPoint {
  label: RichText;
  detail?: RichText;
}

/** One option (column) in the columnar comparison. */
export interface ComparisonOption {
  name: RichText;
  /** Optional sticker id (icon) for the option header. */
  icon?: string;
  points: ComparisonPoint[];
}

/** The shared comparison footer: a single takeaway OR a list of shared traits.
 *  Renderer owns the tint + icon (summary = warm + a star; similarities = cool
 *  + a people icon); the AI only supplies the text. */
export type ComparisonFooter =
  | { kind: "summary"; text: RichText }
  | { kind: "similarities"; points: RichText[] };

/** Contrast 2–3 options as side-by-side columns — each an identity (name + icon)
 *  over a short list of points. `presentation` picks the renderer treatment:
 *  "cards" (boxed columns) or "bare" (a big letter badge over an open column). */
export interface ComparisonColumnsContent {
  eyebrow?: RichText;
  title: RichText;
  subtitle?: RichText;
  presentation?: "cards" | "bare";
  options: ComparisonOption[];
  footer?: ComparisonFooter;
  decor?: DecorLevel;
}

/** One option (column header) in the matrix comparison. */
export interface ComparisonMatrixOption {
  name: RichText;
  /** Optional sticker id (icon) for the option header. */
  icon?: string;
}

/** One option's value for a given dimension row. */
export interface ComparisonCell {
  detail: RichText;
  example?: RichText;
}

/** One dimension (row) of the matrix: a labelled attribute compared across every
 *  option. `cells` has exactly one entry per option, in option order. */
export interface ComparisonDimension {
  label: RichText;
  /** Optional sticker id (icon) for the row label. */
  icon?: string;
  cells: ComparisonCell[];
}

/** Contrast 2–3 options across shared dimensions as a matrix (options = columns,
 *  dimensions = rows). */
export interface ComparisonMatrixContent {
  eyebrow?: RichText;
  title: RichText;
  subtitle?: RichText;
  options: ComparisonMatrixOption[];
  dimensions: ComparisonDimension[];
  footer?: ComparisonFooter;
  decor?: DecorLevel;
}

/** A renderer-owned structured slide: a typed content payload that a dedicated
 *  component draws (it owns arrangement / arrows / reflow). When set on a slide
 *  it is the source of truth and the freeform `elements` are ignored. */
export type SlideTemplate =
  | { layoutId: "process_steps"; content: ProcessContent }
  | { layoutId: "key_concept"; content: KeyConceptContent }
  | { layoutId: "metrics_overview"; content: MetricsContent }
  | { layoutId: "code_walkthrough_steps"; content: CodeWalkthroughContent }
  | { layoutId: "section_break"; content: SectionBreakContent }
  | { layoutId: "concept_example"; content: ConceptExampleContent }
  | { layoutId: "outline_list"; content: OutlineListContent }
  | { layoutId: "prose"; content: ProseContent }
  | { layoutId: "comparison_columns"; content: ComparisonColumnsContent }
  | { layoutId: "comparison_matrix"; content: ComparisonMatrixContent };

export type StructuredLayoutId = SlideTemplate["layoutId"];

export interface Slide {
  id: string;
  type: "slide";
  /** Optional label shown in the filmstrip. */
  title?: string;
  /** Last applied layout id (built-in or custom-*); free edits don't reset it. */
  layout: string;
  style: SlideStyle;
  elements: SlideElement[];
  /** When present, this is a renderer-owned structured slide (see SlideTemplate)
   *  and `elements` are not rendered. */
  template?: SlideTemplate;
  speakerNotes?: string;
  order: number;
  ai: {
    purpose?: string;
    formattingRules: string[];
    qualityChecks: string[];
    allowedActions: string[];
    /** The PLAN slide-spec id this slide was authored to satisfy (set by the
     *  batch generator). Lets plan-coverage map slides → specs deterministically. */
    specId?: string;
  };
}

/* ───────────────────────────── Blocks ─────────────────────────────────── */

export type BlockType =
  | "slide_deck"
  | "lecture_text"
  | "quiz"
  | "homework"
  | "exercise"
  | "example"
  | "resource";

export interface BaseBlock {
  id: string;
  type: BlockType;
  title?: string;
  order: number;
  ai: AIMeta;
}

export interface SlideDeckBlock extends BaseBlock {
  type: "slide_deck";
  slides: Slide[];
}

export type LectureTone = "beginner" | "concise" | "detailed" | "socratic";
export interface LectureParagraph {
  id: string;
  kind: "paragraph" | "key_idea" | "aside";
  text: string;
}
export interface LectureTextBlock extends BaseBlock {
  type: "lecture_text";
  tone: LectureTone;
  paragraphs: LectureParagraph[];
}

export type QuestionKind =
  | "multiple_choice"
  | "multi_select"
  | "true_false"
  | "short_answer";

/**
 * Quiz-level presentation options only. Low-stakes by design: there are NO
 * scores, passing thresholds, timers, or attempt caps here (or anywhere) — a
 * knowledge check confirms understanding and shows instant feedback, it never
 * grades or gates progress.
 */
export interface QuizSettings {
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
}

interface QuizQuestionBase {
  id: string;
  prompt: string;
  /** Shown as instant feedback once the learner answers. */
  explanation?: string;
  /** Optional link to a lesson objective / semantic tag this question assesses. */
  objectiveId?: string;
}
export type QuizQuestion =
  | (QuizQuestionBase & {
      kind: "multiple_choice";
      choices: { id: string; text: string }[];
      correctChoiceId: string;
    })
  | (QuizQuestionBase & {
      kind: "multi_select";
      choices: { id: string; text: string }[];
      /** Every correct choice id; a response must match this set exactly. */
      correctChoiceIds: string[];
    })
  | (QuizQuestionBase & { kind: "true_false"; correctAnswer: boolean })
  | (QuizQuestionBase & {
      kind: "short_answer";
      expectedAnswer: string;
      /** Extra accepted answers (matched case/whitespace-insensitively). */
      acceptedAnswers?: string[];
    });

export interface QuizBlock extends BaseBlock {
  type: "quiz";
  settings?: QuizSettings;
  questions: QuizQuestion[];
}

export interface HomeworkExercise {
  id: string;
  title: string;
  prompt: string;
  hint?: string;
  solution?: string;
}

/** How learners optionally submit work for a practice exercise. "none" = no
 *  deliverable collected (self-paced practice only). */
export type DeliverableType = "none" | "text_response" | "file_upload" | "external_link";

/** One qualitative performance level within a rubric criterion (e.g.
 *  "Excellent"). Low-stakes: levels describe quality, they never score it. */
export interface RubricLevel {
  id: string;
  label: string;
  description?: string;
}
export interface RubricCriterion {
  id: string;
  name: string;
  description?: string;
  /** Ordered performance levels; the criterion's max = its highest level. */
  levels: RubricLevel[];
}
export interface HomeworkBlock extends BaseBlock {
  type: "homework";
  instructions: string;
  deliverableType: DeliverableType;
  /** Informational estimate only — never a limit or deadline. */
  estimatedMinutes?: number;
  /** Optional link to a lesson objective / semantic tag. */
  objectiveId?: string;
  exercises: HomeworkExercise[];
  rubric?: RubricCriterion[];
}

export interface ExampleBlock extends BaseBlock {
  type: "example";
  context: string;
  explanation: string;
  steps: string[];
  takeaway: string;
}

export interface ExerciseBlock extends BaseBlock {
  type: "exercise";
  prompt: string;
  hint?: string;
  solution?: string;
}

export interface ResourceBlock extends BaseBlock {
  type: "resource";
  links: { id: string; label: string; url: string; note?: string }[];
}

export type LessonBlock =
  | SlideDeckBlock
  | LectureTextBlock
  | QuizBlock
  | HomeworkBlock
  | ExerciseBlock
  | ExampleBlock
  | ResourceBlock;

/* ─────────────────────── Lessons / modules / course ───────────────────── */

export interface LessonNode {
  id: string;
  type: "lesson";
  title: string;
  objective?: string;
  order: number;
  estimatedMinutes?: number;
  blocks: LessonBlock[];
}

export interface CourseModule {
  id: string;
  type: "module";
  title: string;
  description?: string;
  order: number;
  lessons: LessonNode[];
}

export interface CourseTheme {
  name: string;
  accent: "violet" | "emerald" | "sky" | "amber";
  slideDefaults: { layout: string; themeId: SlideThemeId };
}

export type CourseLevel = "beginner" | "intermediate" | "advanced";

/**
 * Structured planning context the studio collects on the Plan step and the AI
 * agents read before generating lessons, slides, quizzes, and exercises —
 * richer, more specific planning yields better AI output. Title, subtitle
 * (description), intended learners (audience) and level live on the doc
 * directly; these are the extra Plan fields. Maps to courses.plan (jsonb).
 */
export interface CoursePlan {
  /** Category / topic, e.g. "Competitive programming". */
  category?: string;
  /** What learners will be able to do after the course. */
  outcomes: string[];
  /** Optional prerequisites / requirements — encourage a low barrier. */
  prerequisites: string[];
  /** Teaching style / tone the AI should adopt (e.g. "casual, practical"). */
  teachingStyle?: string;
}

export interface CourseDocument {
  id: string;
  title: string;
  description?: string;
  audience?: string;
  level?: CourseLevel;
  /** Plan-step context for the AI (see CoursePlan). */
  plan: CoursePlan;
  modules: CourseModule[];
  theme: CourseTheme;
  metadata: {
    createdAt: string;
    updatedAt: string;
    ownerId?: string;
    aiReadableVersion: "1.0";
  };
}

/* ───────────────────────────── Selection ──────────────────────────────── */

export type Selection =
  | { kind: "course" }
  | { kind: "module"; id: string }
  | { kind: "lesson"; id: string }
  | { kind: "block"; id: string; lessonId: string }
  | { kind: "slide"; id: string; blockId: string; lessonId: string }
  | {
      kind: "element";
      id: string;
      slideId: string;
      blockId: string;
      lessonId: string;
      /** Entered-group path (Google-Slides "enter group" navigation). */
      scope?: string[];
    }
  | {
      kind: "elements";
      /** ≥2 element ids on the same slide. */
      ids: string[];
      slideId: string;
      blockId: string;
      lessonId: string;
      /** Entered-group path the selection was made within. */
      scope?: string[];
    };

/* ──────────────────────────── Quality lint ────────────────────────────── */

export type QualityHintCode =
  | "TOO_MUCH_TEXT"
  | "TOO_MANY_BULLETS"
  | "MISSING_TITLE"
  | "NO_SPEAKER_NOTES"
  | "MISSING_VISUAL"
  | "IMAGE_MISSING_ALT"
  | "LOW_CONTRAST"
  | "LAYOUT_MISMATCH"
  | "TOO_MANY_FONT_SIZES"
  | "TOO_MANY_COLORS"
  | "TEXT_CLIPPED";

export interface QualityHint {
  code: QualityHintCode;
  severity: "info" | "warn";
  message: string;
  /** Optional one-click remedy. Patches are built lazily (at click time) so
   *  id generation never happens during render. */
  fix?: { label: string; makePatches: () => unknown[] };
}
