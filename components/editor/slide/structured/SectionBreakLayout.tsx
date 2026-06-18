"use client";

/**
 * Section-break layout (refs 1–4 = ONE layout, variant + style flags). A
 * chapter/section transition: a numbered mono kicker, a big two-tone title, a
 * short accent underline, and a one-line framing. The renderer owns ALL flair —
 * the kicker rules, the corner arcs / dot-grid, the giant outline numeral (the
 * `hero_numeral` variant), and the serif two-tone accent on the title's last
 * word. The AI fills number / label / title / subtitle and picks sans/serif +
 * standard/hero_numeral; it can never request or position decoration.
 *
 * `decor` ("full" | "minimal", human-toggled) dials the flair down without
 * breaking the layout. Geometry is logical 1280×720; the stage transform-scales
 * it, so there is no per-viewport reflow.
 */

import type { SectionBreakContent } from "@/lib/course/types";
import { EditableText, twoToneTitle, withAlpha, type StructuredCtx } from "./common";

function CornerArcs({ accent, minimal }: { accent: string; minimal: boolean }) {
  // Concentric arcs radiating from the bottom-right corner (ref 2).
  return (
    <svg
      aria-hidden
      viewBox="0 0 1280 720"
      className="absolute inset-0"
      style={{ width: "100%", height: "100%", pointerEvents: "none" }}
    >
      <circle cx={1280} cy={720} r={300} fill="none" stroke={withAlpha(accent, 0.55)} strokeWidth={2} />
      {!minimal && (
        <>
          <circle
            cx={1280}
            cy={720}
            r={420}
            fill="none"
            stroke={withAlpha(accent, 0.4)}
            strokeWidth={2}
            strokeDasharray="3 9"
          />
          <circle cx={1280} cy={720} r={540} fill="none" stroke={withAlpha(accent, 0.45)} strokeWidth={2} />
        </>
      )}
    </svg>
  );
}

export function SectionBreakLayout({ content, ctx }: { content: SectionBreakContent; ctx: StructuredCtx }) {
  const decor = content.decor ?? "full";
  const minimal = decor === "minimal";
  const variant = content.variant ?? "standard";
  const serif = (content.titleStyle ?? "serif") === "serif";
  const hero = variant === "hero_numeral";
  const number = content.number?.trim();

  const titleNode = serif
    ? twoToneTitle(content.title.text || "Section title", ctx.ink, ctx.accent)
    : undefined;

  return (
    <div className="absolute inset-0">
      <CornerArcs accent={ctx.accent} minimal={minimal} />

      {/* Top-right dot-grid (full decor, standard only — the hero numeral owns that side). */}
      {!minimal && !hero && (
        <div
          aria-hidden
          className="absolute"
          style={{
            right: 80,
            top: 150,
            width: 150,
            height: 96,
            opacity: 0.5,
            backgroundImage: `radial-gradient(${withAlpha(ctx.accent, 0.5)} 1.5px, transparent 1.5px)`,
            backgroundSize: "20px 20px",
          }}
        />
      )}

      {/* Giant outline numeral (hero variant). */}
      {hero && number && (
        <div
          aria-hidden
          className="absolute flex items-center justify-end [font-family:var(--font-display)]"
          style={{ right: 72, top: 40, bottom: 40, width: 560 }}
        >
          <span
            style={{
              fontSize: 460,
              fontWeight: 700,
              lineHeight: 0.8,
              color: "transparent",
              WebkitTextStroke: `2px ${withAlpha(ctx.accent, minimal ? 0.18 : 0.34)}`,
              letterSpacing: "-0.04em",
            }}
          >
            {number}
          </span>
        </div>
      )}

      {/* Kicker */}
      <div className="absolute flex items-center" style={{ left: 80, top: 66, gap: 12 }}>
        {number && (
          <span className="font-mono" style={{ color: ctx.accent, fontSize: 19, fontWeight: 700, letterSpacing: "0.04em" }}>
            {number}
          </span>
        )}
        {number && <span aria-hidden style={{ color: ctx.muted, fontSize: 18 }}>·</span>}
        <EditableText
          value={content.label}
          path={["label"]}
          ctx={ctx}
          placeholder="Section name"
          className="font-mono"
          style={{ color: ctx.ink, fontSize: 18, letterSpacing: "0.02em" }}
        />
      </div>

      {/* Kicker + base rules (full decor, standard variant). */}
      {!minimal && !hero && (
        <>
          <span aria-hidden className="absolute" style={{ left: 80, right: 80, top: 118, height: 1.5, background: withAlpha(ctx.accent, 0.5) }} />
          <span aria-hidden className="absolute" style={{ left: 80, right: 80, bottom: 62, height: 1.5, background: withAlpha(ctx.accent, 0.28) }} />
        </>
      )}

      {/* Centered title block */}
      <div
        className="absolute flex flex-col justify-center"
        style={{ left: 80, right: hero ? 600 : 120, top: 150, bottom: 120, overflow: "hidden" }}
      >
        <EditableText
          value={content.title}
          path={["title"]}
          ctx={ctx}
          placeholder="Section title"
          className={`block ${serif ? "[font-family:var(--font-display)]" : ""}`}
          style={{
            fontSize: serif ? 104 : 88,
            fontWeight: serif ? 400 : 700,
            lineHeight: 1.02,
            letterSpacing: serif ? "-0.015em" : "-0.03em",
            color: ctx.ink,
          }}
        >
          {titleNode}
        </EditableText>

        <span aria-hidden style={{ width: 120, height: 4, borderRadius: 2, background: ctx.accent, margin: "30px 0 0" }} />

        {(ctx.interactive || content.subtitle?.text) && (
          <EditableText
            value={content.subtitle}
            path={["subtitle"]}
            ctx={ctx}
            placeholder="One-line framing"
            className="block"
            style={{ color: ctx.body, fontSize: 24, lineHeight: 1.45, marginTop: 24, maxWidth: 720 }}
          />
        )}
      </div>
    </div>
  );
}
