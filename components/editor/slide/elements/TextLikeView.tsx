"use client";

/**
 * PURE display for text / heading / callout / bullet_list elements — the ONE
 * rendering implementation shared by the editor (TextLikeElement's display
 * branch + the auto-grow measurer) and the read-only SlideView path the
 * learner route ships (PERF-1 D1). No stores, no commands, no hooks.
 */

import type { CSSProperties } from "react";
import { resolveElementStyle, verticalAlignCss } from "@/lib/course/slide/styleResolver";
import { findTheme } from "@/lib/course/slide/themes";
import type { CalloutVariant, SlideElement, TextRun } from "@/lib/course/types";

export type TextLike = Extract<
  SlideElement,
  { type: "text" | "heading" | "callout" | "bullet_list" }
>;

export const calloutColors: Record<CalloutVariant, { bg: string; border: string; label: string }> = {
  info: { bg: "#eff6ff", border: "#3b82f6", label: "Info" },
  tip: { bg: "#ecfdf5", border: "#10b981", label: "Tip" },
  warning: { bg: "#fffbeb", border: "#f59e0b", label: "Warning" },
  definition: { bg: "#f5f3ff", border: "#7c3aed", label: "Definition" },
  important: { bg: "#fff1f2", border: "#f43f5e", label: "Important" },
};

export function textLikeValue(el: TextLike): string {
  return el.type === "bullet_list" ? el.items.join("\n") : el.text;
}

/** The element's effective box CSS (shared by display, editor, measurer). */
export function textLikeBoxStyle(el: TextLike, themeId: string): CSSProperties {
  const css = resolveElementStyle(el, themeId);
  const calloutTone = el.type === "callout" ? calloutColors[el.variant] : null;
  return {
    ...css,
    ...verticalAlignCss(el.style),
    width: "100%",
    height: "100%",
    overflow: "hidden",
    ...(calloutTone && {
      backgroundColor: el.style.backgroundColor ?? calloutTone.bg,
      borderLeft: `4px solid ${el.style.borderColor ?? calloutTone.border}`,
      borderRadius: el.style.borderRadius ?? 14,
      padding: el.style.padding ?? 18,
    }),
  };
}

function runStyle(run: TextRun): CSSProperties | undefined {
  const m = run.marks;
  if (!m) return undefined;
  return {
    // tri-state: false explicitly REMOVES the element-level weight/slant
    ...(m.bold !== undefined && { fontWeight: m.bold ? 700 : 400 }),
    ...(m.italic !== undefined && { fontStyle: m.italic ? "italic" : "normal" }),
    ...(m.underline !== undefined && {
      textDecoration: m.underline ? "underline" : "none",
    }),
    ...(m.color && { color: m.color }),
  };
}

/**
 * The display markup, extracted so the auto-grow measurer renders the EXACT
 * same thing (callout label row, bullet gaps/markers, rich runs) as the
 * canvas. `value` overrides the stored content (plain drafts during
 * editing); without it, rich runs render with their marks.
 */
export function TextLikeContent({
  el,
  themeId,
  value,
}: {
  el: TextLike;
  themeId: string;
  value?: string;
}) {
  const calloutTone = el.type === "callout" ? calloutColors[el.variant] : null;
  const runs =
    value === undefined && el.type !== "bullet_list" ? el.runs : undefined;
  const v = value ?? textLikeValue(el);
  const items =
    el.type === "bullet_list"
      ? v.split("\n").filter((line) => line.trim().length > 0)
      : [];
  return (
    <>
      {calloutTone && (
        <p
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            color: calloutTone.border,
            marginBottom: 6,
          }}
        >
          {calloutTone.label}
        </p>
      )}
      {el.type === "bullet_list" ? (
        <ul style={{ display: "flex", flexDirection: "column", gap: "0.45em" }}>
          {items.map((item, i) => (
            <li key={i} style={{ display: "flex", gap: "0.55em", alignItems: "baseline" }}>
              <span
                aria-hidden
                style={{
                  width: "0.32em",
                  height: "0.32em",
                  minWidth: "0.32em",
                  borderRadius: "50%",
                  backgroundColor: findTheme(themeId).accentColor,
                  transform: "translateY(-0.08em)",
                }}
              />
              <span style={{ minWidth: 0 }}>{item}</span>
            </li>
          ))}
        </ul>
      ) : runs && runs.length > 0 ? (
        <span style={{ whiteSpace: "pre-wrap" }}>
          {runs.map((run, i) => (
            <span key={i} style={runStyle(run)}>
              {run.text}
            </span>
          ))}
        </span>
      ) : (
        <span style={{ whiteSpace: "pre-wrap" }}>
          {v || <span style={{ opacity: 0.35 }}>Double-click to edit</span>}
        </span>
      )}
    </>
  );
}

/** The whole element at rest: box + content. The editor's display branch adds
 *  its double-click handler via `onDoubleClick`; read-only paths pass none. */
export function TextLikeDisplay({
  el,
  themeId,
  onDoubleClick,
}: {
  el: TextLike;
  themeId: string;
  onDoubleClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <div style={textLikeBoxStyle(el, themeId)} onDoubleClick={onDoubleClick}>
      <TextLikeContent el={el} themeId={themeId} />
    </div>
  );
}
