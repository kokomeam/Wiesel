/**
 * Slide layouts: structured placeholder definitions (never raw HTML) that
 * both humans (LayoutPicker) and AI (APPLY_SLIDE_LAYOUT patches) use.
 *
 * `applyLayoutToSlide` is PURE — new-element ids come from the caller's
 * idPool so the patch reducer stays deterministic. Custom layouts are stored
 * client-side (uiStore/localStorage) and travel INSIDE the patch as inline
 * placeholders, so applying one never reads browser state.
 */

import { defaultAIMeta, manifestTypeForElementType } from "../manifest";
import type {
  ElementStyle,
  Slide,
  SlideElement,
  SlideElementType,
} from "../types";

export interface LayoutPlaceholder {
  /** Semantic role, e.g. "title", "body", "image", "step-1". */
  role: string;
  type: SlideElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Content used when the placeholder isn't filled by existing content. */
  seedText?: string;
  /** Style baseline; an adopted element's own style wins over this. */
  style?: ElementStyle;
}

export interface SlideLayoutDef {
  id: string;
  name: string;
  description: string;
  placeholders: LayoutPlaceholder[];
  ai: {
    bestFor: string[];
    avoidWhen: string[];
    qualityRules: string[];
  };
}

/* ─────────────────────── Built-in layout library ──────────────────────── */

export const SLIDE_LAYOUTS: SlideLayoutDef[] = [
  {
    id: "title",
    name: "Title slide",
    description: "Opens a section: one large title and a short subtitle.",
    placeholders: [
      {
        role: "title",
        type: "heading",
        x: 160,
        y: 270,
        width: 960,
        height: 110,
        seedText: "Section title",
        style: { fontSize: 56, textAlign: "center" },
      },
      {
        role: "subtitle",
        type: "text",
        x: 240,
        y: 400,
        width: 800,
        height: 70,
        seedText: "A one-line promise of what's coming.",
        style: { fontSize: 24, textAlign: "center" },
      },
    ],
    ai: {
      bestFor: ["section_opener", "lesson_start"],
      avoidWhen: ["dense_content", "code"],
      qualityRules: ["one_idea", "short_title"],
    },
  },
  {
    id: "title_bullets",
    name: "Title + bullets",
    description: "A clear teaching slide with one title and concise supporting bullets.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 64, width: 1136, height: 80, seedText: "Slide title" },
      {
        role: "main_points",
        type: "bullet_list",
        x: 96,
        y: 190,
        width: 1080,
        height: 420,
        seedText: "First point",
      },
    ],
    ai: {
      bestFor: ["concept_intro", "summary", "lecture_slide"],
      avoidWhen: ["dense_code", "visual_demo"],
      qualityRules: ["max_5_bullets", "short_title", "one_main_idea"],
    },
  },
  {
    id: "two_column",
    name: "Two column",
    description: "Side-by-side points under one title.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 64, width: 1136, height: 80, seedText: "Slide title" },
      { role: "left", type: "bullet_list", x: 72, y: 190, width: 540, height: 430, seedText: "Left point" },
      { role: "right", type: "bullet_list", x: 668, y: 190, width: 540, height: 430, seedText: "Right point" },
    ],
    ai: {
      bestFor: ["parallel_ideas", "before_after"],
      avoidWhen: ["single_narrative"],
      qualityRules: ["balanced_columns", "max_4_bullets_each"],
    },
  },
  {
    id: "image_left_text_right",
    name: "Image left, text right",
    description: "A visual on the left explained by text on the right.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 64, width: 1136, height: 80, seedText: "Slide title" },
      { role: "image", type: "image", x: 72, y: 190, width: 520, height: 440 },
      { role: "body", type: "bullet_list", x: 648, y: 200, width: 560, height: 420, seedText: "What to notice" },
    ],
    ai: {
      bestFor: ["visual_explanation", "diagram_walkthrough"],
      avoidWhen: ["no_visual_available"],
      qualityRules: ["image_has_alt", "max_4_bullets"],
    },
  },
  {
    id: "text_left_image_right",
    name: "Text left, image right",
    description: "Text on the left supported by a visual on the right.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 64, width: 1136, height: 80, seedText: "Slide title" },
      { role: "body", type: "bullet_list", x: 72, y: 200, width: 560, height: 420, seedText: "What to notice" },
      { role: "image", type: "image", x: 688, y: 190, width: 520, height: 440 },
    ],
    ai: {
      bestFor: ["visual_explanation", "diagram_walkthrough"],
      avoidWhen: ["no_visual_available"],
      qualityRules: ["image_has_alt", "max_4_bullets"],
    },
  },
  {
    id: "definition",
    name: "Definition / key concept",
    description: "One term, prominently defined, with supporting context.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 80, width: 1136, height: 80, seedText: "The term" },
      {
        role: "definition",
        type: "callout",
        x: 160,
        y: 220,
        width: 960,
        height: 180,
        seedText: "A precise, plain-language definition of the concept.",
        style: { fontSize: 24 },
      },
      {
        role: "context",
        type: "text",
        x: 160,
        y: 450,
        width: 960,
        height: 130,
        seedText: "Why this matters and where you'll meet it.",
      },
    ],
    ai: {
      bestFor: ["definition", "key_concept", "vocabulary"],
      avoidWhen: ["multi_concept"],
      qualityRules: ["one_term_only", "plain_language"],
    },
  },
  {
    id: "code_walkthrough",
    name: "Code walkthrough",
    description: "Code beside the points that explain it.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 56, width: 1136, height: 70, seedText: "Code walkthrough" },
      { role: "code", type: "code_block", x: 72, y: 160, width: 640, height: 480 },
      { role: "notes", type: "bullet_list", x: 760, y: 170, width: 448, height: 460, seedText: "Line-by-line note" },
    ],
    ai: {
      bestFor: ["dense_code", "implementation_detail"],
      avoidWhen: ["concept_intro"],
      qualityRules: ["code_under_20_lines", "notes_reference_lines"],
    },
  },
  {
    id: "problem_statement",
    name: "Problem statement",
    description: "Frames a problem before solving it: statement + constraints.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 64, width: 1136, height: 80, seedText: "The problem" },
      {
        role: "statement",
        type: "callout",
        x: 72,
        y: 180,
        width: 1136,
        height: 170,
        seedText: "Given …, find … such that …",
        style: { fontSize: 22 },
      },
      {
        role: "constraints",
        type: "bullet_list",
        x: 96,
        y: 400,
        width: 1080,
        height: 240,
        seedText: "n ≤ 2·10⁵",
      },
    ],
    ai: {
      bestFor: ["problem_setup", "contest_problem"],
      avoidWhen: ["solution_detail"],
      qualityRules: ["constraints_explicit", "statement_verbatim"],
    },
  },
  {
    id: "step_by_step",
    name: "Step-by-step process",
    description: "A process as three clear sequenced steps.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 56, width: 1136, height: 70, seedText: "How it works" },
      { role: "step-1", type: "callout", x: 96, y: 165, width: 1088, height: 150, seedText: "Step one." },
      { role: "step-2", type: "callout", x: 96, y: 340, width: 1088, height: 150, seedText: "Step two." },
      { role: "step-3", type: "callout", x: 96, y: 515, width: 1088, height: 150, seedText: "Step three." },
    ],
    ai: {
      bestFor: ["algorithm_steps", "procedure", "recipe"],
      avoidWhen: ["non_sequential_content"],
      qualityRules: ["numbered_order", "one_action_per_step"],
    },
  },
  {
    id: "comparison",
    name: "Comparison",
    description: "Two options compared side by side.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 56, width: 1136, height: 70, seedText: "A vs. B" },
      {
        role: "left-label",
        type: "heading",
        x: 72,
        y: 170,
        width: 540,
        height: 60,
        seedText: "Option A",
        style: { fontSize: 28 },
      },
      {
        role: "right-label",
        type: "heading",
        x: 668,
        y: 170,
        width: 540,
        height: 60,
        seedText: "Option B",
        style: { fontSize: 28 },
      },
      { role: "left-points", type: "bullet_list", x: 72, y: 250, width: 540, height: 380, seedText: "Strength" },
      { role: "right-points", type: "bullet_list", x: 668, y: 250, width: 540, height: 380, seedText: "Strength" },
      { role: "divider", type: "divider", x: 634, y: 190, width: 10, height: 440 },
    ],
    ai: {
      bestFor: ["tradeoffs", "tool_choice", "before_after"],
      avoidWhen: ["more_than_two_options"],
      qualityRules: ["parallel_structure", "balanced_columns"],
    },
  },
  {
    id: "summary",
    name: "Summary / recap",
    description: "Recaps the lesson and lands the takeaway.",
    placeholders: [
      { role: "title", type: "heading", x: 72, y: 64, width: 1136, height: 80, seedText: "What we covered" },
      { role: "recap", type: "bullet_list", x: 96, y: 185, width: 1080, height: 370, seedText: "Key point" },
      {
        role: "takeaway",
        type: "callout",
        x: 96,
        y: 580,
        width: 1088,
        height: 100,
        seedText: "If you remember one thing, remember this.",
      },
    ],
    ai: {
      bestFor: ["lesson_end", "recap"],
      avoidWhen: ["new_material"],
      qualityRules: ["max_5_bullets", "one_takeaway"],
    },
  },
  {
    id: "quiz_intro",
    name: "Quiz intro",
    description: "A short pause slide announcing a checkpoint quiz.",
    placeholders: [
      {
        role: "title",
        type: "heading",
        x: 160,
        y: 230,
        width: 960,
        height: 100,
        seedText: "Checkpoint",
        style: { fontSize: 52, textAlign: "center" },
      },
      {
        role: "subtitle",
        type: "text",
        x: 260,
        y: 360,
        width: 760,
        height: 70,
        seedText: "Three quick questions on what you just learned.",
        style: { fontSize: 22, textAlign: "center" },
      },
      {
        role: "hint",
        type: "callout",
        x: 340,
        y: 470,
        width: 600,
        height: 110,
        seedText: "No grades here — wrong answers teach the most.",
      },
    ],
    ai: {
      bestFor: ["quiz_transition", "pacing_break"],
      avoidWhen: ["content_slides"],
      qualityRules: ["encouraging_tone"],
    },
  },
  {
    id: "full_image_background",
    name: "Full image background",
    description: "A full-bleed visual with a short overlaid title.",
    placeholders: [
      { role: "image", type: "image", x: 0, y: 0, width: 1280, height: 720 },
      {
        role: "title",
        type: "heading",
        x: 96,
        y: 480,
        width: 880,
        height: 100,
        seedText: "A picture worth a slide",
        style: { color: "#ffffff", fontSize: 48 },
      },
      {
        role: "caption",
        type: "text",
        x: 96,
        y: 590,
        width: 760,
        height: 60,
        seedText: "One line of context.",
        style: { color: "#e5e5e5", fontSize: 20 },
      },
    ],
    ai: {
      bestFor: ["mood_setting", "section_break", "real_world_photo"],
      avoidWhen: ["detailed_content"],
      qualityRules: ["image_has_alt", "title_contrast"],
    },
  },
  {
    id: "quote_takeaway",
    name: "Quote / key takeaway",
    description: "One sentence, given room to breathe.",
    placeholders: [
      { role: "divider", type: "divider", x: 480, y: 190, width: 320, height: 8 },
      {
        role: "quote",
        type: "text",
        x: 160,
        y: 250,
        width: 960,
        height: 180,
        seedText: "Learn the argument, not just the loop.",
        style: { fontSize: 38, italic: true, textAlign: "center", lineHeight: 1.3 },
      },
      {
        role: "attribution",
        type: "text",
        x: 160,
        y: 460,
        width: 960,
        height: 50,
        seedText: "— Course principle",
        style: { fontSize: 20, textAlign: "center" },
      },
    ],
    ai: {
      bestFor: ["key_takeaway", "motivation", "principle"],
      avoidWhen: ["detail_heavy"],
      qualityRules: ["under_20_words"],
    },
  },
];

export function findLayout(id: string): SlideLayoutDef | undefined {
  return SLIDE_LAYOUTS.find((l) => l.id === id);
}

/* ─────────────────────── Pure element construction ────────────────────── */

/** Build a fresh element from a placeholder. Pure — id supplied by caller. */
export function elementFromPlaceholder(
  p: LayoutPlaceholder,
  id: string,
  zIndex: number
): SlideElement {
  const base = {
    id,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    zIndex,
    style: { ...(p.style ?? {}) },
    ai: defaultAIMeta(manifestTypeForElementType(p.type), `Layout role: ${p.role}`),
  };
  switch (p.type) {
    case "heading":
      return { ...base, type: "heading", text: p.seedText ?? "Heading" };
    case "text":
      return { ...base, type: "text", text: p.seedText ?? "" };
    case "bullet_list":
      return { ...base, type: "bullet_list", items: [p.seedText ?? "First point"] };
    case "code_block":
      return { ...base, type: "code_block", code: p.seedText ?? "// code", language: "cpp" };
    case "image":
      // Empty src renders as an upload-prompt placeholder box on the canvas.
      return { ...base, type: "image", src: "", alt: "", objectFit: "cover" };
    case "shape":
      return { ...base, type: "shape", shape: "rectangle" };
    case "callout":
      return { ...base, type: "callout", text: p.seedText ?? "Key point", variant: "tip" };
    case "divider":
      return {
        ...base,
        type: "divider",
        orientation: p.width >= p.height ? "horizontal" : "vertical",
      };
    case "table":
      return {
        ...base,
        type: "table",
        rows: [
          ["Column A", "Column B"],
          ["—", "—"],
        ],
        headerRow: true,
      };
  }
}

/* ───────────────────────── Layout application ─────────────────────────── */

/** Which existing element types may fill a placeholder of a given type. */
const compatible: Partial<Record<SlideElementType, SlideElementType[]>> = {
  heading: ["heading", "text"],
  text: ["text", "heading", "callout"],
  bullet_list: ["bullet_list"],
  image: ["image"],
  code_block: ["code_block"],
  callout: ["callout", "text"],
};

/** Every seed string a placeholder or factory can produce — used to tell
 *  untouched placeholder filler apart from real authored content when
 *  choosing which element gets to claim a layout slot. */
const KNOWN_SEED_TEXT: Set<string> = new Set(
  [
    "Heading",
    "New heading",
    "Write something…",
    "First point",
    "New point",
    "Key point",
    "New step",
    "// code",
    ...SLIDE_LAYOUTS.flatMap((l) =>
      l.placeholders.map((p) => p.seedText).filter((t): t is string => Boolean(t))
    ),
  ].map((t) => t.trim())
);

/** Does this element carry content a person actually wrote? */
function hasAuthoredContent(el: SlideElement): boolean {
  switch (el.type) {
    case "heading":
    case "text":
    case "callout": {
      const t = el.text.trim();
      return t.length > 0 && !KNOWN_SEED_TEXT.has(t);
    }
    case "bullet_list":
      return el.items.some((i) => i.trim().length > 0 && !KNOWN_SEED_TEXT.has(i.trim()));
    case "code_block": {
      const c = el.code.trim();
      return c.length > 0 && !KNOWN_SEED_TEXT.has(c);
    }
    case "image":
      return el.src.length > 0;
    case "table":
      return true;
    case "shape":
    case "divider":
      return false;
  }
}

/**
 * Apply layout placeholders to a slide's elements. Pure.
 *
 * preserve=true: each placeholder claims the best remaining compatible
 * element — exact type beats compatible type, authored content beats
 * untouched seed filler — which keeps its id/content/style but adopts the
 * placeholder's frame and zIndex. Unfilled placeholders become fresh seed
 * elements (ids from idPool). Elements that match no slot are DROPPED:
 * applying a layout REPLACES the previous arrangement (one undoable patch),
 * so switching layouts can never stack stale elements on top of new ones,
 * and re-applying the same layout is idempotent.
 *
 * preserve=false: the layout's seed elements replace everything.
 */
export function applyLayoutToSlide(
  elements: SlideElement[],
  placeholders: LayoutPlaceholder[],
  preserve: boolean,
  idPool: string[]
): SlideElement[] {
  let poolIndex = 0;
  const takeId = () => idPool[poolIndex++] ?? `${idPool[0] ?? "el"}-overflow-${poolIndex}`;

  if (!preserve) {
    return placeholders.map((p, i) => elementFromPlaceholder(p, takeId(), i));
  }

  const remaining = [...elements];

  return placeholders.map((p, i) => {
    let bestIndex = -1;
    let bestScore = -1;
    remaining.forEach((el, idx) => {
      const exact = el.type === p.type;
      if (!exact && !(compatible[p.type] ?? []).includes(el.type)) return;
      // Exact type (2) outranks merely-compatible; authored content (1)
      // outranks seed filler. Ties resolve to document order.
      const score = (exact ? 2 : 0) + (hasAuthoredContent(el) ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    });

    if (bestIndex >= 0) {
      const [claimed] = remaining.splice(bestIndex, 1);
      return {
        ...claimed,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        zIndex: i,
        // Placeholder style is a baseline; the element's own (possibly
        // user-set) style always wins.
        style: { ...(p.style ?? {}), ...claimed.style },
      };
    }
    return elementFromPlaceholder(p, takeId(), i);
  });
}

/** Derive placeholders from a designed slide so it can be saved as a
 *  reusable custom layout. */
export function inferPlaceholdersFromSlide(slide: Slide): LayoutPlaceholder[] {
  return [...slide.elements]
    .filter((el) => el.visible !== false)
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((el, i) => ({
      role: `${el.type}-${i + 1}`,
      type: el.type,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      style: Object.keys(el.style).length > 0 ? { ...el.style } : undefined,
    }));
}
