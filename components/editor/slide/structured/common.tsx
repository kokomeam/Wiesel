"use client";

/**
 * Shared building blocks for the renderer-owned structured layouts. The
 * components own ALL arrangement; the AI/human only fill typed slots. Text is
 * edited IN PLACE here (contentEditable on a slot, commit-on-blur via
 * UPDATE_TEMPLATE_CONTENT) and structurally via the inspector. Coordinates are
 * logical 1280×720 px — the stage transform-scales everything.
 */

import type { CSSProperties, ReactNode } from "react";
import { updateTemplateContentPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { RichText } from "@/lib/course/types";
import {
  BADGE,
  CARD,
  EYEBROW,
  badgeBg,
  badgeBorder,
  withAlpha,
} from "@/lib/course/slide/structured/styleConstants";
import { StickerGlyph } from "../elements/StickerElement";

export interface StructuredCtx {
  blockId: string;
  slideId: string;
  interactive: boolean;
  accent: string;
  ink: string;
  body: string;
  muted: string;
}

/** Re-exported from the shared style constants so the many `./common` imports
 *  keep working while the materializer + renderer share one definition. */
export { withAlpha };

/** A single editable text slot. `path` is relative to template.content (this
 *  appends "text"). Read-only in thumbnails; commit-on-blur otherwise. Pass
 *  `children` to render styled inner content (e.g. a renderer-owned two-tone
 *  title): editing still commits the element's plain `textContent`. */
export function EditableText({
  value,
  path,
  ctx,
  className,
  style,
  placeholder,
  children,
}: {
  value: RichText | undefined;
  path: (string | number)[];
  ctx: StructuredCtx;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  children?: ReactNode;
}) {
  const apply = useEditorStore((s) => s.apply);
  const text = value?.text ?? "";

  // Break long words so a stray no-space string can never overflow its card.
  const safe: CSSProperties = { overflowWrap: "break-word", wordBreak: "break-word", ...style };

  if (!ctx.interactive) {
    return (
      <span className={className} style={safe}>
        {children ?? (text || placeholder || "")}
      </span>
    );
  }
  return (
    <span
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      data-ai-tool="edit-template-text"
      data-ai-action="UPDATE_TEMPLATE_CONTENT"
      spellCheck={false}
      className={className}
      style={{ outline: "none", cursor: "text", ...safe }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
      }}
      onBlur={(e) => {
        const next = (e.currentTarget.textContent ?? "").trim();
        if (next !== text) {
          // Manual edit resets emphasis runs to plain text (like bullets).
          apply(updateTemplateContentPatch(ctx.blockId, ctx.slideId, [...path, "text"], next), "human");
          apply(updateTemplateContentPatch(ctx.blockId, ctx.slideId, [...path, "runs"], undefined), "human");
        }
      }}
    >
      {children ?? text}
    </span>
  );
}

/** Split a title into ink + accent spans (renderer-owned two-tone). The accent
 *  falls on the LAST word; concatenation is byte-identical to the source so the
 *  editable's `textContent` commits unchanged. Single-word titles stay one tone. */
export function twoToneTitle(text: string, ink: string, accent: string): ReactNode {
  const idx = text.trimEnd().lastIndexOf(" ");
  if (idx <= 0) return <span style={{ color: ink }}>{text}</span>;
  return (
    <>
      <span style={{ color: ink }}>{text.slice(0, idx)}</span>
      <span style={{ color: accent }}>{text.slice(idx)}</span>
    </>
  );
}

/** A small uppercase pill badge (the "Rule" / "Worked Example" treatment). */
export function Badge({ text, accent }: { text: string; accent: string }) {
  if (!text) return null;
  return (
    <span
      className="inline-block font-mono uppercase"
      style={{
        color: accent,
        background: badgeBg(accent),
        border: `1px solid ${badgeBorder(accent)}`,
        borderRadius: BADGE.radius,
        padding: "4px 12px",
        fontSize: BADGE.fontSize,
        fontWeight: BADGE.weight,
        letterSpacing: `${BADGE.letterSpacingEm}em`,
      }}
    >
      {text}
    </span>
  );
}

/** Mono uppercase kicker with a short accent rule (the recurring eyebrow). */
export function Eyebrow({
  value,
  path,
  ctx,
  rule = true,
}: {
  value: RichText | undefined;
  path: (string | number)[];
  ctx: StructuredCtx;
  rule?: boolean;
}) {
  if (!ctx.interactive && !value?.text) return null;
  return (
    <div className="flex items-center gap-3" style={{ marginBottom: EYEBROW.marginBottom }}>
      <EditableText
        value={value}
        path={path}
        ctx={ctx}
        placeholder="Eyebrow"
        className="font-mono uppercase"
        style={{ color: ctx.accent, fontSize: EYEBROW.fontSize, fontWeight: EYEBROW.weight, letterSpacing: `${EYEBROW.letterSpacingEm}em` }}
      />
      {rule && <span aria-hidden style={{ width: EYEBROW.ruleW, height: EYEBROW.ruleH, background: ctx.accent, opacity: EYEBROW.ruleOpacity }} />}
    </div>
  );
}

/** The icon-in-tinted-circle treatment shared across the layouts. */
export function IconBadge({
  sticker,
  accent,
  size,
  circle = true,
}: {
  sticker: string | undefined;
  accent: string;
  size: number;
  circle?: boolean;
}) {
  if (!sticker) return null;
  return (
    <span style={{ display: "block", width: size, height: size }}>
      <StickerGlyph id={sticker} accent={accent} circleColor={circle ? withAlpha(accent, 0.12) : null} iconRatio={circle ? 0.52 : 0.9} />
    </span>
  );
}

/** A white card with the warm whisper border/shadow used by the references. */
export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: CARD.bg,
        border: `${CARD.borderWidth}px solid ${CARD.border}`,
        borderRadius: CARD.radius,
        boxShadow: CARD.shadow,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
