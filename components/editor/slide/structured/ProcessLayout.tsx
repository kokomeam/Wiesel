"use client";

/**
 * Process / numbered-steps layout (cgref1). Owns the equal-width card row +
 * straight arrows + auto-numbering; reflows for 3–5 steps. The AI/human only
 * fill eyebrow/title/subtitle + the steps[] slots.
 */

import { ArrowRight } from "lucide-react";
import type { ProcessContent } from "@/lib/course/types";
import { Card, EditableText, Eyebrow, IconBadge, withAlpha, type StructuredCtx } from "./common";

export function ProcessLayout({ content, ctx }: { content: ProcessContent; ctx: StructuredCtx }) {
  const steps = content.steps;
  return (
    <div className="absolute inset-0" style={{ padding: "56px 80px" }}>
      {/* Header */}
      <Eyebrow value={content.eyebrow} path={["eyebrow"]} ctx={ctx} />
      <EditableText
        value={content.title}
        path={["title"]}
        ctx={ctx}
        placeholder="Slide title"
        className="block [font-family:var(--font-display)]"
        style={{ color: ctx.ink, fontSize: 60, fontWeight: 300, lineHeight: 1.04, letterSpacing: "-0.02em", maxWidth: 760 }}
      />
      {(ctx.interactive || content.subtitle?.text) && (
        <EditableText
          value={content.subtitle}
          path={["subtitle"]}
          ctx={ctx}
          placeholder="One-line framing"
          className="block"
          style={{ color: ctx.muted, fontSize: 22, lineHeight: 1.4, marginTop: 16, maxWidth: 620 }}
        />
      )}

      {/* Step cards + arrows */}
      <div
        className="absolute flex items-stretch"
        style={{ left: 80, right: 80, top: 392, bottom: 48, gap: 0 }}
      >
        {steps.map((step, i) => (
          <div key={i} className="flex flex-1 items-stretch" style={{ minWidth: 0 }}>
            <Card style={{ flex: 1, minWidth: 0, padding: 22, display: "flex", flexDirection: "column" }}>
              <div className="flex items-center justify-between">
                <span
                  className="grid place-items-center font-semibold text-white"
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    fontSize: 15,
                    background: `linear-gradient(135deg, ${withAlpha(ctx.accent, 0.92)}, ${ctx.accent})`,
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <IconBadge sticker={step.sticker} accent={ctx.accent} size={40} circle={false} />
              </div>
              <EditableText
                value={step.heading}
                path={["steps", i, "heading"]}
                ctx={ctx}
                placeholder="Step heading"
                className="block"
                style={{ color: ctx.ink, fontSize: 21, fontWeight: 600, lineHeight: 1.2, marginTop: 20 }}
              />
              <span aria-hidden style={{ width: 30, height: 3, borderRadius: 2, background: ctx.accent, margin: "10px 0 12px" }} />
              <EditableText
                value={step.body}
                path={["steps", i, "body"]}
                ctx={ctx}
                placeholder="One supporting sentence"
                className="block"
                style={{ color: ctx.muted, fontSize: 16, lineHeight: 1.45, overflow: "hidden" }}
              />
            </Card>
            {i < steps.length - 1 && (
              <span className="flex items-center justify-center" style={{ width: 40, flex: "0 0 40px" }}>
                <ArrowRight aria-hidden style={{ width: 22, height: 22, color: withAlpha(ctx.accent, 0.85) }} />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
