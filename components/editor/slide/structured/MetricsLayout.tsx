"use client";

/**
 * Metrics-overview layout (cgref3, top row only). Owns the equal-width stat-card
 * row; the delta shows a direction arrow + restrained themed color (accent for
 * positive, a cool tone for negative — never alarm-red). The time-series chart
 * from the reference is deferred to the charts-as-data workstream (not faked).
 */

import { ArrowDown, ArrowUp } from "lucide-react";
import type { MetricsContent } from "@/lib/course/types";
import { Card, EditableText, Eyebrow, IconBadge, type StructuredCtx } from "./common";

const NEGATIVE = "#0284c7"; // cool tone, not alarm-red

export function MetricsLayout({ content, ctx }: { content: MetricsContent; ctx: StructuredCtx }) {
  const metrics = content.metrics;
  // Four cards are narrower — shrink the value + padding so big numbers fit.
  const four = metrics.length >= 4;
  const valueSize = four ? 38 : 48;
  const pad = four ? 22 : 28;
  return (
    <div className="absolute inset-0" style={{ padding: "56px 80px" }}>
      <Eyebrow value={content.eyebrow} path={["eyebrow"]} ctx={ctx} />
      <EditableText
        value={content.title}
        path={["title"]}
        ctx={ctx}
        placeholder="Slide title"
        className="block [font-family:var(--font-display)]"
        style={{ color: ctx.ink, fontSize: 56, fontWeight: 300, lineHeight: 1.05, letterSpacing: "-0.02em", maxWidth: 900 }}
      />

      <div className="absolute flex items-stretch" style={{ left: 80, right: 80, top: 248, bottom: 64, gap: 28 }}>
        {metrics.map((m, i) => {
          const deltaColor =
            m.delta?.sentiment === "positive" ? ctx.accent : m.delta?.sentiment === "negative" ? NEGATIVE : ctx.muted;
          return (
            <Card key={i} style={{ flex: 1, minWidth: 0, padding: pad, display: "flex", flexDirection: "column" }}>
              <IconBadge sticker={m.sticker ?? "bar-chart"} accent={ctx.accent} size={four ? 50 : 58} />
              <EditableText
                value={m.label}
                path={["metrics", i, "label"]}
                ctx={ctx}
                placeholder="Metric label"
                className="block font-mono uppercase"
                style={{ color: ctx.muted, fontSize: 14, fontWeight: 600, letterSpacing: "0.08em", marginTop: 18 }}
              />
              <EditableText
                value={m.value}
                path={["metrics", i, "value"]}
                ctx={ctx}
                placeholder="0"
                className="block"
                style={{ color: ctx.ink, fontSize: valueSize, fontWeight: 700, lineHeight: 1.1, marginTop: 8, letterSpacing: "-0.02em" }}
              />
              {m.delta && (
                <div className="flex items-center" style={{ gap: 6, marginTop: 12 }}>
                  {m.delta.direction === "up" ? (
                    <ArrowUp aria-hidden style={{ width: 18, height: 18, color: deltaColor }} />
                  ) : (
                    <ArrowDown aria-hidden style={{ width: 18, height: 18, color: deltaColor }} />
                  )}
                  <EditableText
                    value={m.delta.text}
                    path={["metrics", i, "delta", "text"]}
                    ctx={ctx}
                    placeholder="vs last period"
                    className="block"
                    style={{ color: deltaColor, fontSize: 15, fontWeight: 600 }}
                  />
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
