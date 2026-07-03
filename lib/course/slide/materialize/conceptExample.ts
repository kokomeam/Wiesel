/**
 * Materialize the `concept_example` layout (ConceptExampleLayout.tsx) FAITHFULLY:
 * left "concept" column (badge pill → title → accent rule → definition), an "in
 * practice" connector (line + arrow halo + label), the right worked-example CARD
 * (peach tint + border + shadow, badge pill, numbered step chips OR paragraphs),
 * and the bottom footnote callout (accent-tinted box). Geometry/colours come from
 * the shared styleConstants the renderer uses, so the look carries over.
 *
 * Grouping (groupPath) mirrors Google Slides: the concept column, the connector,
 * and the example card are each ONE group — single click moves the unit,
 * double-click descends to a piece. The card background sits behind its content
 * (lower zIndex via array order).
 */

import { newId } from "../../factories";
import type { ConceptExampleContent, SlideElement } from "../../types";
import { SHADOW_PRESETS } from "../styleResolver";
import {
  BADGE,
  CARD,
  CE,
  badgeBg,
  badgeBorder,
  cardTint,
  ceChipBg,
  ceFootBg,
  ceFootBorder,
  ceRule,
} from "../structured/styleConstants";
import {
  chip,
  estimateTextHeight,
  heading,
  pill,
  rect,
  rtText,
  sticker,
  text,
  type MaterializeCtx,
} from "./builders";

const LEFT_X = CE.padX; // 80
const CONNECTOR_X = CE.padX + CE.colW + CE.colGap; // 592
const RIGHT_X = CONNECTOR_X + CE.connectorW + CE.colGap; // 692
const BADGE_LS = BADGE.fontSize * BADGE.letterSpacingEm;

interface Row {
  h: number;
  mt?: number;
  make: (top: number) => SlideElement[];
}

function placeCentered(rows: Row[], regionTop: number, regionH: number): SlideElement[] {
  const total = rows.reduce((s, r, i) => s + r.h + (i > 0 ? r.mt ?? 0 : 0), 0);
  let y = regionTop + Math.max(0, (regionH - total) / 2);
  const out: SlideElement[] = [];
  rows.forEach((r, i) => {
    if (i > 0) y += r.mt ?? 0;
    out.push(...r.make(y));
    y += r.h;
  });
  return out;
}

function badge(role: string, x: number, y: number, label: string, accent: string, group: string[]) {
  return pill(role, x, y, label, {
    accent,
    bg: badgeBg(accent),
    border: badgeBorder(accent),
    fontSizePx: BADGE.fontSize,
    height: BADGE.height,
    letterSpacing: BADGE_LS,
    groupPath: group,
  });
}

export function materializeConceptExample(
  content: ConceptExampleContent,
  ctx: MaterializeCtx
): SlideElement[] {
  const els: SlideElement[] = [];
  const conceptG = [newId("grp")];
  const connectorG = [newId("grp")];
  const exampleG = [newId("grp")];

  // ── Footnote pins the row bottom.
  const footText = rtText(content.footnote);
  let footH = 0;
  let footTop = 0;
  if (footText) {
    footH = Math.max(58, estimateTextHeight(footText, { fontSizePx: CE.footFont, lineHeight: 1.4, widthPx: 1010 }) + 2 * CE.footPadY + 8);
    footTop = 720 - CE.padBottom - footH;
  }
  const rowBottom = footText ? footTop - CE.footMarginTop : 720 - CE.padBottom;
  const rowTop = CE.padTop;
  const rowH = rowBottom - rowTop;

  // ── Left column: concept (centered in the row).
  const serif = (content.concept.titleStyle ?? "serif") === "serif";
  const titleStr = rtText(content.concept.title) || "The rule or concept";
  const titleFont = serif ? CE.titleSerif : CE.titleSans;
  const titleH = estimateTextHeight(titleStr, { fontSizePx: titleFont, lineHeight: 1.06, widthPx: CE.colW, family: serif ? "display" : "sans" });
  const defStr = rtText(content.concept.definition);
  const defH = defStr ? estimateTextHeight(defStr, { fontSizePx: CE.definitionFont, lineHeight: 1.5, widthPx: CE.colW, minLines: 2 }) : 0;

  const leftRows: Row[] = [
    { h: BADGE.height, make: (top) => [badge("concept.badge", LEFT_X, top, content.concept.badge ?? "Concept", ctx.accent, conceptG)] },
    {
      h: titleH,
      mt: 18,
      make: (top) => [
        heading("concept.title", { x: LEFT_X, y: top, width: CE.colW, height: titleH }, titleStr, {
          family: serif ? "display" : "sans",
          fontSizePx: titleFont,
          weight: serif ? 400 : 700,
          color: ctx.ink,
          lineHeight: 1.06,
          letterSpacing: -0.7,
          groupPath: conceptG,
        }),
      ],
    },
    {
      h: CE.ruleH,
      mt: 20,
      make: (top) => [rect("concept.rule", { x: LEFT_X, y: top, width: CE.ruleW, height: CE.ruleH }, { fill: ceRule(ctx.accent), borderRadius: 2, groupPath: conceptG })],
    },
  ];
  if (defStr) {
    leftRows.push({
      h: defH,
      mt: 20,
      make: (top) => [
        text("concept.definition", { x: LEFT_X, y: top, width: CE.colW, height: defH }, defStr, {
          fontSizePx: CE.definitionFont,
          color: ctx.body,
          lineHeight: 1.5,
          groupPath: conceptG,
        }),
      ],
    });
  }
  els.push(...placeCentered(leftRows, rowTop, rowH));

  // ── Connector: "in practice" (line → arrow halo → label), centered.
  const connRows: Row[] = [
    { h: 2, make: (top) => [rect("connector.line", { x: CONNECTOR_X + 33, y: top, width: 30, height: 2 }, { fill: ceRule(ctx.accent), groupPath: connectorG })] },
    { h: 40, mt: 10, make: (top) => [sticker("connector.arrow", { x: CONNECTOR_X + 28, y: top, width: 40, height: 40 }, "arrow-right", { glyphColor: ctx.accent, circleColor: ceChipBg(ctx.accent), groupPath: connectorG })] },
    {
      h: 14,
      mt: 10,
      make: (top) => [
        text("connector.label", { x: CONNECTOR_X, y: top, width: CE.connectorW, height: 14 }, "IN PRACTICE", {
          family: "mono",
          fontSizePx: 10,
          weight: 600,
          color: ctx.muted,
          align: "center",
          letterSpacing: 1,
          lineHeight: 1.2,
          groupPath: connectorG,
        }),
      ],
    },
  ];
  els.push(...placeCentered(connRows, rowTop, rowH));

  // ── Right column: the worked-example card (bg behind content → pushed first).
  els.push(
    rect("example.card", { x: RIGHT_X, y: rowTop, width: CE.colW, height: rowH }, {
      fill: cardTint(ctx.accent),
      borderColor: CARD.border,
      borderWidth: CARD.borderWidth,
      borderRadius: CARD.radius,
      shadow: SHADOW_PRESETS.subtle,
      groupPath: exampleG,
    })
  );
  const innerX = RIGHT_X + CE.cardPad;
  const innerW = CE.colW - 2 * CE.cardPad; // 452
  const innerTop = rowTop + CE.cardPad;
  const innerH = rowH - 2 * CE.cardPad;

  const cardRows: Row[] = [
    { h: BADGE.height, make: (top) => [badge("example.badge", innerX, top, content.example.badge ?? "Worked Example", ctx.accent, exampleG)] },
  ];
  const exTitle = rtText(content.example.title);
  if (exTitle) {
    const h = estimateTextHeight(exTitle, { fontSizePx: 23, lineHeight: 1.2, widthPx: innerW });
    cardRows.push({
      h,
      mt: 12,
      make: (top) => [
        text("example.title", { x: innerX, y: top, width: innerW, height: h }, exTitle, { fontSizePx: 23, weight: 600, color: ctx.ink, lineHeight: 1.2, groupPath: exampleG }),
      ],
    });
  }

  const body = content.example.body;
  const textX = innerX + CE.chip + CE.chipGap; // chip + gap
  const textW = innerW - CE.chip - CE.chipGap;
  if (body.kind === "steps") {
    body.steps.forEach((step, i) => {
      const head = rtText(step.heading) || "Step";
      const sub = rtText(step.body);
      const headH = estimateTextHeight(head, { fontSizePx: CE.stepHeadingFont, lineHeight: 1.25, widthPx: textW });
      const subH = sub ? estimateTextHeight(sub, { fontSizePx: CE.stepBodyFont, lineHeight: 1.4, widthPx: textW }) : 0;
      const h = Math.max(CE.chip, headH + (sub ? 2 + subH : 0));
      cardRows.push({
        h,
        mt: i === 0 ? 16 : CE.stepGap,
        make: (top) => {
          const out: SlideElement[] = [
            chip(`example.step.${i}.chip`, innerX, top, String(i + 1), { color: ctx.accent, bg: ceChipBg(ctx.accent), size: CE.chip, fontSizePx: CE.chipFont, groupPath: exampleG }),
            text(`example.step.${i}.heading`, { x: textX, y: top, width: textW, height: headH }, head, { fontSizePx: CE.stepHeadingFont, weight: 600, color: ctx.ink, lineHeight: 1.25, groupPath: exampleG }),
          ];
          if (sub) {
            out.push(text(`example.step.${i}.body`, { x: textX, y: top + headH + 2, width: textW, height: subH }, sub, { fontSizePx: CE.stepBodyFont, color: ctx.muted, lineHeight: 1.4, groupPath: exampleG }));
          }
          return out;
        },
      });
    });
  } else {
    body.paragraphs.map(rtText).filter(Boolean).forEach((p, i) => {
      const h = estimateTextHeight(p, { fontSizePx: 17, lineHeight: 1.5, widthPx: innerW });
      cardRows.push({
        h,
        mt: i === 0 ? 16 : 14,
        make: (top) => [text(`example.paragraph.${i}`, { x: innerX, y: top, width: innerW, height: h }, p, { fontSizePx: 17, color: ctx.body, lineHeight: 1.5, groupPath: exampleG })],
      });
    });
  }
  els.push(...placeCentered(cardRows, innerTop, innerH));

  // ── Footnote callout: accent-tinted box + text (faithful to the renderer's
  //    peach band; the small Info icon is omitted — no info sticker in the set).
  if (footText) {
    const footG = [newId("grp")];
    els.push(
      rect("footnote.box", { x: CE.padX, y: footTop, width: 1120, height: footH }, {
        fill: ceFootBg(ctx.accent),
        borderColor: ceFootBorder(ctx.accent),
        borderWidth: 1,
        borderRadius: CE.footRadius,
        groupPath: footG,
      })
    );
    els.push(
      sticker("footnote.icon", { x: CE.padX + CE.footPadX, y: footTop + (footH - 18) / 2, width: 18, height: 18 }, "info", {
        glyphColor: ctx.accent,
        circleColor: "transparent",
        groupPath: footG,
      })
    );
    const ftx = CE.padX + CE.footPadX + 18 + 12;
    els.push(
      text("footnote.text", { x: ftx, y: footTop, width: 1120 - CE.footPadX - (ftx - CE.padX), height: footH }, footText, {
        fontSizePx: CE.footFont,
        color: ctx.body,
        lineHeight: 1.4,
        valign: "middle",
        groupPath: footG,
      })
    );
  }

  return els;
}
