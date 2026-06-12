"use client";

/**
 * Shape, divider, and (read-only) table renderers.
 */

import type { CSSProperties } from "react";
import { findTheme } from "@/lib/course/slide/themes";
import type { SlideElement } from "@/lib/course/types";

type ShapeEl = Extract<SlideElement, { type: "shape" }>;
type DividerEl = Extract<SlideElement, { type: "divider" }>;
type TableEl = Extract<SlideElement, { type: "table" }>;

const DASH: Record<string, string | undefined> = {
  solid: undefined,
  dashed: "10 8",
  dotted: "2 7",
};

export function ShapeElementView({ el, themeId }: { el: ShapeEl; themeId: string }) {
  const theme = findTheme(themeId);
  const fill = el.style.backgroundColor ?? theme.colors.surface;
  const stroke = el.style.borderColor ?? theme.accentColor;
  const strokeW = el.style.borderWidth ?? 0;
  const dash = DASH[el.style.borderStyle ?? "solid"];
  const common: CSSProperties = { opacity: el.style.opacity };

  switch (el.shape) {
    case "rectangle":
      return (
        <div
          className="h-full w-full"
          style={{
            ...common,
            backgroundColor: fill,
            borderRadius: el.style.borderRadius ?? 16,
            ...(strokeW > 0 && {
              border: `${strokeW}px ${el.style.borderStyle ?? "solid"} ${stroke}`,
            }),
          }}
        />
      );
    case "ellipse":
      return (
        <div
          className="h-full w-full"
          style={{
            ...common,
            backgroundColor: fill,
            borderRadius: "50%",
            ...(strokeW > 0 && {
              border: `${strokeW}px ${el.style.borderStyle ?? "solid"} ${stroke}`,
            }),
          }}
        />
      );
    case "triangle":
      return (
        <svg
          className="h-full w-full"
          style={common}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <polygon
            points="50,3 97,97 3,97"
            fill={fill}
            stroke={strokeW > 0 ? stroke : undefined}
            strokeWidth={strokeW > 0 ? strokeW : undefined}
            strokeDasharray={strokeW > 0 ? dash : undefined}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      );
    case "line":
    case "arrow": {
      // 2-point geometry: endpoints are frame fractions; the viewBox matches
      // the logical frame so diagonals render undistorted at any aspect.
      const p = el.points ?? { x1: 0, y1: 0.5, x2: 1, y2: 0.5 };
      const w = Math.max(1, el.width);
      const h = Math.max(1, el.height);
      const sw = Math.max(2, strokeW || (el.shape === "arrow" ? 4 : 2));
      const markerId = `arrowhead-${el.id}`;
      return (
        <svg className="h-full w-full" style={common} viewBox={`0 0 ${w} ${h}`}>
          {el.shape === "arrow" && (
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth={4}
                markerHeight={4}
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
              </marker>
            </defs>
          )}
          <line
            x1={p.x1 * w}
            y1={p.y1 * h}
            x2={p.x2 * w}
            y2={p.y2 * h}
            stroke={stroke}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={dash}
            markerEnd={el.shape === "arrow" ? `url(#${markerId})` : undefined}
          />
        </svg>
      );
    }
  }
}

export function DividerElementView({ el, themeId }: { el: DividerEl; themeId: string }) {
  const color = el.style.backgroundColor ?? findTheme(themeId).colors.muted;
  return (
    <div className="flex h-full w-full items-center justify-center" style={{ opacity: el.style.opacity }}>
      <div
        style={{
          backgroundColor: color,
          borderRadius: el.style.borderRadius ?? 2,
          ...(el.orientation === "horizontal"
            ? { width: "100%", height: Math.min(6, el.height) }
            : { height: "100%", width: Math.min(6, el.width) }),
        }}
      />
    </div>
  );
}

/** Tables render but aren't editable in this version — edit via AI patches
 *  (UPDATE_SLIDE_ELEMENT rows) or the AI Structure JSON for now. */
export function TableElementView({ el, themeId }: { el: TableEl; themeId: string }) {
  const theme = findTheme(themeId);
  const fontSize = el.style.fontSize ?? 18;
  return (
    <div
      className="h-full w-full overflow-hidden"
      style={{ borderRadius: el.style.borderRadius ?? 12, opacity: el.style.opacity }}
    >
      <table
        className="h-full w-full border-collapse"
        style={{ fontSize, color: el.style.color ?? theme.colors.body }}
      >
        <tbody>
          {el.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  style={{
                    border: `1px solid ${theme.colors.muted}40`,
                    padding: "0.4em 0.7em",
                    ...(el.headerRow && r === 0
                      ? {
                          fontWeight: 600,
                          backgroundColor: theme.colors.surface,
                          color: theme.colors.heading,
                        }
                      : {}),
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
