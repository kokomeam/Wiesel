"use client";

/**
 * The `image_reference` layout — a HERO generated image as the subject, with
 * annotation points referencing details in it and a bottom row of numbered
 * concept cards. Mirrors the approved reference: eyebrow + title top-left, a large
 * 3:2 image, up to 4 annotations on the right, up to 3 numbered cards below, and a
 * renderer-owned footer tagline.
 *
 * The image sits in a FIXED 3:2 box with object-fit: cover, so it physically
 * cannot bleed into the text column. Pure markup (a stored URL — never a
 * blob/data URL) so it renders identically in editor / thumbnail / SSR / export.
 */

import type { ImageReferenceContent } from "@/lib/course/types";
import { EditableText, Eyebrow, withAlpha, type StructuredCtx } from "./common";

const PAD = 60;
const BODY_TOP = 150;
const IMG_W = 648;
const IMG_H = 432; // exactly 3:2 (648 = 432 × 1.5) — container AR == image AR
const COL_GAP = 48;

export function ImageReferenceLayout({ content, ctx }: { content: ImageReferenceContent; ctx: StructuredCtx }) {
  const annotations = content.annotations ?? [];
  const cards = content.cards ?? [];
  const annoX = PAD + IMG_W + COL_GAP;
  const annoW = 1280 - annoX - PAD;
  const cardsTop = BODY_TOP + IMG_H + 26;

  const aiEnvelope = ctx.interactive
    ? {
        "data-ai-component": "slide-visual",
        "data-ai-type": "image_reference",
        "data-ai-source": content.source ?? "ai_generated",
        "data-ai-actions": "regenerate,replace,edit_alt,remove",
      }
    : {};

  return (
    <div className="absolute inset-0">
      {/* Header */}
      <div className="absolute" style={{ left: PAD, top: 40, right: PAD }}>
        <Eyebrow value={content.eyebrow} path={["eyebrow"]} ctx={ctx} />
        <EditableText
          value={content.title}
          path={["title"]}
          ctx={ctx}
          placeholder="Slide title"
          className="block [font-family:var(--font-display)]"
          style={{ color: ctx.ink, fontSize: 40, fontWeight: 300, lineHeight: 1.08, letterSpacing: "-0.02em" }}
        />
      </div>

      {/* Image — the subject. Fixed 3:2 box, object-fit cover. */}
      <div
        {...aiEnvelope}
        role="img"
        aria-label={content.alt ? `Image: ${content.alt}` : "Image"}
        className="absolute"
        style={{
          left: PAD,
          top: BODY_TOP,
          width: IMG_W,
          height: IMG_H,
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid rgba(120,113,108,0.16)",
          background: withAlpha(ctx.accent, 0.06),
        }}
      >
        {content.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={content.imageUrl} alt={content.alt} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        ) : (
          <div
            className="flex flex-col items-center justify-center font-mono uppercase"
            style={{ width: "100%", height: "100%", color: ctx.muted, fontSize: 12, letterSpacing: "0.12em", gap: 6 }}
          >
            <span>Image placeholder</span>
            <span style={{ fontSize: 11 }}>1536 × 1024 · 3:2</span>
          </div>
        )}
      </div>

      {/* Annotations — point at details in the image. */}
      <div className="absolute flex flex-col" style={{ left: annoX, top: BODY_TOP + 4, width: annoW, gap: 22 }}>
        {annotations.map((a, i) => (
          <div key={i} className="flex items-start" style={{ gap: 12 }}>
            <span aria-hidden style={{ flex: "0 0 auto", marginTop: 8, width: 8, height: 8, borderRadius: "50%", background: ctx.accent }} />
            <div className="flex flex-col" style={{ gap: 3 }}>
              <EditableText
                value={a.label}
                path={["annotations", i, "label"]}
                ctx={ctx}
                placeholder="Label"
                className="block"
                style={{ color: ctx.ink, fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}
              />
              <EditableText
                value={a.description}
                path={["annotations", i, "description"]}
                ctx={ctx}
                placeholder="One-line description"
                className="block"
                style={{ color: ctx.muted, fontSize: 14.5, lineHeight: 1.4 }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Numbered concept cards (renderer owns 01/02/03). */}
      {cards.length > 0 && (
        <div className="absolute flex" style={{ left: PAD, right: PAD, top: cardsTop, gap: 24 }}>
          {cards.map((c, i) => (
            <div key={i} className="flex flex-col" style={{ flex: 1, gap: 6 }}>
              <span className="font-mono" style={{ color: ctx.accent, fontSize: 16, fontWeight: 700, letterSpacing: "0.06em" }}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <EditableText
                value={c.title}
                path={["cards", i, "title"]}
                ctx={ctx}
                placeholder="Card title"
                className="block"
                style={{ color: ctx.ink, fontSize: 16, fontWeight: 600, lineHeight: 1.2 }}
              />
              <EditableText
                value={c.description}
                path={["cards", i, "description"]}
                ctx={ctx}
                placeholder="Two-line description"
                className="block"
                style={{ color: ctx.muted, fontSize: 13.5, lineHeight: 1.4 }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Renderer-owned footer tagline (not an AI slot). */}
      <div
        aria-hidden
        className="absolute font-mono uppercase"
        style={{ left: 0, right: 0, bottom: 22, textAlign: "center", color: ctx.accent, fontSize: 12, letterSpacing: "0.18em", opacity: 0.8 }}
      >
        Clarify · Connect · Apply
      </div>
    </div>
  );
}
