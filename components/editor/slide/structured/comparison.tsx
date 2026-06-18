"use client";

/**
 * Shared building blocks for the two comparison layouts (columns + matrix).
 *
 * The renderer owns EVERY decorative decision here — the per-option color and
 * letter badge (assigned strictly BY INDEX, A/B/C, never AI-chosen), the shared
 * header, and the footer tint + icon (a "summary" takeaway is warm + a star; a
 * "similarities" list is cool + a people icon). The AI only fills typed slots.
 */

import { Star, Users } from "lucide-react";
import type { ComparisonFooter, RichText } from "@/lib/course/types";
import { EditableText, Eyebrow, withAlpha, type StructuredCtx } from "./common";

/** Fixed secondary / tertiary hues that read on every theme; option A uses the
 *  live theme accent. Index → color, so colors track POSITION, not content. */
const SECONDARY = "#2563eb"; // blue
const TERTIARY = "#0d9488"; // teal

export function optionColor(index: number, accent: string): string {
  return [accent, SECONDARY, TERTIARY][index] ?? accent;
}

export const OPTION_LETTERS = ["A", "B", "C"] as const;

/** The shared header (eyebrow + serif title + optional subtitle), pinned to the
 *  top of the slide. */
export function ComparisonHeader({
  eyebrow,
  title,
  subtitle,
  ctx,
}: {
  eyebrow: RichText | undefined;
  title: RichText;
  subtitle: RichText | undefined;
  ctx: StructuredCtx;
}) {
  return (
    <div className="absolute" style={{ left: 64, right: 64, top: 52 }}>
      <Eyebrow value={eyebrow} path={["eyebrow"]} ctx={ctx} />
      <EditableText
        value={title}
        path={["title"]}
        ctx={ctx}
        placeholder="Comparison title"
        className="block [font-family:var(--font-display)]"
        style={{ color: ctx.ink, fontSize: 40, fontWeight: 400, lineHeight: 1.08, letterSpacing: "-0.015em" }}
      />
      {(ctx.interactive || subtitle?.text) && (
        <EditableText
          value={subtitle}
          path={["subtitle"]}
          ctx={ctx}
          placeholder="One-line framing (optional)"
          className="block"
          style={{ color: ctx.muted, fontSize: 18, lineHeight: 1.4, marginTop: 8 }}
        />
      )}
    </div>
  );
}

/** The bottom footer band. Rendered only when a footer is present; its icon and
 *  tint are renderer-owned and keyed off `footer.kind`. */
export function ComparisonFooterBand({ footer, ctx }: { footer: ComparisonFooter; ctx: StructuredCtx }) {
  const summary = footer.kind === "summary";
  const tint = summary ? ctx.accent : SECONDARY;
  const Icon = summary ? Star : Users;
  return (
    <div
      className="absolute flex items-center"
      style={{
        left: 64,
        right: 64,
        bottom: 38,
        gap: 14,
        padding: "12px 20px",
        borderRadius: 14,
        background: withAlpha(tint, 0.08),
        border: `1px solid ${withAlpha(tint, 0.22)}`,
      }}
    >
      <span
        className="grid place-items-center"
        style={{ flex: "0 0 32px", width: 32, height: 32, borderRadius: "50%", background: withAlpha(tint, 0.14) }}
      >
        <Icon aria-hidden style={{ width: 18, height: 18, color: tint }} />
      </span>
      {footer.kind === "summary" ? (
        <EditableText
          value={footer.text}
          path={["footer", "text"]}
          ctx={ctx}
          placeholder="A single takeaway."
          className="block"
          style={{ color: ctx.body, fontSize: 17, lineHeight: 1.4 }}
        />
      ) : (
        <div className="flex flex-1 flex-wrap items-center" style={{ gap: "6px 22px" }}>
          <span className="font-mono uppercase" style={{ color: tint, fontSize: 11, letterSpacing: "0.1em" }}>
            In common
          </span>
          {footer.points.map((p, i) => (
            <span key={i} className="flex items-center" style={{ gap: 7, minWidth: 0 }}>
              <span aria-hidden style={{ flex: "0 0 5px", width: 5, height: 5, borderRadius: "50%", background: withAlpha(tint, 0.75) }} />
              <EditableText
                value={p}
                path={["footer", "points", i]}
                ctx={ctx}
                placeholder="Shared trait"
                className="block"
                style={{ color: ctx.body, fontSize: 15, lineHeight: 1.3 }}
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
