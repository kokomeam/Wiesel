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

export type FontFamilyId = "sans" | "serif" | "mono";
export type FontWeight = "regular" | "medium" | "semibold" | "bold";

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
  /** Logical px in 1280×720 canvas units. */
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

export interface Slide {
  id: string;
  type: "slide";
  /** Optional label shown in the filmstrip. */
  title?: string;
  /** Last applied layout id (built-in or custom-*); free edits don't reset it. */
  layout: string;
  style: SlideStyle;
  elements: SlideElement[];
  speakerNotes?: string;
  order: number;
  ai: {
    purpose?: string;
    formattingRules: string[];
    qualityChecks: string[];
    allowedActions: string[];
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

export type QuizDifficulty = "easy" | "medium" | "hard";
export type QuestionKind = "multiple_choice" | "true_false" | "short_answer";

interface QuizQuestionBase {
  id: string;
  prompt: string;
  explanation?: string;
  difficulty: QuizDifficulty;
}
export type QuizQuestion =
  | (QuizQuestionBase & {
      kind: "multiple_choice";
      choices: { id: string; text: string }[];
      correctChoiceId: string;
    })
  | (QuizQuestionBase & { kind: "true_false"; correctAnswer: boolean })
  | (QuizQuestionBase & { kind: "short_answer"; expectedAnswer: string });

export interface QuizBlock extends BaseBlock {
  type: "quiz";
  questions: QuizQuestion[];
}

export interface HomeworkExercise {
  id: string;
  title: string;
  prompt: string;
  hint?: string;
  solution?: string;
}
export interface RubricCriterion {
  id: string;
  name: string;
  points: number;
  description?: string;
}
export interface HomeworkBlock extends BaseBlock {
  type: "homework";
  instructions: string;
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

export interface CourseDocument {
  id: string;
  title: string;
  description?: string;
  audience?: string;
  level?: CourseLevel;
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
