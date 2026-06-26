"use client";

/**
 * The `image_supporting` layout — text-led teaching (eyebrow + title + lead +
 * bullets) on the left beside a SUPPORTING square image on the right, with an
 * optional caption below it. Mirrors the approved reference.
 *
 * The image sits in a FIXED 1:1 box with object-fit: cover so it can't bleed into
 * the text column. Pure markup (a stored URL — never a blob/data URL).
 */

import type { ImageSupportingContent } from "@/lib/course/types";
import { EditableText, Eyebrow, withAlpha, type StructuredCtx } from "./common";

const PAD = 64;
const IMG_SIDE = 384; // 1:1 — container AR == image AR
const IMG_X = 1280 - PAD - IMG_SIDE;
const IMG_Y = 150;
const LEFT_W = IMG_X - PAD - 56;

export function ImageSupportingLayout({ content, ctx }: { content: ImageSupportingContent; ctx: StructuredCtx }) {
  const bullets = content.bullets ?? [];
  const hasLead = !!content.lead?.text?.trim() || ctx.interactive;
  const hasCaption = !!content.caption?.text?.trim() || ctx.interactive;

  const aiEnvelope = ctx.interactive
    ? {
        "data-ai-component": "slide-visual",
        "data-ai-type": "image_supporting",
        "data-ai-source": content.source ?? "ai_generated",
        "data-ai-actions": "regenerate,replace,edit_caption,edit_alt,remove",
      }
    : {};

  return (
    <div className="absolute inset-0">
      {/* Left column — the teaching. */}
      <div className="absolute flex flex-col" style={{ left: PAD, top: 92, width: LEFT_W }}>
        <Eyebrow value={content.eyebrow} path={["eyebrow"]} ctx={ctx} />
        <EditableText
          value={content.title}
          path={["title"]}
          ctx={ctx}
          placeholder="Slide title"
          className="block [font-family:var(--font-display)]"
          style={{ color: ctx.ink, fontSize: 44, fontWeight: 300, lineHeight: 1.06, letterSpacing: "-0.02em" }}
        />
        {hasLead && (
          <EditableText
            value={content.lead}
            path={["lead"]}
            ctx={ctx}
            placeholder="One lead sentence"
            className="block"
            style={{ marginTop: 18, color: ctx.body, fontSize: 18, lineHeight: 1.5 }}
          />
        )}
        <span aria-hidden style={{ marginTop: 26, marginBottom: 22, width: 48, height: 3, borderRadius: 2, background: withAlpha(ctx.accent, 0.8) }} />
        <div className="flex flex-col" style={{ gap: 14 }}>
          {bullets.map((b, i) => (
            <div key={i} className="flex items-start" style={{ gap: 12 }}>
              <span aria-hidden style={{ flex: "0 0 auto", marginTop: 8, width: 7, height: 7, borderRadius: "50%", background: ctx.accent }} />
              <EditableText
                value={b}
                path={["bullets", i]}
                ctx={ctx}
                placeholder="A supporting point"
                className="block"
                style={{ color: ctx.ink, fontSize: 16.5, lineHeight: 1.45 }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Right — supporting square image. */}
      <div
        {...aiEnvelope}
        role="img"
        aria-label={content.alt ? `Image: ${content.alt}` : "Image"}
        className="absolute"
        style={{
          left: IMG_X,
          top: IMG_Y,
          width: IMG_SIDE,
          height: IMG_SIDE,
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
            <span style={{ fontSize: 11 }}>1024 × 1024 · 1:1</span>
          </div>
        )}
      </div>

      {hasCaption && (
        <EditableText
          value={content.caption}
          path={["caption"]}
          ctx={ctx}
          placeholder="Optional caption"
          className="absolute block"
          style={{ left: IMG_X, top: IMG_Y + IMG_SIDE + 16, width: IMG_SIDE, color: ctx.muted, fontSize: 13.5, lineHeight: 1.45 }}
        />
      )}
    </div>
  );
}
