/**
 * Back-compat converter: turns a V1 flow slide (heading/text/bullets/code
 * stacked vertically, no positioning) into a V2 positioned slide.
 *
 * Not wired at runtime — the in-memory seed is authored natively in V2 —
 * but this is the import hook for any V1 documents that show up once
 * persistence (Supabase) lands.
 */

import { defaultAIMeta, manifestTypeForElementType } from "../manifest";
import type { Slide, SlideElement } from "../types";
import { SLIDE_W } from "./geometry";
import { DEFAULT_THEME_ID, findTheme, themeRef } from "./themes";

interface V1FlowElement {
  id: string;
  type: "heading" | "text" | "bullets" | "code";
  text?: string;
  items?: string[];
  code?: string;
  language?: string;
}

interface V1Slide {
  id: string;
  layout?: string;
  elements: V1FlowElement[];
  speakerNotes?: string;
  ai?: { formattingRules?: string[]; qualityChecks?: string[] };
}

const MARGIN = 72;
const heightFor: Record<V1FlowElement["type"], number> = {
  heading: 90,
  text: 120,
  bullets: 260,
  code: 280,
};

export function migrateFlowSlide(v1: V1Slide, order = 0): Slide {
  let y = 64;
  const elements: SlideElement[] = v1.elements.map((el, i) => {
    const height = el.type === "bullets" ? Math.max(120, (el.items?.length ?? 1) * 52) : heightFor[el.type];
    const frame = { x: MARGIN, y, width: SLIDE_W - MARGIN * 2, height, zIndex: i };
    y += height + 28;
    const base = {
      id: el.id,
      ...frame,
      style: {},
      ai: defaultAIMeta(manifestTypeForElementType(el.type === "bullets" ? "bullet_list" : el.type === "code" ? "code_block" : el.type)),
    };
    switch (el.type) {
      case "heading":
        return { ...base, type: "heading", text: el.text ?? "" };
      case "text":
        return { ...base, type: "text", text: el.text ?? "" };
      case "bullets":
        return { ...base, type: "bullet_list", items: el.items ?? [] };
      case "code":
        return { ...base, type: "code_block", code: el.code ?? "", language: el.language ?? "cpp" };
    }
  });

  return {
    id: v1.id,
    type: "slide",
    layout: "title_bullets",
    style: {
      background: findTheme(DEFAULT_THEME_ID).defaultBackground,
      theme: themeRef(findTheme(DEFAULT_THEME_ID)),
    },
    elements,
    speakerNotes: v1.speakerNotes,
    order,
    ai: {
      formattingRules: v1.ai?.formattingRules ?? [],
      qualityChecks: v1.ai?.qualityChecks ?? [],
      allowedActions: defaultAIMeta("slide").allowedActions,
    },
  };
}
