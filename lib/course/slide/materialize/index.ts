/**
 * Materialize-on-eject entry point.
 *
 * `materializeSlide` turns a renderer-owned structured slide (`slide.template`)
 * into freeform `SlideElement[]` on the same 1280×720 canvas — the deterministic
 * "layout recipe → editable elements" step. The result is rendered through the
 * EXISTING element path (ElementView) and edited with the existing drag / resize
 * / snap / group / inspector tools; nothing here asks the AI for coordinates.
 *
 * Pure except `newId` (used by the builders) — call from event handlers / tests
 * only, never during render.
 *
 * Adding a layout = write a `materialize<Layout>` and add one switch case; an
 * unsupported layout returns `null` so the slide stays structured (graceful).
 */

import type { Slide, SlideElement } from "../../types";
import { makeCtx } from "./builders";
import { materializeComparisonColumns } from "./comparisonColumns";
import { materializeConceptExample } from "./conceptExample";
import { materializeImageSupporting } from "./imageSupporting";
import { materializeOutlineList } from "./outlineList";
import { materializeProse } from "./prose";

/** Structured layouts that have a deterministic materializer today. */
export const MATERIALIZABLE_LAYOUT_IDS = [
  "prose",
  "outline_list",
  "concept_example",
  "comparison_columns",
  "image_supporting",
] as const;

export type MaterializableLayoutId = (typeof MATERIALIZABLE_LAYOUT_IDS)[number];

/** True when the slide is a structured slide whose layout can be ejected to
 *  editable elements (drives the "Edit freely" affordance). */
export function canMaterializeSlide(slide: Slide): boolean {
  return (
    !!slide.template &&
    (MATERIALIZABLE_LAYOUT_IDS as readonly string[]).includes(slide.template.layoutId)
  );
}

/**
 * Build the editable `SlideElement[]` for a structured slide. Returns `null`
 * when the slide isn't structured or its layout has no materializer yet (so the
 * caller keeps it structured — never a partial / lossy conversion).
 */
export function materializeSlide(slide: Slide): SlideElement[] | null {
  const tpl = slide.template;
  if (!tpl) return null;
  const ctx = makeCtx(slide.style.theme.id);

  let els: SlideElement[] | null;
  switch (tpl.layoutId) {
    case "prose":
      els = materializeProse(tpl.content, ctx);
      break;
    case "outline_list":
      els = materializeOutlineList(tpl.content, ctx);
      break;
    case "concept_example":
      els = materializeConceptExample(tpl.content, ctx);
      break;
    case "comparison_columns":
      els = materializeComparisonColumns(tpl.content, ctx);
      break;
    case "image_supporting":
      els = materializeImageSupporting(tpl.content, ctx);
      break;
    default:
      els = null;
  }
  if (!els || els.length === 0) return null;

  // Final z-order = array order (card/decor backgrounds were pushed before the
  // text/content they sit behind).
  els.forEach((el, i) => {
    el.zIndex = i;
  });
  return els;
}
