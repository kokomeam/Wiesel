/**
 * Shared SVG primitives for the diagram renderers. PURE — no hooks, no store, no
 * Math.random / Date.now — so a diagram renders identically on the server, in a
 * thumbnail's `renderToStaticMarkup`, and in the live canvas (and can later be
 * serialized straight to a PPTX/PDF shape). All sizes are in the slide's logical
 * 1280×720 px space; the stage transform-scales everything.
 */

import type { ReactNode } from "react";

export interface DiagramPalette {
  accent: string;
  ink: string;
  body: string;
  muted: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** rgba() from a #rrggbb color (mirrors structured/common withAlpha). */
export function alpha(color: string, a: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const GRID = "rgba(120,113,108,0.18)";
export const AXIS = "rgba(68,48,28,0.55)";

/** Arrowhead + soft-shadow marker defs, namespaced by `uid` so multiple diagrams
 *  on one page never collide on a global marker id. */
export function DiagramDefs({ uid, accent }: { uid: string; accent: string }) {
  return (
    <defs>
      <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill={AXIS} />
      </marker>
      <marker id={`${uid}-arrow-accent`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill={accent} />
      </marker>
      <marker id={`${uid}-arrow-muted`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="rgba(120,113,108,0.7)" />
      </marker>
    </defs>
  );
}

/** Centered (default) text label. */
export function Label({
  x,
  y,
  children,
  size = 16,
  color = AXIS,
  weight = 400,
  anchor = "middle",
  baseline = "middle",
  mono,
}: {
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  color?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  baseline?: "auto" | "middle" | "hanging" | "central";
  mono?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fontWeight={weight}
      fill={color}
      textAnchor={anchor}
      dominantBaseline={baseline}
      style={{ fontFamily: mono ? "var(--font-geist-mono, monospace)" : "var(--font-geist-sans, system-ui, sans-serif)" }}
    >
      {children}
    </text>
  );
}

/** A pair of axes (origin at the box's bottom-left) with arrowheads + labels.
 *  Used by supply_demand, coordinate_plot, bar_chart. */
export function Axes({
  box,
  uid,
  xLabel,
  yLabel,
  palette,
}: {
  box: Box;
  uid: string;
  xLabel?: string;
  yLabel?: string;
  palette: DiagramPalette;
}) {
  const bottom = box.y + box.h;
  const right = box.x + box.w;
  return (
    <g>
      {/* Y axis */}
      <line x1={box.x} y1={bottom} x2={box.x} y2={box.y - 6} stroke={AXIS} strokeWidth={1.6} markerEnd={`url(#${uid}-arrow)`} />
      {/* X axis */}
      <line x1={box.x} y1={bottom} x2={right + 6} y2={bottom} stroke={AXIS} strokeWidth={1.6} markerEnd={`url(#${uid}-arrow)`} />
      {yLabel && (
        <text
          x={box.x - 30}
          y={box.y + box.h / 2}
          fontSize={16}
          fill={palette.body}
          textAnchor="middle"
          dominantBaseline="middle"
          transform={`rotate(-90 ${box.x - 30} ${box.y + box.h / 2})`}
          style={{ fontFamily: "var(--font-geist-sans, system-ui, sans-serif)" }}
        >
          {yLabel}
        </text>
      )}
      {xLabel && <Label x={box.x + box.w / 2} y={bottom + 34} size={16} color={palette.body}>{xLabel}</Label>}
    </g>
  );
}
