/**
 * Materialize the `comparison_columns` layout (ComparisonColumnsLayout.tsx)
 * FAITHFULLY: header (eyebrow + title + subtitle), then 2–3 option columns, then
 * an optional footer band.
 *
 * Each column is ONE group: a white card + a per-option colour top bar + the
 * option name + its points as grouped dot rows (a colour-tinted dot + a two-tone
 * "label / detail" text). Colours are assigned BY INDEX (A=accent, B=blue,
 * C=teal), matching the renderer. "bare" drops the card for a colour rule. The
 * footer is an accent-tinted box. The card sits behind its content (lower z).
 */

import { newId } from "../../factories";
import type {
  ComparisonColumnsContent,
  ComparisonOption,
  SlideElement,
  TextRun,
} from "../../types";
import { SHADOW_PRESETS } from "../styleResolver";
import {
  CARD,
  CC,
  EYEBROW,
  ccDotBg,
  ccFootBg,
  ccFootBorder,
  optionColor,
  withAlpha,
} from "../structured/styleConstants";
import {
  Flow,
  ellipse,
  estimateTextHeight,
  eyebrowRow,
  heading,
  rect,
  rtText,
  sticker,
  text,
  type MaterializeCtx,
} from "./builders";

const LETTERS = ["A", "B", "C"];

const PAD_X = CC.padX; // 64
const CONTENT_W = 1280 - PAD_X * 2; // 1152

/** Stack an option's points as dot rows; returns the elements + consumed height. */
function pointRows(option: ComparisonOption, x: number, top: number, width: number, color: string, ink: string, muted: string, group: string[]): { els: SlideElement[]; height: number } {
  const els: SlideElement[] = [];
  const textX = x + 28;
  const textW = width - 28;
  let y = top;
  option.points.forEach((pt, j) => {
    const label = rtText(pt.label) || "Point";
    const detail = rtText(pt.detail);
    const labelH = estimateTextHeight(label, { fontSizePx: CC.pointLabelFont, lineHeight: 1.3, widthPx: textW });
    const detailH = detail ? estimateTextHeight(detail, { fontSizePx: CC.pointDetailFont, lineHeight: 1.4, widthPx: textW }) : 0;
    const rowH = Math.max(18, labelH + (detail ? detailH : 0));
    els.push(ellipse(`point.${j}.dot`, { x, y: y + 4, width: 18, height: 18 }, { fill: ccDotBg(color), groupPath: group }));
    const runs: TextRun[] = [{ text: detail ? `${label}\n` : label, marks: { bold: true, color: ink } }];
    if (detail) runs.push({ text: detail, marks: { color: muted } });
    els.push(
      text(`point.${j}.text`, { x: textX, y, width: textW, height: rowH }, detail ? `${label}\n${detail}` : label, {
        fontSizePx: CC.pointLabelFont,
        weight: 600,
        color: ink,
        lineHeight: 1.3,
        runs,
        groupPath: group,
      })
    );
    y += rowH + 14;
  });
  return { els, height: y - top };
}

export function materializeComparisonColumns(
  content: ComparisonColumnsContent,
  ctx: MaterializeCtx
): SlideElement[] {
  const els: SlideElement[] = [];
  const bare = (content.presentation ?? "cards") === "bare";
  const options = content.options;
  const n = Math.max(1, options.length);

  // ── Header.
  const flow = new Flow(CC.padTop);
  const eyebrow = rtText(content.eyebrow);
  if (eyebrow) {
    const top = flow.place(20);
    els.push(...eyebrowRow("eyebrow", PAD_X, top, eyebrow, ctx.accent));
  }
  const titleStr = rtText(content.title) || "Comparison title";
  const titleH = estimateTextHeight(titleStr, { fontSizePx: CC.titleFont, lineHeight: 1.08, widthPx: CONTENT_W, family: "display" });
  const titleTop = flow.place(titleH, eyebrow ? EYEBROW.marginBottom : 0);
  els.push(
    heading("title", { x: PAD_X, y: titleTop, width: CONTENT_W, height: titleH }, titleStr, {
      family: "display",
      fontSizePx: CC.titleFont,
      weight: 400,
      color: ctx.ink,
      lineHeight: 1.08,
      letterSpacing: -0.6,
    })
  );
  const subtitle = rtText(content.subtitle);
  if (subtitle) {
    const h = estimateTextHeight(subtitle, { fontSizePx: 18, lineHeight: 1.4, widthPx: CONTENT_W });
    const top = flow.place(h, 8);
    els.push(text("subtitle", { x: PAD_X, y: top, width: CONTENT_W, height: h }, subtitle, { fontSizePx: 18, color: ctx.muted, lineHeight: 1.4 }));
  }
  const headerBottom = flow.y + 22;

  // ── Footer (pins the columns' bottom).
  const footer = content.footer;
  let footH = 0;
  let footTop = 0;
  let footText = "";
  let footTint = ctx.accent;
  if (footer) {
    footText = footer.kind === "summary" ? rtText(footer.text) : `In common: ${footer.points.map(rtText).filter(Boolean).join(", ")}`;
    footTint = footer.kind === "summary" ? ctx.accent : optionColor(1, ctx.accent);
    if (footText) {
      footH = Math.max(56, estimateTextHeight(footText, { fontSizePx: CC.footFont, lineHeight: 1.4, widthPx: 1010 }) + 30);
      footTop = 720 - CC.padBottom - footH;
    }
  }
  const columnsBottom = footText ? footTop - 18 : 720 - CC.padBottom;
  const columnsTop = headerBottom;
  const columnsH = Math.max(80, columnsBottom - columnsTop);

  // ── Columns.
  const colW = Math.floor((CONTENT_W - (n - 1) * CC.gap) / n);
  options.forEach((option, i) => {
    const colX = PAD_X + i * (colW + CC.gap);
    const color = optionColor(i, ctx.accent);
    const group = [newId("grp")];
    const nameStr = rtText(option.name) || "Option";

    if (!bare) {
      els.push(
        rect(`col.${i}.card`, { x: colX, y: columnsTop, width: colW, height: columnsH }, {
          fill: CARD.bg,
          borderColor: CARD.border,
          borderWidth: CARD.borderWidth,
          borderRadius: CARD.radius,
          shadow: SHADOW_PRESETS.subtle,
          groupPath: group,
        })
      );
      els.push(rect(`col.${i}.bar`, { x: colX, y: columnsTop, width: colW, height: CC.barH }, { fill: color, groupPath: group }));
      const innerX = colX + CC.cardPad;
      const innerW = colW - 2 * CC.cardPad;
      const headTop = columnsTop + CC.barH + CC.cardPad;
      // Option icon (sticker) or letter chip, then the name (vertically centered).
      const badgeSize = option.icon ? 36 : 34;
      const nameX = innerX + badgeSize + 12;
      if (option.icon) {
        els.push(sticker(`col.${i}.icon`, { x: innerX, y: headTop, width: 36, height: 36 }, option.icon, { glyphColor: color, circleColor: withAlpha(color, 0.12), groupPath: group }));
      } else {
        els.push(text(`col.${i}.letter`, { x: innerX, y: headTop, width: 34, height: 34 }, LETTERS[i] ?? String(i + 1), { family: "mono", fontSizePx: 15, weight: 700, color, backgroundColor: withAlpha(color, 0.14), borderRadius: 10, align: "center", valign: "middle", lineHeight: 1, groupPath: group }));
      }
      const nameW = colW - CC.cardPad - (nameX - colX);
      const nameH = estimateTextHeight(nameStr, { fontSizePx: CC.nameFont, lineHeight: 1.15, widthPx: nameW });
      els.push(heading(`col.${i}.name`, { x: nameX, y: headTop + Math.max(0, (36 - nameH) / 2), width: nameW, height: nameH }, nameStr, { fontSizePx: CC.nameFont, weight: 700, color: ctx.ink, lineHeight: 1.15, groupPath: group }));
      const rows = pointRows(option, innerX, headTop + Math.max(36, nameH) + 18, innerW, color, ctx.ink, ctx.muted, group);
      els.push(...rows.els);
    } else {
      const circle = 52;
      els.push(text(`col.${i}.letter`, { x: colX, y: columnsTop, width: circle, height: circle }, LETTERS[i] ?? String(i + 1), { family: "mono", fontSizePx: 22, weight: 700, color: "#ffffff", backgroundColor: color, borderRadius: 999, align: "center", valign: "middle", lineHeight: 1, groupPath: group }));
      if (option.icon) {
        els.push(sticker(`col.${i}.icon`, { x: colX + circle + 14, y: columnsTop + 8, width: 36, height: 36 }, option.icon, { glyphColor: color, circleColor: withAlpha(color, 0.12), groupPath: group }));
      }
      const nameTop = columnsTop + circle + 8;
      const nameH = estimateTextHeight(nameStr, { fontSizePx: 25, lineHeight: 1.12, widthPx: colW });
      els.push(heading(`col.${i}.name`, { x: colX, y: nameTop, width: colW, height: nameH }, nameStr, { fontSizePx: 25, weight: 700, color: ctx.ink, lineHeight: 1.12, groupPath: group }));
      const ruleTop = nameTop + nameH + 14;
      els.push(rect(`col.${i}.rule`, { x: colX, y: ruleTop, width: 64, height: 3 }, { fill: color, borderRadius: 2, groupPath: group }));
      const rows = pointRows(option, colX, ruleTop + 18, colW, color, ctx.ink, ctx.muted, group);
      els.push(...rows.els);
    }
  });

  // ── Footer band (accent-tinted box; the renderer's star/users icon is omitted).
  if (footText) {
    const footG = [newId("grp")];
    els.push(rect("footer.box", { x: PAD_X, y: footTop, width: CONTENT_W, height: footH }, { fill: ccFootBg(footTint), borderColor: ccFootBorder(footTint), borderWidth: 1, borderRadius: CC.footRadius, groupPath: footG }));
    els.push(text("footer.text", { x: PAD_X + 20, y: footTop, width: CONTENT_W - 40, height: footH }, footText, { fontSizePx: CC.footFont, color: ctx.body, lineHeight: 1.4, valign: "middle", groupPath: footG }));
  }

  return els;
}
