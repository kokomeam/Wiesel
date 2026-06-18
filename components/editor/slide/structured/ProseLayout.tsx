"use client";

/**
 * Prose / explainer layout — a deliberate, plan-selectable PLAIN teaching slide
 * (never a fallback): an eyebrow + a display title + a real explanatory body
 * (full sentences) and optional key points. Renderer owns the editorial
 * typography + a readable measure; the AI fills substantive prose.
 */

import type { ProseContent } from "@/lib/course/types";
import { EditableText, Eyebrow, withAlpha, type StructuredCtx } from "./common";

export function ProseLayout({ content, ctx }: { content: ProseContent; ctx: StructuredCtx }) {
  const points = content.points ?? [];
  return (
    <div className="absolute inset-0 flex flex-col" style={{ padding: "56px 80px", overflow: "hidden" }}>
      <Eyebrow value={content.eyebrow} path={["eyebrow"]} ctx={ctx} />
      <EditableText
        value={content.title}
        path={["title"]}
        ctx={ctx}
        placeholder="Slide title"
        className="block [font-family:var(--font-display)]"
        style={{ color: ctx.ink, fontSize: 46, fontWeight: 300, lineHeight: 1.08, letterSpacing: "-0.02em", maxWidth: 1000 }}
      />
      <EditableText
        value={content.body}
        path={["body"]}
        ctx={ctx}
        placeholder="Explain the idea in full sentences — actually teach it."
        className="block"
        style={{ color: ctx.body, fontSize: 23, lineHeight: 1.6, marginTop: 24, maxWidth: 1000 }}
      />
      {points.length > 0 && (
        <div className="flex flex-col" style={{ gap: 10, marginTop: 28, maxWidth: 1000 }}>
          {points.map((p, i) => (
            <div key={i} className="flex items-start" style={{ gap: 12 }}>
              <span
                aria-hidden
                style={{ flex: "0 0 auto", marginTop: 11, width: 8, height: 8, borderRadius: "50%", background: ctx.accent }}
              />
              <EditableText
                value={p}
                path={["points", i]}
                ctx={ctx}
                placeholder="A key takeaway"
                className="block"
                style={{ color: ctx.ink, fontSize: 19, lineHeight: 1.45 }}
              />
            </div>
          ))}
        </div>
      )}
      {/* faint accent rule for editorial weight */}
      <span aria-hidden className="absolute" style={{ left: 80, bottom: 44, width: 90, height: 3, borderRadius: 2, background: withAlpha(ctx.accent, 0.6) }} />
    </div>
  );
}
