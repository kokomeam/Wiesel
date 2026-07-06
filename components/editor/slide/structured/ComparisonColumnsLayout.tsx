"use client";

/**
 * Comparison · columns (refs: "A vs B" cards + bare-badge variants, 2–3 options).
 * The renderer owns the column arrangement, the per-option color + letter badge
 * (BY INDEX, A/B/C), the "VS." divider (two options only), and reflow. The AI
 * fills each option's name + optional icon + 2–4 points (label + optional
 * detail). `presentation` switches between boxed "cards" and "bare" columns;
 * `decor` (renderer-owned) dials flair. Variable counts/lengths reflow.
 */

import { Fragment } from "react";
import type { ComparisonOption, ComparisonColumnsContent } from "@/lib/course/types";
import { Card, EditableText, IconBadge, withAlpha, type StructuredCtx } from "./common";
import { ComparisonFooterBand, ComparisonHeader, OPTION_LETTERS, optionColor } from "./comparison";

function LetterChip({ index, color }: { index: number; color: string }) {
  return (
    <span
      className="grid place-items-center font-mono font-bold"
      style={{ flex: "0 0 34px", width: 34, height: 34, borderRadius: 10, background: withAlpha(color, 0.14), color, fontSize: 15 }}
    >
      {OPTION_LETTERS[index] ?? index + 1}
    </span>
  );
}

function PointsList({ option, index, ctx, color }: { option: ComparisonOption; index: number; ctx: StructuredCtx; color: string }) {
  return (
    <div className="flex flex-1 flex-col" style={{ gap: 14, minHeight: 0 }}>
      {option.points.map((pt, j) => (
        <div key={j} className="flex" style={{ gap: 10 }}>
          <span
            aria-hidden
            className="grid place-items-center"
            style={{ flex: "0 0 18px", width: 18, height: 18, marginTop: 4, borderRadius: "50%", background: withAlpha(color, 0.16) }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
          </span>
          <div style={{ minWidth: 0 }}>
            <EditableText
              value={pt.label}
              path={["options", index, "points", j, "label"]}
              ctx={ctx}
              placeholder="A point"
              className="block"
              style={{ color: ctx.ink, fontSize: 17, fontWeight: 600, lineHeight: 1.3 }}
            />
            {(ctx.interactive || pt.detail?.text) && (
              <EditableText
                value={pt.detail}
                path={["options", index, "points", j, "detail"]}
                ctx={ctx}
                placeholder="Optional detail"
                className="block"
                style={{ color: ctx.muted, fontSize: 14.5, lineHeight: 1.4, marginTop: 1 }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ColumnView({
  option,
  index,
  ctx,
  bare,
}: {
  option: ComparisonOption;
  index: number;
  ctx: StructuredCtx;
  bare: boolean;
}) {
  const color = optionColor(index, ctx.accent);

  if (bare) {
    return (
      <div className="flex flex-1 flex-col" style={{ minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: 14, marginBottom: 8 }}>
          <span
            className="grid place-items-center font-mono font-bold"
            style={{ flex: "0 0 52px", width: 52, height: 52, borderRadius: "50%", background: color, color: "#ffffff", fontSize: 22 }}
          >
            {OPTION_LETTERS[index] ?? index + 1}
          </span>
          {option.icon && <IconBadge sticker={option.icon} accent={color} size={36} />}
        </div>
        <EditableText
          value={option.name}
          path={["options", index, "name"]}
          ctx={ctx}
          placeholder="Option"
          className="block"
          style={{ color: ctx.ink, fontSize: 25, fontWeight: 700, lineHeight: 1.12, marginBottom: 14 }}
        />
        <span aria-hidden style={{ width: 64, height: 3, borderRadius: 2, background: color, marginBottom: 18 }} />
        <PointsList option={option} index={index} ctx={ctx} color={color} />
      </div>
    );
  }

  return (
    <Card style={{ flex: 1, display: "flex", flexDirection: "column", padding: 0, overflow: "hidden", minWidth: 0, alignSelf: "stretch" }}>
      <div style={{ height: 6, background: color, flex: "0 0 6px" }} aria-hidden />
      <div style={{ padding: 26, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <div className="flex items-center" style={{ gap: 12, marginBottom: 18 }}>
          {option.icon ? <IconBadge sticker={option.icon} accent={color} size={36} /> : <LetterChip index={index} color={color} />}
          <EditableText
            value={option.name}
            path={["options", index, "name"]}
            ctx={ctx}
            placeholder="Option"
            className="block"
            style={{ color: ctx.ink, fontSize: 23, fontWeight: 700, lineHeight: 1.15, minWidth: 0 }}
          />
        </div>
        <PointsList option={option} index={index} ctx={ctx} color={color} />
      </div>
    </Card>
  );
}

function VsDivider({ ctx }: { ctx: StructuredCtx }) {
  return (
    <div className="flex flex-col items-center justify-center" style={{ flex: "0 0 72px" }} aria-hidden>
      <span style={{ width: 1, flex: 1, background: withAlpha(ctx.muted, 0.28) }} />
      <span
        className="grid place-items-center font-mono font-bold"
        style={{
          width: 50,
          height: 50,
          margin: "10px 0",
          borderRadius: "50%",
          background: "#ffffff",
          border: `1px solid ${withAlpha(ctx.muted, 0.28)}`,
          color: ctx.muted,
          fontSize: 15,
          letterSpacing: "0.04em",
        }}
      >
        VS
      </span>
      <span style={{ width: 1, flex: 1, background: withAlpha(ctx.muted, 0.28) }} />
    </div>
  );
}

export function ComparisonColumnsLayout({ content, ctx }: { content: ComparisonColumnsContent; ctx: StructuredCtx }) {
  const bare = (content.presentation ?? "cards") === "bare";
  const options = content.options;
  const twoUp = options.length === 2;
  const footer = content.footer;

  // Flow column: header (auto) → columns (grow + stretch to the taller) → footer
  // (auto). Columns share the available height and grow with content — no clipping.
  return (
    <div className="absolute inset-0 flex flex-col" style={{ padding: "52px 64px 40px" }}>
      <ComparisonHeader eyebrow={content.eyebrow} title={content.title} subtitle={content.subtitle} ctx={ctx} />

      <div className="flex flex-1 items-stretch" style={{ gap: twoUp ? 0 : 26, minHeight: 0 }}>
        {options.map((opt, i) => (
          <Fragment key={i}>
            {twoUp && i === 1 && <VsDivider ctx={ctx} />}
            <ColumnView option={opt} index={i} ctx={ctx} bare={bare} />
          </Fragment>
        ))}
      </div>

      {footer && <ComparisonFooterBand footer={footer} ctx={ctx} />}
    </div>
  );
}
