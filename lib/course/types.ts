/**
 * WiseSel — structured course document model.
 *
 * The entire course is one JSON-serializable document. Every node carries a
 * stable string `id`, an explicit integer `order`, and (for blocks) an `ai`
 * envelope describing purpose + allowed actions, so both humans and AI agents
 * can inspect and safely modify the course.
 *
 * Designed to map cleanly to Supabase/Postgres later: courses / modules /
 * lessons as rows, blocks as jsonb, ISO-8601 timestamps throughout.
 */

import type { DiagramContent } from "./diagram/types";

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

/** Provenance of a positioned element. `ai` = produced by the AI pipeline
 *  (directly, or by deterministically MATERIALIZING an AI structured layout via
 *  lib/course/slide/materialize); `human` = inserted/authored by a person. Used
 *  by future AI editing to avoid clobbering user-owned geometry. */
export type ElementOrigin = "ai" | "human";

/** Which aspects of an element a person has manually changed since it was
 *  created/materialized. Set by the geometry/content reducers (patches.ts).
 *  Lets a future AI edit patch CONTENT while preserving user-moved frames. */
export interface ElementUserModified {
  frame?: boolean;
  style?: boolean;
  content?: boolean;
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

/* ───────────────────────────── Rich lists ─────────────────────────────── */

/** How a list item's marker is drawn. `number`/`alpha`/`roman` are auto-counted
 *  per contiguous run at the same level; the rest are static glyphs. `none` =
 *  no marker (a hanging continuation line). A `markerText` on the item overrides
 *  the auto glyph (e.g. a two-digit "01"). */
export type ListMarkerKind =
  | "disc"
  | "circle"
  | "square"
  | "dash"
  | "number"
  | "alpha"
  | "roman"
  | "none";

/**
 * One list paragraph. FLAT model (Google-Slides / PPTX style): nesting is the
 * integer `level`, not a child array — so indent/outdent is a one-line level
 * change and rendering is non-recursive. `text` is the plain fallback (invariant:
 * `text` === concat(`runs`) when runs are present), so lint/search/AI read it.
 */
export interface SlideListItem {
  id: string;
  text: string;
  runs?: TextRun[];
  /** 0-based indent depth. */
  level: number;
  /** Overrides the level/default marker for THIS item. */
  markerKind?: ListMarkerKind;
  /** Explicit marker glyph/label (e.g. "01"); wins over the auto-counted value. */
  markerText?: string;
  /** Marker color, independent of the text color. */
  markerColor?: string;
  textColor?: string;
}

/** Per-indent-level defaults (index = level). */
export interface SlideListLevelStyle {
  markerKind?: ListMarkerKind;
  markerColor?: string;
  textColor?: string;
  fontSize?: number;
  lineHeight?: number;
  /** Extra indent (px) for this level; overrides the default step. */
  indent?: number;
  hangingIndent?: number;
}

/** A rich list: the editable + materialized representation of `bullet_list`.
 *  Carried alongside the element's plain `items: string[]` (the fallback), so
 *  old decks (items only) keep working and lint/AI read plain text unchanged. */
export interface SlideListContent {
  items: SlideListItem[];
  defaultMarkerKind: ListMarkerKind;
  /** First number for `number`/`alpha`/`roman` runs (default 1). */
  startNumber?: number;
  markerColor?: string;
  textColor?: string;
  /** Indexed by level. */
  levelStyles?: SlideListLevelStyle[];
  /** Uniform gap (px) between paragraphs; overrides the renderer's spacing
   *  heuristic. A text box that became a list sets a small value so plain lines
   *  flow like normal text. */
  paragraphSpacing?: number;
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
  /** Optional stable semantic slot id stamped when an element is MATERIALIZED
   *  from a structured layout (e.g. "title", "body", "image.main",
   *  "card.1.title"). Lets a future AI edit address "the bullet list" by role
   *  instead of coordinates. Absent on hand-inserted elements. */
  role?: string;
  /** Where this element came from (see ElementOrigin). Absent = legacy/unknown. */
  origin?: ElementOrigin;
  /** Per-aspect record of manual user edits (see ElementUserModified). */
  userModified?: ElementUserModified;
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
    | { type: "text"; text: string; runs?: TextRun[]; list?: SlideListContent }
    | { type: "heading"; text: string; runs?: TextRun[] }
    | { type: "bullet_list"; items: string[]; list?: SlideListContent }
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

/** A renderer-owned IMAGE slide — a generated (or human-uploaded) educational
 *  ILLUSTRATION for a concept no diagram type fits (a historical scene, a
 *  biological structure, an evocative concept image). The image lives at a stored
 *  URL (Supabase course-assets — never a blob/data URL); alt text is REQUIRED.
 *  The AI creates these through `add_image` (which generates + stores the image),
 *  never by hand-authoring a URL. Accuracy-critical figures stay programmatic
 *  diagrams — an illustration is never trusted for exact labels/values. */
export interface IllustrationContent {
  /** Public URL of the stored image. Empty string = pending / awaiting upload. */
  imageUrl: string;
  /** Required alt text (accessibility + AI grounding). */
  alt: string;
  /** Optional slide title shown above the image. */
  title?: RichText;
  /** Optional caption under the image — what the learner should notice. */
  caption?: RichText;
  /** Optional 0–4 supporting points shown beside the image. */
  points?: RichText[];
  /** Provenance (review / export): an AI-generated image vs a human upload. */
  source?: "ai_generated" | "upload";
  /** Storage path within the bucket (for later cleanup / re-fetch). */
  storagePath?: string;
}

/* ── Image LAYOUTS (the two purpose-built generated-image slides that replace the
 *    full-bleed `illustration` for new authoring). Like `illustration`, the image
 *    lives at a stored URL supplied by `add_image` (never hand-authored) and alt
 *    text is REQUIRED; the AI fills the typed TEXT slots, the renderer owns all
 *    arrangement (image box AR, numbering, dividers, footer). `intentHash` freezes
 *    the asset: it's the hash of the visual intent the image was generated from, so
 *    an unrelated text edit never silently regenerates a different picture. */

/** A PENDING image-generation request stored on the slide while the image is being
 *  produced off the agent's critical path. `add_image` enqueues this with
 *  `imageUrl:""` (the renderer shows the placeholder); a generation endpoint reads it,
 *  produces the image, sets `imageUrl`/`storagePath`, and clears `pendingGen`. Carries
 *  exactly what the prompt builder + verification need (no model call to re-derive). */
export interface ImagePendingGen {
  status: "pending" | "failed";
  visualWeight: "reference" | "supporting";
  prompt: string;
  subject?: string;
  requiredLabels?: string[];
  axes?: { x?: string; y?: string };
  annotations?: string[];
  alt: string;
}

/** One annotation in `image_reference`: a bold label + a one-line description that
 *  points at a detail shown in the image. */
export interface ImageAnnotation {
  label: RichText;
  description: RichText;
}

/** One numbered concept card in `image_reference`'s bottom row (renderer numbers
 *  them 01/02/03). */
export interface ImageConceptCard {
  title: RichText;
  description: RichText;
}

/** HERO image layout — the image IS the subject; annotations point at details in
 *  it and numbered concept cards summarize the takeaways. Landscape 3:2 image. */
export interface ImageReferenceContent {
  /** Public URL of the stored image. Empty string = pending. */
  imageUrl: string;
  /** Required alt text (accessibility + AI grounding). */
  alt: string;
  eyebrow?: RichText;
  title: RichText;
  /** 0–4 annotation points referencing the image. */
  annotations?: ImageAnnotation[];
  /** 0–3 numbered concept cards (renderer owns the 01/02/03 numbering). */
  cards?: ImageConceptCard[];
  source?: "ai_generated" | "upload";
  storagePath?: string;
  /** Hash of the visual intent this image was generated from (freeze-on-accept). */
  intentHash?: string;
  /** Set while the image is being generated off the critical path (imageUrl ""). */
  pendingGen?: ImagePendingGen;
}

/** SUPPORTING image layout — the image aids understanding; the teaching lives in
 *  the left column (lead + bullets) and the image sits right. Square 1:1 image. */
export interface ImageSupportingContent {
  imageUrl: string;
  alt: string;
  eyebrow?: RichText;
  title: RichText;
  /** One lead sentence under the title. */
  lead?: RichText;
  /** 0–4 supporting bullets. */
  bullets?: RichText[];
  /** Optional caption under the image. */
  caption?: RichText;
  source?: "ai_generated" | "upload";
  storagePath?: string;
  intentHash?: string;
  /** Set while the image is being generated off the critical path (imageUrl ""). */
  pendingGen?: ImagePendingGen;
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
  | { layoutId: "comparison_matrix"; content: ComparisonMatrixContent }
  /** A programmatic teaching VISUAL — a typed diagram the renderer draws as crisp
   *  SVG (accurate by construction, accessible, exportable). See lib/course/diagram. */
  | { layoutId: "diagram"; content: DiagramContent }
  /** A generated / uploaded educational IMAGE (alt-text required). Legacy — kept
   *  for back-compat rendering; new authoring uses image_reference/_supporting. */
  | { layoutId: "illustration"; content: IllustrationContent }
  /** HERO generated-image layout (image is the subject + annotations + cards). */
  | { layoutId: "image_reference"; content: ImageReferenceContent }
  /** SUPPORTING generated-image layout (lead + bullets + square image). */
  | { layoutId: "image_supporting"; content: ImageSupportingContent };

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
  /** Ambient themed decoration drawn behind the slide. `"structured"` keeps the
   *  corner glows + dot-grid after a structured slide is ejected to editable
   *  elements (the glows bleed off-canvas, so they can't be elements). Set by
   *  materialize-on-eject; absent on plain freeform slides. */
  backdrop?: "structured";
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
  | "imported_deck"
  | "video"
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

/* ── Imported decks (PPT / PPTX / PDF) ── */

/** Where an imported deck originated. `upload` is live; the others are
 *  schema-ready for a future Google Drive / OneDrive picker (not implemented). */
export type DeckImportSourceType = "upload" | "google_drive" | "onedrive";

/** Processing lifecycle of an imported deck. `uploaded` → `processing` → `ready`
 *  | `failed`; a retry/replace re-enters `processing`. The source of truth is the
 *  `deck_imports` row — this status is mirrored onto the block for instant render
 *  and last-known offline display. */
export type DeckImportStatus = "uploaded" | "processing" | "ready" | "failed";

/**
 * A presentation the educator imported rather than authored natively. It is a
 * user-facing "slide deck" but NOT an editable SlideElement deck: the original
 * file is stored privately, rendered to per-page preview images by a worker, and
 * shown in a rail viewer. The block content is a DENORMALIZED snapshot keyed by
 * `deckImportId` (→ the `deck_imports` table); it deliberately carries NO storage
 * paths (those stay server-side and are only ever handed out as signed URLs).
 */
export interface ImportedDeckBlock extends BaseBlock {
  type: "imported_deck";
  /** FK to the `deck_imports` row — authoritative for status, pages, storage. */
  deckImportId: string;
  sourceType: DeckImportSourceType;
  /** Original (sanitized) file name, e.g. "Intro to Genetics.pptx". */
  originalFileName: string;
  originalMimeType: string;
  /** Bytes of the original upload (for the UI's file chip). */
  originalFileSize: number;
  /** Mirror of `deck_imports.status` so the block renders the right card at once. */
  status: DeckImportStatus;
  /** Rendered page count once ready. */
  pageCount?: number;
  /** Human-friendly failure summary when `status === "failed"`. */
  error?: string;
  /** ISO timestamps mirrored from the row (display only). */
  createdAt?: string;
  updatedAt?: string;
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

/* ── Video lessons (educator-recorded / uploaded, backed by Mux) ──────────── */

/** Video hosting provider. Only Mux is implemented, but the field keeps the
 *  block provider-agnostic so a second provider drops in behind the same seam. */
export type VideoProviderId = "mux";

/**
 * Lifecycle of a video block's asset, mirrored from the `video_assets` row for
 * instant render + offline display (the row is the source of truth, exactly like
 * `imported_deck` mirrors `deck_imports.status`).
 *   empty      — no recording/upload yet (the block was just added)
 *   uploading  — the recorded/selected file is being sent to Mux
 *   processing — Mux is ingesting / encoding the asset
 *   ready      — a playback id exists; the video is playable
 *   failed     — upload or Mux processing errored (see `errorMessage`)
 */
export type VideoAssetStatus = "empty" | "uploading" | "processing" | "ready" | "failed";

/** The three recording modes the UI exposes (deliberately just three). */
export type VideoRecordingMode = "screen_camera" | "camera_only" | "screen_only";

/** How the captured tracks are composited into the final single video. */
export type VideoLayout = "screen_with_camera_bubble" | "camera_full" | "screen_full";

/** Corner the webcam bubble sits in for `screen_with_camera_bubble`. */
export type CameraBubblePosition =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";

/**
 * Denormalized snapshot of the Mux asset stored ON the block. Only IDs +
 * metadata + status live here — NEVER raw video bytes (those live in Mux). The
 * authoritative record is the `video_assets` row referenced by `videoAssetId`;
 * this snapshot is what a fresh load renders before the live view resolves.
 */
export interface VideoAssetSnapshot {
  provider: VideoProviderId;
  status: VideoAssetStatus;
  /** FK-free reference to the `video_assets` row (source of truth). */
  videoAssetId?: string;
  /** Mux direct-upload id (present from the moment an upload is created). */
  uploadId?: string;
  /** Mux asset id (present once Mux creates the asset from the upload). */
  assetId?: string;
  /** Mux playback id — the only id the browser needs to play the video. */
  playbackId?: string;
  /** Video length in seconds (from Mux once ready). */
  durationSeconds?: number;
  /** Aspect ratio string from Mux, e.g. "16:9". */
  aspectRatio?: string;
  /** Cached poster/thumbnail URL (derived from the playback id). */
  thumbnailUrl?: string;
  /** ISO timestamps mirrored from the row (display only). */
  createdAt?: string;
  updatedAt?: string;
  /** Human-friendly failure summary when `status === "failed"`. */
  errorMessage?: string;
}

/** How the video was (or will be) recorded. Persisted so a re-record keeps the
 *  educator's last choices, and so export/analysis can reason about layout. */
export interface VideoRecordingConfig {
  mode?: VideoRecordingMode;
  layout?: VideoLayout;
  cameraBubblePosition?: CameraBubblePosition;
  includeMic?: boolean;
}

/** Non-destructive trim. Both are offsets in seconds from the start of the
 *  source; playback clamps to [trimStartSeconds, trimEndSeconds]. Absent = play
 *  the whole video. Invariant (validated in the editor): 0 ≤ start < end ≤ duration. */
export interface VideoTrim {
  trimStartSeconds?: number;
  trimEndSeconds?: number;
}

/** Educator-facing playback preferences. `showTranscript` now toggles whether
 *  captions render on the player by default (real, once a caption track exists);
 *  `showChapters` remains an extension point ("Coming later"). */
export interface VideoLessonSettings {
  showControls: boolean;
  allowDownload: boolean;
  showTranscript: boolean;
  showChapters: boolean;
}

/**
 * Lifecycle of the video's captions (Mux auto-generated by default). Kept to the
 * four states the editor surfaces:
 *   none       — no caption track requested/exists
 *   generating — requested; Mux is transcribing (asynchronous, does NOT block playback)
 *   ready      — a caption track is available
 *   failed     — generation errored (see `error`)
 */
export type VideoCaptionStatus = "none" | "generating" | "ready" | "failed";

/** Where a caption track came from. `uploaded` is an extension point (educator
 *  re-uploads a corrected/translated WebVTT track); only `generated` today. */
export type VideoCaptionSource = "generated" | "uploaded";

/**
 * Denormalized caption METADATA stored on the block (the heavy transcript text
 * itself lives on the authoritative `video_assets` row + rides in the live view —
 * it is deliberately NOT persisted into the course document to keep it lean).
 * Written via the validated UPDATE_VIDEO_LESSON patch as status flows back from
 * Mux (polling / webhook). Extension points left clean: manual correction, a
 * re-uploaded track, translations (multiple tracks), transcript-based editing.
 */
export interface VideoCaptions {
  status: VideoCaptionStatus;
  /** Mux text-track id (the id in the WebVTT URL). */
  trackId?: string;
  /** Human label, e.g. "English (auto)". */
  trackName?: string;
  /** BCP-47-ish language code Mux uses, e.g. "en". */
  languageCode?: string;
  source?: VideoCaptionSource;
  /** Failure summary when `status === "failed"`. */
  error?: string;
  /** ISO timestamp the caption metadata last changed (display only). */
  updatedAt?: string;
}

/**
 * A first-class lesson block whose content is a single recorded/uploaded video,
 * hosted by Mux. Educator-side only for now (no student playback surface yet).
 * The block carries IDs + metadata + trim; the bytes live in Mux, and the
 * `video_assets` row is the authoritative status record.
 */
export interface VideoLessonBlock extends BaseBlock {
  type: "video";
  description?: string;
  asset: VideoAssetSnapshot;
  recording: VideoRecordingConfig;
  edit: VideoTrim;
  settings: VideoLessonSettings;
  /** Caption/transcript metadata (Mux auto-generated). Absent = never requested. */
  captions?: VideoCaptions;
}

export type LessonBlock =
  | SlideDeckBlock
  | ImportedDeckBlock
  | VideoLessonBlock
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
