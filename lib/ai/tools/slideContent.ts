/**
 * The bridge between the agent's "layout + content slots" mental model and the
 * studio's positioned-element reality — bound to the SAME `SLIDE_LAYOUTS`
 * registry the renderer uses (one source of truth, no parallel definition).
 *
 * The agent picks a layout (an id from the registry) and fills its slots by
 * ROLE with rich text / bullets; these helpers turn that into validated,
 * positioned slide elements (with `runs` for emphasis), and derive the
 * role→element mapping back out for reads + targeted edits.
 */

import { z } from "zod";
import { createSlide } from "@/lib/course/factories";
import { SLIDE_LAYOUTS, findLayout } from "@/lib/course/slide/layouts";
import type { Slide, SlideElement, SlideElementType, SlideThemeId, TextRun } from "@/lib/course/types";
import { RichTextSchema, richTextToElement, richTextToPlain } from "../richText";

export type SlotKind = "text" | "bullets" | "code" | "image" | "decorative";

export function slotKind(type: SlideElementType): SlotKind {
  if (type === "heading" || type === "text" || type === "callout") return "text";
  if (type === "bullet_list") return "bullets";
  if (type === "code_block") return "code";
  if (type === "image") return "image";
  return "decorative"; // shape, divider, table, sticker
}

/** One content assignment the model emits: a slot `role` + its value. `text`
 *  (rich) fills text/heading/callout slots; `items` fills bullet slots. */
export const SlideContentEntrySchema = z.object({
  role: z.string(),
  text: RichTextSchema.nullable(),
  items: z.array(z.string()).nullable(),
});
export type SlideContentEntry = z.infer<typeof SlideContentEntrySchema>;

export const LAYOUT_IDS = SLIDE_LAYOUTS.map((l) => l.id);

/** Compact, AI-facing catalog of every layout the renderer supports — id,
 *  when to use / avoid it, and its slots. Feeds the system prompt + tool docs. */
export function slideLayoutCatalog() {
  return SLIDE_LAYOUTS.map((l) => ({
    id: l.id,
    name: l.name,
    bestFor: l.ai.bestFor,
    avoidWhen: l.ai.avoidWhen,
    slots: l.placeholders
      .map((p) => ({ role: p.role, kind: slotKind(p.type) }))
      .filter((s) => s.kind !== "decorative"),
  }));
}

type ContentUpdates = { text?: string; runs?: TextRun[]; items?: string[]; code?: string };

/** Convert one content entry into element-update fields, for the slot's kind.
 *  Text slots get `runs` (emphasis renders); bullet/code slots get plain text
 *  with markdown stripped (no leak). */
export function contentToUpdates(elementType: SlideElementType, entry: SlideContentEntry): ContentUpdates {
  switch (slotKind(elementType)) {
    case "text": {
      const { text, runs } = richTextToElement(entry.text);
      return { text, runs: runs ?? [] }; // [] clears any prior formatting on a rewrite
    }
    case "bullets": {
      const raw = entry.items ?? (entry.text ? [richTextToPlain(entry.text)] : []);
      return { items: raw.map((s) => richTextToPlain(s).trim()).filter(Boolean) };
    }
    case "code":
      return { code: entry.items?.length ? entry.items.join("\n") : richTextToPlain(entry.text) };
    default:
      return {}; // image/decorative: no text content this pass
  }
}

/** Build a fresh slide for `layoutId`, filling slots from `content` by role.
 *  Elements come from the layout's placeholders (positioned, themed). */
export function buildSlide(
  layoutId: string,
  content: SlideContentEntry[],
  themeId: SlideThemeId
): Slide {
  const layout = findLayout(layoutId) ?? findLayout("title_bullets")!;
  const slide = createSlide(layout.id, themeId);
  // createSlide maps placeholders→elements 1:1 in order.
  const roleToIndex = new Map(layout.placeholders.map((p, i) => [p.role, i]));
  for (const entry of content) {
    const idx = roleToIndex.get(entry.role);
    if (idx === undefined) continue;
    const el = slide.elements[idx];
    Object.assign(el, contentToUpdates(el.type, entry));
  }
  return slide;
}

export interface DerivedSlot {
  role: string;
  type: SlideElementType;
  kind: SlotKind;
  element: SlideElement;
}

/** Map a slide's CURRENT elements back to the roles of its current layout
 *  (greedy by exact type, in order). Used for reads + targeted edits. Falls
 *  back to synthetic roles for custom/unknown layouts. */
export function deriveSlots(slide: Slide): DerivedSlot[] {
  const layout = findLayout(slide.layout);
  if (!layout) {
    return slide.elements.map((el, i) => ({
      role: `${el.type}-${i + 1}`,
      type: el.type,
      kind: slotKind(el.type),
      element: el,
    }));
  }
  const remaining = [...slide.elements];
  const slots: DerivedSlot[] = [];
  for (const p of layout.placeholders) {
    const idx = remaining.findIndex((el) => el.type === p.type);
    if (idx === -1) continue;
    const [el] = remaining.splice(idx, 1);
    slots.push({ role: p.role, type: p.type, kind: slotKind(p.type), element: el });
  }
  return slots;
}

/** Human-readable current value of a slot (for get_deck / get_slide). */
export function slotText(el: SlideElement): string {
  if (el.type === "heading" || el.type === "text" || el.type === "callout") return el.text;
  if (el.type === "bullet_list") return el.items.join(" · ");
  if (el.type === "code_block") return el.code;
  if (el.type === "image") return el.alt || "(image)";
  return "";
}

/** Validate that every content role exists in `layoutId`. Returns clear error
 *  strings (fed back to the model so it self-corrects in the loop). */
export function validateSlideContent(layoutId: string, content: SlideContentEntry[]): string[] {
  const layout = findLayout(layoutId);
  if (!layout) {
    return [`Unknown layout "${layoutId}". Valid layouts: ${LAYOUT_IDS.join(", ")}.`];
  }
  const roles = new Set(layout.placeholders.map((p) => p.role));
  const errors: string[] = [];
  for (const c of content) {
    if (!roles.has(c.role)) {
      errors.push(
        `Layout "${layoutId}" has no slot "${c.role}". Available slots: ${[...roles].join(", ")}.`
      );
    }
  }
  return errors;
}
