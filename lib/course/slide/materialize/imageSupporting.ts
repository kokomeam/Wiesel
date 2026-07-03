/**
 * Materialize the `image_supporting` layout (ImageSupportingLayout.tsx): a
 * text-led left column (eyebrow + accent rule → display title → lead → accent
 * rule → faithful accent-dot bullets) beside a fixed 1:1 image, optional caption
 * beneath. The renderer is fully absolute, so this is a 1:1 port from the shared
 * constants — the image becomes a real move/resize/replaceable image element.
 */

import type { ImageSupportingContent, SlideElement } from "../../types";
import { EYEBROW, IMGS, imgsRule, imgsTint } from "../structured/styleConstants";
import {
  Flow,
  bulletList,
  estimateBulletListHeight,
  estimateTextHeight,
  eyebrowRow,
  heading,
  image,
  rect,
  rtText,
  text,
  type MaterializeCtx,
} from "./builders";

const PAD = IMGS.pad;
const IMG_X = IMGS.imgX;
const IMG_Y = IMGS.imgY;
const IMG_SIDE = IMGS.imgSide;
const LEFT_W = IMGS.leftW;

export function materializeImageSupporting(
  content: ImageSupportingContent,
  ctx: MaterializeCtx
): SlideElement[] {
  const els: SlideElement[] = [];
  const flow = new Flow(92);

  const eyebrow = rtText(content.eyebrow);
  if (eyebrow) {
    const top = flow.place(20);
    els.push(...eyebrowRow("eyebrow", PAD, top, eyebrow, ctx.accent));
  }

  const titleStr = rtText(content.title) || "Slide title";
  const titleH = estimateTextHeight(titleStr, { fontSizePx: IMGS.titleFont, lineHeight: 1.06, widthPx: LEFT_W, family: "display" });
  const titleTop = flow.place(titleH, eyebrow ? EYEBROW.marginBottom : 0);
  els.push(
    heading("title", { x: PAD, y: titleTop, width: LEFT_W, height: titleH }, titleStr, {
      family: "display",
      fontSizePx: IMGS.titleFont,
      weight: 300,
      color: ctx.ink,
      lineHeight: 1.06,
      letterSpacing: -0.88,
    })
  );

  const lead = rtText(content.lead);
  if (lead) {
    const leadH = estimateTextHeight(lead, { fontSizePx: IMGS.leadFont, lineHeight: 1.5, widthPx: LEFT_W });
    const leadTop = flow.place(leadH, 18);
    els.push(text("lead", { x: PAD, y: leadTop, width: LEFT_W, height: leadH }, lead, { fontSizePx: IMGS.leadFont, color: ctx.body, lineHeight: 1.5 }));
  }

  const bullets = (content.bullets ?? []).map(rtText).filter(Boolean);
  if (bullets.length) {
    const ruleTop = flow.place(3, 26);
    els.push(rect("decor.rule", { x: PAD, y: ruleTop, width: 48, height: 3 }, { fill: imgsRule(ctx.accent), borderRadius: 2, locked: true }));
    const listH = estimateBulletListHeight(bullets, { fontSizePx: IMGS.bulletFont, lineHeight: 1.45, widthPx: LEFT_W - 20 });
    const listTop = flow.place(listH, 22);
    els.push(bulletList("bullets", { x: PAD, y: listTop, width: LEFT_W, height: listH }, bullets, { fontSizePx: IMGS.bulletFont, color: ctx.ink, lineHeight: 1.45 }));
  }

  els.push(
    image("image.main", { x: IMG_X, y: IMG_Y, width: IMG_SIDE, height: IMG_SIDE }, content.imageUrl ?? "", {
      alt: content.alt ?? "",
      objectFit: "cover",
      borderRadius: IMGS.imgRadius,
      borderColor: IMGS.imgBorder,
      borderWidth: 1,
      backgroundColor: imgsTint(ctx.accent),
    })
  );

  const caption = rtText(content.caption);
  if (caption) {
    const capH = estimateTextHeight(caption, { fontSizePx: 13.5, lineHeight: 1.45, widthPx: IMG_SIDE });
    els.push(
      text("caption", { x: IMG_X, y: IMG_Y + IMG_SIDE + 16, width: IMG_SIDE, height: capH }, caption, { fontSizePx: 13.5, color: ctx.muted, lineHeight: 1.45 })
    );
  }

  return els;
}
