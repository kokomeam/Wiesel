"use client";

/**
 * PURE display for the rich list model — the ONE rendering implementation
 * shared by the list editor (ListElementView), the auto-grow measurer, and
 * the read-only SlideView path the learner route ships (PERF-1 D1).
 * No stores, no commands, no hooks, no react-dom/server.
 */

import type { CSSProperties } from "react";
import {
  LIST_INDENT_STEP,
  computeMarkers,
  effectiveMarkerKind,
  listFromElement,
} from "@/lib/course/slide/list";
import { resolveElementStyle, verticalAlignCss } from "@/lib/course/slide/styleResolver";
import { findTheme } from "@/lib/course/slide/themes";
import type { SlideElement, SlideListContent, TextRun } from "@/lib/course/types";

/** Elements that render/edit through the list path: a bullet_list, or a text
 *  box that has had a list toggled inside it. */
export type ListEl = Extract<SlideElement, { type: "bullet_list" | "text" }>;

function runStyle(run: TextRun): CSSProperties | undefined {
  const m = run.marks;
  if (!m) return undefined;
  return {
    ...(m.bold !== undefined && { fontWeight: m.bold ? 700 : 400 }),
    ...(m.italic !== undefined && { fontStyle: m.italic ? "italic" : "normal" }),
    ...(m.underline !== undefined && { textDecoration: m.underline ? "underline" : "none" }),
    ...(m.color && { color: m.color }),
  };
}

export interface RowStyle {
  marginTop: number;
  indent: number;
  marker: string;
  markerColor: string;
  markerStyle: CSSProperties;
  textColor: string;
  fontSize: number;
  lineHeight: number;
}

export function rowStyles(content: SlideListContent, themeId: string, baseColor: string, baseFontSize: number, baseLineHeight: number): RowStyle[] {
  const accent = findTheme(themeId).accentColor;
  const markers = computeMarkers(content);
  return content.items.map((item, i) => {
    const ls = content.levelStyles?.[item.level];
    const kind = effectiveMarkerKind(content, item);
    const numbered = kind === "number" || kind === "alpha" || kind === "roman" || item.markerText !== undefined;
    const prev = content.items[i - 1];
    const marginTop =
      i === 0
        ? 0
        : content.paragraphSpacing !== undefined
          ? content.paragraphSpacing
          : item.level > prev.level
            ? 4
            : item.level === 0
              ? 12
              : 7;
    const fontSize = ls?.fontSize ?? baseFontSize;
    return {
      marginTop,
      indent: item.level * LIST_INDENT_STEP + (ls?.indent ?? 0),
      marker: markers[i],
      markerColor: item.markerColor ?? ls?.markerColor ?? content.markerColor ?? accent,
      markerStyle: {
        fontFamily: numbered ? "var(--font-geist-mono), ui-monospace, monospace" : undefined,
        fontWeight: item.markerText !== undefined ? 700 : numbered ? 600 : 400,
        minWidth: numbered ? `${Math.round(fontSize * 1.7)}px` : `${Math.round(fontSize * 0.9)}px`,
      },
      textColor: item.textColor ?? ls?.textColor ?? content.textColor ?? baseColor,
      fontSize,
      lineHeight: ls?.lineHeight ?? baseLineHeight,
    };
  });
}

/** PURE display (SSR-safe — no hooks). The measurer renders this too. */
export function ListContent({ el, themeId }: { el: ListEl; themeId: string }) {
  const content = listFromElement(el);
  const css = resolveElementStyle(el, themeId);
  const baseColor = (css.color as string) ?? "#000";
  const baseFontSize = (css.fontSize as number) ?? 22;
  const baseLineHeight = (css.lineHeight as number) ?? 1.45;
  const styles = rowStyles(content, themeId, baseColor, baseFontSize, baseLineHeight);

  return (
    <ul style={{ display: "block", fontFamily: css.fontFamily as string }}>
      {content.items.map((item, i) => {
        const r = styles[i];
        return (
          <li key={item.id} style={{ display: "flex", gap: "0.5em", marginTop: r.marginTop, marginLeft: r.indent, fontSize: r.fontSize, lineHeight: r.lineHeight, alignItems: "baseline" }}>
            {r.marker !== "" && (
              <span aria-hidden style={{ flex: "0 0 auto", color: r.markerColor, ...r.markerStyle }}>
                {r.marker}
              </span>
            )}
            <span style={{ minWidth: 0, flex: 1, color: r.textColor, whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>
              {item.runs && item.runs.length > 0
                ? item.runs.map((run, k) => (
                    <span key={k} style={runStyle(run)}>
                      {run.text}
                    </span>
                  ))
                : item.text || "​"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The whole list element at rest: box + rows. The editor's display branch adds
 *  its double-click handler via `onDoubleClick`; read-only paths pass none. */
export function ListDisplay({
  el,
  themeId,
  onDoubleClick,
}: {
  el: ListEl;
  themeId: string;
  onDoubleClick?: (e: React.MouseEvent) => void;
}) {
  const css = resolveElementStyle(el, themeId);
  return (
    <div
      style={{ width: "100%", height: "100%", overflow: "hidden", ...css, ...verticalAlignCss(el.style) }}
      onDoubleClick={onDoubleClick}
    >
      <ListContent el={el} themeId={themeId} />
    </div>
  );
}
