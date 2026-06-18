"use client";

/**
 * Code-walkthrough layout (cgref5): a Shiki-highlighted code card beside
 * numbered explanation cards. No leader lines — steps reference lines in text.
 * Highlighting is deterministic (lib/course/slide/highlight.ts); plain text
 * shows until it resolves.
 */

import { useEffect, useState } from "react";
import { highlightCode } from "@/lib/course/slide/highlight";
import type { CodeWalkthroughContent } from "@/lib/course/types";
import { EditableText, Eyebrow, IconBadge, withAlpha, type StructuredCtx } from "./common";

const CARD_BG = "#0d1117";

function useHighlighted(code: string, lang: string): string | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void highlightCode(code, lang).then((h) => {
      if (alive) setHtml(h);
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return html;
}

export function CodeWalkthroughLayout({ content, ctx }: { content: CodeWalkthroughContent; ctx: StructuredCtx }) {
  const html = useHighlighted(content.code.code, content.code.language);
  const steps = content.steps;

  return (
    <div className="absolute inset-0" style={{ padding: "52px 80px" }}>
      <Eyebrow value={content.eyebrow} path={["eyebrow"]} ctx={ctx} />
      <EditableText
        value={content.title}
        path={["title"]}
        ctx={ctx}
        placeholder="Slide title"
        className="block [font-family:var(--font-display)]"
        style={{ color: ctx.ink, fontSize: 48, fontWeight: 300, lineHeight: 1.08, letterSpacing: "-0.02em", maxWidth: 720 }}
      />

      {/* Code card */}
      <div
        className="absolute flex flex-col overflow-hidden"
        style={{ left: 80, top: 210, width: 632, bottom: 48, borderRadius: 16, background: CARD_BG, boxShadow: "0 10px 30px rgba(13,17,23,0.25)" }}
      >
        <div className="flex items-center" style={{ gap: 7, padding: "14px 18px" }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f56" }} />
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ffbd2e" }} />
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#27c93f" }} />
        </div>
        <div
          className="flex-1 overflow-hidden [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
          style={{ padding: "4px 22px 22px", fontSize: 17, lineHeight: 1.55, fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}
        >
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre style={{ margin: 0, color: "#c9d1d9", whiteSpace: "pre-wrap" }}>{content.code.code}</pre>
          )}
        </div>
      </div>

      {/* Explanation steps */}
      <div
        className="absolute flex flex-col justify-center"
        style={{ left: 748, right: 80, top: 210, bottom: 48, gap: 18 }}
      >
        {steps.map((step, i) => (
          <div key={i} className="flex items-start" style={{ gap: 16 }}>
            <span
              className="grid place-items-center font-semibold"
              style={{ flex: "0 0 34px", width: 34, height: 34, borderRadius: "50%", fontSize: 14, color: ctx.accent, background: withAlpha(ctx.accent, 0.12) }}
            >
              {i + 1}
            </span>
            <span style={{ flex: "0 0 40px", height: 40 }}>
              <IconBadge sticker={step.sticker ?? "lightbulb"} accent={ctx.accent} size={40} />
            </span>
            <div style={{ minWidth: 0, paddingTop: 2 }}>
              <EditableText
                value={step.heading}
                path={["steps", i, "heading"]}
                ctx={ctx}
                placeholder="Step heading"
                className="block"
                style={{ color: ctx.ink, fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}
              />
              <EditableText
                value={step.body}
                path={["steps", i, "body"]}
                ctx={ctx}
                placeholder="Reference a line, e.g. 'Line 1: …'"
                className="block"
                style={{ color: ctx.muted, fontSize: 16, lineHeight: 1.45, marginTop: 4 }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
