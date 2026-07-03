/**
 * Materialize the `prose` layout (ProseLayout.tsx): eyebrow (mono + accent rule)
 * → display title → body → optional key points (faithful accent-dot bullet list)
 * → the bottom accent rule. Measures/colours come from the shared styleConstants.
 */

import type { ProseContent, SlideElement } from "../../types";
import { EYEBROW, PROSE, proseRule } from "../structured/styleConstants";
import {
  Flow,
  bulletList,
  estimateBulletListHeight,
  estimateTextHeight,
  eyebrowRow,
  heading,
  rect,
  rtText,
  text,
  type MaterializeCtx,
} from "./builders";

const X = PROSE.padX;
const W = PROSE.maxW;

export function materializeProse(content: ProseContent, ctx: MaterializeCtx): SlideElement[] {
  const els: SlideElement[] = [];
  const flow = new Flow(PROSE.padTop);

  const eyebrow = rtText(content.eyebrow);
  if (eyebrow) {
    const top = flow.place(20);
    els.push(...eyebrowRow("eyebrow", X, top, eyebrow, ctx.accent));
  }

  const titleStr = rtText(content.title) || "Slide title";
  const titleH = estimateTextHeight(titleStr, { fontSizePx: PROSE.titleFont, lineHeight: 1.08, widthPx: W, family: "display" });
  const titleTop = flow.place(titleH, eyebrow ? EYEBROW.marginBottom : 0);
  els.push(
    heading("title", { x: X, y: titleTop, width: W, height: titleH }, titleStr, {
      family: "display",
      fontSizePx: PROSE.titleFont,
      weight: 300,
      color: ctx.ink,
      lineHeight: 1.08,
      letterSpacing: -0.9,
    })
  );

  const bodyStr = rtText(content.body);
  if (bodyStr) {
    const bodyH = estimateTextHeight(bodyStr, { fontSizePx: PROSE.bodyFont, lineHeight: 1.6, widthPx: W, minLines: 2 });
    const bodyTop = flow.place(bodyH, 24);
    els.push(
      text("body", { x: X, y: bodyTop, width: W, height: bodyH }, bodyStr, { fontSizePx: PROSE.bodyFont, color: ctx.body, lineHeight: 1.6 })
    );
  }

  const points = (content.points ?? []).map(rtText).filter(Boolean);
  if (points.length) {
    const ptsH = estimateBulletListHeight(points, { fontSizePx: PROSE.pointFont, lineHeight: 1.45, widthPx: W - 20 });
    const ptsTop = flow.place(ptsH, 28);
    els.push(
      bulletList("points", { x: X, y: ptsTop, width: W, height: ptsH }, points, { fontSizePx: PROSE.pointFont, color: ctx.ink, lineHeight: 1.45 })
    );
  }

  els.push(
    rect("decor.rule", { x: PROSE.ruleX, y: PROSE.ruleY, width: PROSE.ruleW, height: PROSE.ruleH }, {
      fill: proseRule(ctx.accent),
      borderRadius: 2,
      locked: true,
    })
  );

  return els;
}
