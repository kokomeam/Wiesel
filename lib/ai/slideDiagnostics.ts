/**
 * Pure, dependency-light slide diagnostics — the leaf layer the generation-state
 * summary AND the post-generation validator both build on.
 *
 * Everything here is a deterministic read over a `Slide` (no model, no DB, no
 * React): plain-text length, density bucketing, and — the reliability fix — a
 * precise detector for the studio's DEFAULT PLACEHOLDER slide (the "Section
 * title" starter that `createBlock("slide_deck")` seeds). The validator removes
 * those before staging so an AI deck can never finalize with a placeholder.
 *
 * Kept free of any import from generationState/validation so those can both
 * depend on it without a cycle.
 */

import type { Slide } from "@/lib/course/types";

/** A structured-layout slide reads as "thin" below this much plain text. */
export const THIN_SLIDE_CHARS = 120;
/** Above this, a slide reads as dense (too much text for one slide). */
export const DENSE_SLIDE_CHARS = 420;

/** Total plain-text length across an arbitrary structured-template content tree's
 *  RichText slots (skips `runs`, which duplicate `.text`). Cheap proxy for "did
 *  this slide say much?". */
export function templateTextLength(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((s: number, n) => s + templateTextLength(n), 0);
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  let len = typeof o.text === "string" ? o.text.length : 0;
  for (const [k, v] of Object.entries(o)) if (k !== "runs" && k !== "text") len += templateTextLength(v);
  return len;
}

/** Flat-element plain text (the non-template path): every text-bearing element. */
function flatElementText(s: Slide): string[] {
  const out: string[] = [];
  for (const e of s.elements) {
    switch (e.type) {
      case "heading":
      case "text":
      case "callout":
        if (e.text.trim()) out.push(e.text.trim());
        break;
      case "bullet_list":
        for (const item of e.items) if (item.trim()) out.push(item.trim());
        break;
      case "code_block":
        if (e.code.trim()) out.push(e.code.trim());
        break;
      case "table":
        for (const row of e.rows) for (const cell of row) if (cell.trim()) out.push(cell.trim());
        break;
      case "image":
        if (e.alt.trim()) out.push(e.alt.trim());
        break;
    }
  }
  return out;
}

/** All meaningful plain-text tokens on a slide (structured or flat). */
export function slidePlainTokens(s: Slide): string[] {
  if (s.template) {
    // Walk the template tree and collect every `.text` string.
    const tokens: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (typeof o.text === "string" && o.text.trim()) tokens.push(o.text.trim());
      for (const [k, v] of Object.entries(o)) if (k !== "runs" && k !== "text") walk(v);
    };
    walk(s.template.content);
    return tokens;
  }
  return flatElementText(s);
}

/** Plain-text length of a whole slide (structured template or flat elements). */
export function slideTextLength(s: Slide): number {
  if (s.template) return templateTextLength(s.template.content);
  return s.elements.reduce((n, e) => {
    if (e.type === "heading" || e.type === "text" || e.type === "callout") return n + e.text.length;
    if (e.type === "bullet_list") return n + e.items.join(" ").length;
    if (e.type === "code_block") return n + e.code.length;
    return n;
  }, 0);
}

export function density(len: number): "low" | "medium" | "high" {
  if (len < THIN_SLIDE_CHARS) return "low";
  if (len > DENSE_SLIDE_CHARS) return "high";
  return "medium";
}

/* ──────────────────────────── Visual detection ────────────────────────── */

/** Structured layouts that present information VISUALLY / diagrammatically (vs a
 *  prose / key-concept / outline / section text slide). */
const VISUAL_STRUCTURED_LAYOUTS: ReadonlySet<string> = new Set([
  "diagram",
  "illustration",
  "process_steps",
  "comparison_columns",
  "comparison_matrix",
  "metrics_overview",
  "code_walkthrough_steps",
]);

/** Does the slide carry a real (non-empty) image element? */
export function slideHasImage(s: Slide): boolean {
  return s.elements.some((e) => e.type === "image" && e.src.trim() !== "");
}

/** Is this slide a drawn/precise visual — a programmatic `diagram` or an image?
 *  The bar for satisfying an ACCURACY-critical required visual (a graph, a search
 *  interval, a weighted graph) — a prose or metrics slide does NOT clear it. */
export function slideIsDiagram(s: Slide): boolean {
  return s.template?.layoutId === "diagram" || slideHasImage(s);
}

/** Does the slide present its content VISUALLY at all (a diagram, an inherently
 *  visual structured layout, or an image)? The bar for a non-accuracy-critical
 *  required visual. */
export function slideIsVisual(s: Slide): boolean {
  if (s.template) return VISUAL_STRUCTURED_LAYOUTS.has(s.template.layoutId);
  return slideHasImage(s);
}

/**
 * Every seed/placeholder string the layout library and element factory stamp into
 * a fresh, UNFILLED slide — normalized to lower-case + trimmed. A flat slide whose
 * only text is drawn from this set is an unedited starter, not authored content.
 * (Sourced from lib/course/slide/layouts.ts seedTexts + factories.ts defaults.)
 */
export const SEED_TEXTS: ReadonlySet<string> = new Set(
  [
    "section title",
    "a one-line promise of what's coming.",
    "slide title",
    "heading",
    "write something…",
    "write something...",
    "",
    "first point",
    "left point",
    "right point",
    "what to notice",
    "key point",
    "the term",
    "a clear, one-sentence definition.",
    "code walkthrough",
    "line-by-line note",
    "the problem",
    "step one.",
    "step two.",
    "step three.",
    "how it works",
    "a vs. b",
    "strength",
    "what we covered",
    "the one thing to remember.",
    "// code",
    "column a",
    "column b",
    "new step",
    "new point",
    "new question",
    "option a",
    "option b",
    "option c",
    "metric",
    "0",
  ].map((s) => s.toLowerCase())
);

/**
 * Is this the studio's DEFAULT PLACEHOLDER slide — an unedited starter that no
 * one (model or human) filled in? True only for a FLAT slide (the model authors
 * STRUCTURED slides, so a structured slide is by definition real content) that
 * carries no plan spec id and whose every text token is a known seed string (or
 * is empty). Conservative on purpose: a human's filled-in flat slide has
 * non-seed text and is never flagged.
 */
export function isPlaceholderSlide(s: Slide): boolean {
  if (s.template) return false; // structured ⇒ authored content
  if (s.ai?.specId) return false; // explicitly tagged to a plan spec ⇒ real
  const tokens = slidePlainTokens(s);
  const nonSeed = tokens.filter((t) => !SEED_TEXTS.has(t.toLowerCase()));
  return nonSeed.length === 0;
}

/**
 * A slide with effectively NO content — no text and no visual. Distinct from a
 * placeholder (which carries seed text): an empty slide is a hard failure on its
 * own. A structured slide can't normally be empty (strict schemas require text),
 * so this mainly guards flat slides stripped of content.
 */
export function isEmptySlide(s: Slide): boolean {
  if (slideTextLength(s) > 0) return false;
  if (s.template) return false; // has a structured shape (even if oddly short)
  const hasVisual = s.elements.some(
    (e) => (e.type === "image" && e.src.trim()) || e.type === "sticker" || e.type === "shape"
  );
  return !hasVisual;
}
