"use client";

/**
 * Outline / objectives layout (ref 7). A titled nested list that serves both a
 * lesson's objectives and a module table of contents. The renderer owns the top
 * accent bar, the rule under the title, the number markers, the two-tone
 * main-vs-sub coloring, the indentation, and the count-based reflow (2–5 items,
 * each with 0–2 sub-points). The AI fills only the title + nested {text,
 * subItems?} slots. `decor` ("full" | "minimal") is renderer-owned, never AI-set.
 */

import type { OutlineListContent } from "@/lib/course/types";
import { EditableText, withAlpha, type StructuredCtx } from "./common";

const REGION_TOP = 208;
const REGION_BOTTOM = 48;

export function OutlineListLayout({ content, ctx }: { content: OutlineListContent; ctx: StructuredCtx }) {
  const decor = content.decor ?? "full";
  const minimal = decor === "minimal";
  const items = content.items;
  const n = Math.max(1, items.length);
  const region = 720 - REGION_TOP - REGION_BOTTOM;
  const rowH = region / n;

  // Scale type to the item count so 5 items × 2 sub-points stays within its row.
  const itemFont = n <= 3 ? 30 : n === 4 ? 26 : 22;
  const subFont = n <= 3 ? 18 : 16;
  const markerFont = Math.round(itemFont * 0.72);

  return (
    <div className="absolute inset-0">
      {/* Top accent bar */}
      <span aria-hidden className="absolute" style={{ left: 80, top: 64, width: 64, height: 6, borderRadius: 3, background: ctx.accent }} />

      {/* Faint corner dot-grid (full decor only) */}
      {!minimal && (
        <div
          aria-hidden
          className="absolute"
          style={{
            right: 72,
            top: 72,
            width: 150,
            height: 90,
            opacity: 0.45,
            backgroundImage: `radial-gradient(${withAlpha(ctx.accent, 0.5)} 1.5px, transparent 1.5px)`,
            backgroundSize: "20px 20px",
          }}
        />
      )}

      {/* Title */}
      <div className="absolute" style={{ left: 80, right: 240, top: 92 }}>
        <EditableText
          value={content.title}
          path={["title"]}
          ctx={ctx}
          placeholder="List title"
          className="block [font-family:var(--font-display)]"
          style={{ color: ctx.ink, fontSize: 44, fontWeight: 400, lineHeight: 1.06, letterSpacing: "-0.015em" }}
        />
      </div>

      {/* Rule under the title (full decor only) */}
      {!minimal && (
        <span aria-hidden className="absolute" style={{ left: 80, right: 80, top: 184, height: 1.5, background: withAlpha(ctx.accent, 0.35) }} />
      )}

      {/* Items */}
      {items.map((item, i) => {
        const subs = item.subItems ?? [];
        return (
          <div
            key={i}
            className="absolute flex items-start"
            style={{ left: 80, right: 80, top: REGION_TOP + i * rowH, height: rowH, gap: 18, overflow: "hidden" }}
          >
            <span
              className="font-mono"
              style={{ flex: "0 0 auto", color: ctx.accent, fontSize: markerFont, fontWeight: 700, lineHeight: 1.15, minWidth: markerFont * 1.6 }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <EditableText
                value={item.text}
                path={["items", i, "text"]}
                ctx={ctx}
                placeholder="Outline item"
                className="block"
                style={{ color: ctx.ink, fontSize: itemFont, fontWeight: 600, lineHeight: 1.2 }}
              />
              {subs.length > 0 && (
                <div className="flex flex-col" style={{ gap: 4, marginTop: 6 }}>
                  {subs.map((sub, j) => (
                    <div key={j} className="flex items-start" style={{ gap: 10 }}>
                      <span aria-hidden style={{ flex: "0 0 auto", color: withAlpha(ctx.accent, 0.7), fontSize: subFont, lineHeight: 1.3 }}>
                        —
                      </span>
                      <EditableText
                        value={sub}
                        path={["items", i, "subItems", j]}
                        ctx={ctx}
                        placeholder="Sub-point"
                        className="block"
                        style={{ color: ctx.muted, fontSize: subFont, lineHeight: 1.3 }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
