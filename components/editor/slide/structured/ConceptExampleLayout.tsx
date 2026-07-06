"use client";

/**
 * Concept → example layout (refs 5–6 = ONE layout). Left = an abstract
 * rule/definition; right = a worked example whose body is EITHER numbered steps
 * (ref 5) or prose paragraphs (ref 6) — one discriminated union the AI picks.
 * The renderer owns the two columns, the "in practice" connector (solid for
 * steps, dotted for paragraphs), the badges, the step number badges, and the
 * footnote callout. `decor` ("full" | "minimal") tints/flattens; never AI-set.
 */

import { ArrowRight, Info } from "lucide-react";
import type { ConceptExampleContent } from "@/lib/course/types";
import { Badge, Card, EditableText, withAlpha, type StructuredCtx } from "./common";

export function ConceptExampleLayout({ content, ctx }: { content: ConceptExampleContent; ctx: StructuredCtx }) {
  const decor = content.decor ?? "full";
  const minimal = decor === "minimal";
  const conceptSerif = (content.concept.titleStyle ?? "serif") === "serif";
  const hasFootnote = ctx.interactive || !!content.footnote?.text;
  const body = content.example.body;
  const dotted = body.kind === "paragraphs";

  return (
    <div className="absolute inset-0 flex flex-col" style={{ padding: "64px 80px 44px" }}>
      <div className="flex flex-1 items-stretch" style={{ minHeight: 0, gap: 4 }}>
      {/* ── Left: the concept / rule */}
      <div
        className="flex flex-col justify-center"
        style={{ flex: "1 1 0", minWidth: 0 }}
      >
        {(ctx.interactive || content.concept.badge) && (
          <div style={{ marginBottom: 18 }}>
            <Badge text={content.concept.badge ?? "Concept"} accent={ctx.accent} />
          </div>
        )}
        <EditableText
          value={content.concept.title}
          path={["concept", "title"]}
          ctx={ctx}
          placeholder="The rule or concept"
          className={`block ${conceptSerif ? "[font-family:var(--font-display)]" : ""}`}
          style={{
            color: ctx.ink,
            fontSize: conceptSerif ? 48 : 42,
            fontWeight: conceptSerif ? 400 : 700,
            lineHeight: 1.06,
            letterSpacing: "-0.015em",
          }}
        />
        <span aria-hidden style={{ width: 96, height: 3, borderRadius: 2, background: withAlpha(ctx.accent, 0.7), margin: "20px 0" }} />
        <EditableText
          value={content.concept.definition}
          path={["concept", "definition"]}
          ctx={ctx}
          placeholder="A plain-language definition."
          className="block"
          style={{ color: ctx.body, fontSize: 21, lineHeight: 1.5 }}
        />
      </div>

      {/* ── Connector: "in practice" */}
      <div
        className="flex flex-col items-center justify-center"
        style={{ flex: "0 0 96px", gap: 10 }}
        aria-hidden
      >
        <span
          style={{
            width: 30,
            borderTop: `2px ${dotted ? "dotted" : "solid"} ${withAlpha(ctx.accent, 0.7)}`,
          }}
        />
        <span
          className="grid place-items-center"
          style={{ width: 40, height: 40, borderRadius: "50%", background: withAlpha(ctx.accent, 0.12) }}
        >
          <ArrowRight style={{ width: 20, height: 20, color: ctx.accent }} />
        </span>
        <span
          className="font-mono uppercase text-center"
          style={{ color: ctx.muted, fontSize: 10, letterSpacing: "0.1em", lineHeight: 1.2 }}
        >
          In practice
        </span>
      </div>

      {/* ── Right: the worked example (grows to fit; stretches to match the row) */}
      <Card
        style={{
          flex: "1 1 0",
          minWidth: 0,
          alignSelf: "stretch",
          padding: 28,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: minimal ? "#ffffff" : withAlpha(ctx.accent, 0.04),
        }}
      >
        {(ctx.interactive || content.example.badge) && (
          <div style={{ marginBottom: 12 }}>
            <Badge text={content.example.badge ?? "Worked Example"} accent={ctx.accent} />
          </div>
        )}
        {(ctx.interactive || content.example.title?.text) && (
          <EditableText
            value={content.example.title}
            path={["example", "title"]}
            ctx={ctx}
            placeholder="Example title (optional)"
            className="block"
            style={{ color: ctx.ink, fontSize: 23, fontWeight: 600, lineHeight: 1.2, marginBottom: 16 }}
          />
        )}

        {body.kind === "paragraphs" ? (
          <div className="flex flex-1 flex-col" style={{ gap: 14, minHeight: 0 }}>
            {body.paragraphs.map((p, i) => (
              <EditableText
                key={i}
                value={p}
                path={["example", "body", "paragraphs", i]}
                ctx={ctx}
                placeholder="A paragraph of the example."
                className="block"
                style={{ color: ctx.body, fontSize: 17, lineHeight: 1.5 }}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-1 flex-col justify-center" style={{ gap: 16, minHeight: 0 }}>
            {body.steps.map((step, i) => (
              <div key={i} className="flex items-start" style={{ gap: 14 }}>
                <span
                  className="grid place-items-center font-semibold"
                  style={{ flex: "0 0 30px", width: 30, height: 30, borderRadius: "50%", fontSize: 13, color: ctx.accent, background: withAlpha(ctx.accent, 0.12) }}
                >
                  {i + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <EditableText
                    value={step.heading}
                    path={["example", "body", "steps", i, "heading"]}
                    ctx={ctx}
                    placeholder="Step heading"
                    className="block"
                    style={{ color: ctx.ink, fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}
                  />
                  <EditableText
                    value={step.body}
                    path={["example", "body", "steps", i, "body"]}
                    ctx={ctx}
                    placeholder="One short sentence"
                    className="block"
                    style={{ color: ctx.muted, fontSize: 14.5, lineHeight: 1.4, marginTop: 2 }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      </div>

      {/* ── Footnote callout (flow child at the bottom) */}
      {hasFootnote && (
        <div
          className="flex items-center"
          style={{
            flex: "0 0 auto",
            marginTop: 22,
            gap: 12,
            padding: "12px 18px",
            borderRadius: 14,
            background: minimal ? withAlpha(ctx.muted, 0.08) : withAlpha(ctx.accent, 0.08),
            border: `1px solid ${withAlpha(minimal ? ctx.muted : ctx.accent, 0.2)}`,
          }}
        >
          <Info aria-hidden style={{ width: 18, height: 18, flex: "0 0 18px", color: ctx.accent }} />
          <EditableText
            value={content.footnote}
            path={["footnote"]}
            ctx={ctx}
            placeholder="An optional caveat or 'in practice' note."
            className="block"
            style={{ color: ctx.body, fontSize: 16, lineHeight: 1.4 }}
          />
        </div>
      )}
    </div>
  );
}
