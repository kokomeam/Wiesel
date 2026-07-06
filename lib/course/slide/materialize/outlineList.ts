/**
 * Materialize the `outline_list` layout (OutlineListLayout.tsx) FAITHFULLY as a
 * single RICH LIST: top items keep the mono accent "01/02" numerals (bold ink
 * text); sub-points become level-1 dash rows (accent dash + muted text). One
 * editable list element — Enter adds an item, Tab/Shift+Tab nests, markers and
 * colors are preserved (not downgraded to generic black bullets).
 */

import { newId } from "../../factories";
import type { OutlineListContent, SlideElement, SlideListContent, SlideListItem } from "../../types";
import { LIST_INDENT_STEP } from "../list";
import { OL, olRule } from "../structured/styleConstants";
import { estimateLines, estimateTextHeight, heading, rect, richList, rtText, type MaterializeCtx } from "./builders";

export function materializeOutlineList(
  content: OutlineListContent,
  ctx: MaterializeCtx
): SlideElement[] {
  const els: SlideElement[] = [];
  const n = Math.max(1, content.items.length);
  const itemFont = n <= 3 ? 30 : n === 4 ? 26 : 22;
  const subFont = n <= 3 ? 18 : 16;

  // Top accent bar + title + rule (decor locked except the title).
  els.push(rect("decor.bar", { x: OL.barX, y: OL.barY, width: OL.barW, height: OL.barH }, { fill: ctx.accent, borderRadius: 3, locked: true }));
  const titleStr = rtText(content.title) || "List title";
  const titleH = estimateTextHeight(titleStr, { fontSizePx: OL.titleFont, lineHeight: 1.06, widthPx: OL.titleW, family: "display" });
  els.push(
    heading("title", { x: OL.titleX, y: OL.titleY, width: OL.titleW, height: titleH }, titleStr, {
      family: "display",
      fontSizePx: OL.titleFont,
      weight: 400,
      color: ctx.ink,
      lineHeight: 1.06,
      letterSpacing: -0.66,
    })
  );
  els.push(rect("decor.rule", { x: 80, y: OL.ruleY, width: 1120, height: 2 }, { fill: olRule(ctx.accent), locked: true }));

  // The list itself: numbered top items + dash sub-points.
  const items: SlideListItem[] = [];
  content.items.forEach((item, i) => {
    const t = rtText(item.text);
    items.push({ id: newId("li"), text: t || "Outline item", level: 0, markerText: String(i + 1).padStart(2, "0"), textColor: ctx.ink });
    for (const sub of item.subItems ?? []) {
      const s = rtText(sub);
      if (s) items.push({ id: newId("li"), text: s, level: 1, markerKind: "dash", textColor: ctx.muted });
    }
  });
  const list: SlideListContent = {
    items,
    defaultMarkerKind: "number",
    markerColor: ctx.accent,
    levelStyles: [
      { markerKind: "number", markerColor: ctx.accent },
      { markerKind: "dash", markerColor: ctx.accent, textColor: ctx.muted, fontSize: subFont },
    ],
  };

  // Estimate the list box height (matches the renderer's per-level fonts + gaps).
  let h = 0;
  items.forEach((it, i) => {
    const font = it.level === 0 ? itemFont : subFont;
    const lh = it.level === 0 ? 1.2 : 1.3;
    const lines = estimateLines(it.text, { fontSizePx: font, lineHeight: lh, widthPx: 1120 - it.level * LIST_INDENT_STEP - 40 });
    const mt = i === 0 ? 0 : it.level > items[i - 1].level ? 4 : it.level === 0 ? 12 : 7;
    h += lines * font * lh + mt;
  });

  els.push(
    richList("items", { x: 80, y: OL.regionTop, width: 1120, height: Math.ceil(h) + 8 }, list, {
      fontSizePx: itemFont,
      color: ctx.ink,
      lineHeight: 1.2,
    })
  );

  return els;
}
