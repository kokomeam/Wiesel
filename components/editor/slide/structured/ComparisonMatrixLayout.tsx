"use client";

/**
 * Comparison · matrix (refs: 2–3 options compared across shared dimensions).
 * Options are the COLUMNS, dimensions the ROWS. The renderer owns the grid, the
 * per-option color header (BY INDEX, A/B/C), row striping, borders, and the
 * footer. The AI fills each option (name + optional icon), each dimension (label
 * + optional icon), and one cell per option (detail + optional example).
 *
 * The renderer maps the body cells over OPTIONS (reading dim.cells[c]) so a
 * mismatched/short cells array reflows into blanks rather than breaking the grid
 * — the strict AI schema already pins one cell per option.
 */

import { Fragment } from "react";
import type { ComparisonMatrixContent } from "@/lib/course/types";
import { EditableText, IconBadge, withAlpha, type StructuredCtx } from "./common";
import { ComparisonFooterBand, ComparisonHeader, optionColor } from "./comparison";

export function ComparisonMatrixLayout({ content, ctx }: { content: ComparisonMatrixContent; ctx: StructuredCtx }) {
  const { options, dimensions } = content;
  const n = options.length;
  const footer = content.footer;
  const bodyBottom = footer ? 116 : 52;
  const hairline = withAlpha(ctx.muted, 0.18);

  return (
    <div className="absolute inset-0">
      <ComparisonHeader eyebrow={content.eyebrow} title={content.title} subtitle={content.subtitle} ctx={ctx} />

      <div
        className="absolute"
        style={{ left: 64, right: 64, top: content.subtitle?.text || ctx.interactive ? 214 : 184, bottom: bodyBottom }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `minmax(150px, 230px) repeat(${n}, minmax(0, 1fr))`,
            gridTemplateRows: `auto repeat(${dimensions.length}, minmax(0, 1fr))`,
            height: "100%",
            borderRadius: 18,
            overflow: "hidden",
            border: `1px solid ${hairline}`,
            background: "#ffffff",
          }}
        >
          {/* corner */}
          <div style={{ background: withAlpha(ctx.muted, 0.04) }} aria-hidden />
          {/* option headers */}
          {options.map((opt, i) => {
            const color = optionColor(i, ctx.accent);
            return (
              <div
                key={i}
                className="flex items-center justify-center"
                style={{ gap: 9, padding: "14px 16px", background: withAlpha(color, 0.12), borderLeft: `1px solid ${hairline}`, borderBottom: `2px solid ${color}` }}
              >
                {opt.icon && <IconBadge sticker={opt.icon} accent={color} size={26} />}
                <EditableText
                  value={opt.name}
                  path={["options", i, "name"]}
                  ctx={ctx}
                  placeholder="Option"
                  className="block text-center"
                  style={{ color: ctx.ink, fontSize: 18, fontWeight: 700, lineHeight: 1.15, minWidth: 0 }}
                />
              </div>
            );
          })}

          {/* dimension rows */}
          {dimensions.map((dim, r) => (
            <Fragment key={r}>
              <div
                className="flex items-center"
                style={{ gap: 9, padding: "12px 16px", background: withAlpha(ctx.muted, 0.05), borderTop: `1px solid ${hairline}` }}
              >
                {dim.icon && <IconBadge sticker={dim.icon} accent={ctx.accent} size={24} />}
                <EditableText
                  value={dim.label}
                  path={["dimensions", r, "label"]}
                  ctx={ctx}
                  placeholder="Dimension"
                  className="block"
                  style={{ color: ctx.ink, fontSize: 15.5, fontWeight: 600, lineHeight: 1.2, minWidth: 0 }}
                />
              </div>
              {options.map((_, c) => {
                const cell = dim.cells[c];
                return (
                  <div
                    key={c}
                    className="flex flex-col justify-center"
                    style={{ padding: "12px 16px", borderTop: `1px solid ${hairline}`, borderLeft: `1px solid ${hairline}`, background: r % 2 ? withAlpha(ctx.muted, 0.03) : "#ffffff", minWidth: 0 }}
                  >
                    <EditableText
                      value={cell?.detail}
                      path={["dimensions", r, "cells", c, "detail"]}
                      ctx={ctx}
                      placeholder="…"
                      className="block"
                      style={{ color: ctx.body, fontSize: 15.5, lineHeight: 1.35 }}
                    />
                    {(ctx.interactive || cell?.example?.text) && (
                      <EditableText
                        value={cell?.example}
                        path={["dimensions", r, "cells", c, "example"]}
                        ctx={ctx}
                        placeholder="Optional example"
                        className="block"
                        style={{ color: ctx.muted, fontSize: 13, fontStyle: "italic", lineHeight: 1.3, marginTop: 3 }}
                      />
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {footer && <ComparisonFooterBand footer={footer} ctx={ctx} />}
    </div>
  );
}
