"use client";

/**
 * The `illustration` structured layout — a generated/uploaded teaching IMAGE.
 * Renders an optional title, the image (object-fit cover in a rounded frame), an
 * optional supporting-points column, and a teaching caption. The image is exposed
 * as a TEACHING OBJECT: `role="img"` + the required alt text for a11y, and the
 * machine-readable `data-ai-*` envelope so an agent can find / act on it.
 *
 * Pure markup (plain <img>, a stored URL — never a blob/data URL), so it renders
 * the same in the editor, thumbnails, SSR, and export.
 */

import type { IllustrationContent } from "@/lib/course/types";
import { EditableText, withAlpha, type StructuredCtx } from "./common";

const PAD = 80;
const TITLE_RESERVE = 96;

export function IllustrationLayout({ content, ctx }: { content: IllustrationContent; ctx: StructuredCtx }) {
  const points = content.points ?? [];
  const hasPoints = points.length > 0;
  const hasTitle = !!content.title?.text?.trim() || ctx.interactive;
  const hasCaption = !!content.caption?.text?.trim() || ctx.interactive;

  const top = hasTitle ? TITLE_RESERVE : 56;
  const bottomReserve = hasCaption ? 92 : 48;
  const imgH = 720 - top - bottomReserve;
  const pointsW = hasPoints ? 360 : 0;
  const gap = hasPoints ? 36 : 0;
  const imgW = 1280 - PAD * 2 - pointsW - gap;

  const aiEnvelope = ctx.interactive
    ? {
        "data-ai-component": "slide-visual",
        "data-ai-type": "illustration",
        "data-ai-source": content.source ?? "ai_generated",
        "data-ai-validation-status": "warning",
        "data-ai-actions": "regenerate,replace,edit_caption,edit_alt,remove",
      }
    : {};

  return (
    <div className="absolute inset-0">
      {hasTitle && (
        <EditableText
          value={content.title}
          path={["title"]}
          ctx={ctx}
          placeholder="Slide title"
          className="absolute block [font-family:var(--font-display)]"
          style={{ left: PAD, top: 52, right: PAD, color: ctx.ink, fontSize: 42, fontWeight: 300, lineHeight: 1.1, letterSpacing: "-0.02em" }}
        />
      )}

      {/* The image — a labeled teaching object. */}
      <div
        {...aiEnvelope}
        role="img"
        aria-label={content.alt ? `Illustration: ${content.alt}` : "Illustration"}
        className="absolute"
        style={{
          left: PAD,
          top,
          width: imgW,
          height: imgH,
          borderRadius: 20,
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
            className="flex items-center justify-center font-mono uppercase"
            style={{ width: "100%", height: "100%", color: ctx.muted, fontSize: 13, letterSpacing: "0.12em" }}
          >
            Image pending
          </div>
        )}
      </div>

      {/* Supporting points (turns it into an image + explanation slide). */}
      {hasPoints && (
        <div className="absolute flex flex-col" style={{ left: PAD + imgW + gap, top: top + 8, width: pointsW, gap: 16 }}>
          {points.map((p, i) => (
            <div key={i} className="flex items-start" style={{ gap: 12 }}>
              <span aria-hidden style={{ flex: "0 0 auto", marginTop: 9, width: 8, height: 8, borderRadius: "50%", background: ctx.accent }} />
              <EditableText
                value={p}
                path={["points", i]}
                ctx={ctx}
                placeholder="A key point"
                className="block"
                style={{ color: ctx.ink, fontSize: 18, lineHeight: 1.45 }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Teaching caption — what to notice. */}
      {hasCaption && (
        <div className="absolute flex items-start" style={{ left: PAD, right: PAD, bottom: 40, gap: 12 }}>
          <span aria-hidden style={{ flex: "0 0 auto", marginTop: 9, width: 26, height: 3, borderRadius: 2, background: withAlpha(ctx.accent, 0.7) }} />
          <EditableText
            value={content.caption}
            path={["caption"]}
            ctx={ctx}
            placeholder="What should the learner notice?"
            className="block"
            style={{ color: ctx.body, fontSize: 18, lineHeight: 1.5, maxWidth: 1040 }}
          />
        </div>
      )}
    </div>
  );
}
