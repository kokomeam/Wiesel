"use client";

/**
 * Key-concept / definition layout (cgref2 serif + cgref4 sans — ONE layout,
 * variant flags). Left = term + definition; right = icon points. Owns the
 * arrangement; the optional `spine` draws a thin connector line + node dots
 * only (no layered chevrons). Right items are absolutely placed from the count
 * so the spine lands exactly on the icon centers and reflows for 2–4 items.
 */

import type { KeyConceptContent } from "@/lib/course/types";
import { EditableText, Eyebrow, IconBadge, withAlpha, type StructuredCtx } from "./common";

const RIGHT_X = 704;
const ICON = 64;
const REGION_TOP = 150;
const REGION_BOTTOM = 632;

export function KeyConceptLayout({ content, ctx }: { content: KeyConceptContent; ctx: StructuredCtx }) {
  const serif = content.variant === "serif";
  const items = content.items;
  const n = items.length;
  const region = REGION_BOTTOM - REGION_TOP;
  const rowH = region / Math.max(1, n);
  const centerY = (i: number) => REGION_TOP + (i + 0.5) * rowH;
  const spineX = RIGHT_X + ICON / 2;

  return (
    <div className="absolute inset-0">
      {/* Left: term + definition */}
      <div className="absolute" style={{ left: 80, top: 128, width: 560 }}>
        <Eyebrow value={content.eyebrow} path={["eyebrow"]} ctx={ctx} />
        <EditableText
          value={content.term}
          path={["term"]}
          ctx={ctx}
          placeholder="Term"
          className={`block ${serif ? "[font-family:var(--font-display)]" : ""}`}
          style={{
            color: ctx.ink,
            fontSize: serif ? 84 : 76,
            fontWeight: serif ? 400 : 700,
            lineHeight: 1.0,
            letterSpacing: serif ? "-0.01em" : "-0.03em",
          }}
        />
        <div aria-hidden style={{ width: 220, height: 2, background: withAlpha(ctx.accent, 0.5), margin: "28px 0" }} />
        <EditableText
          value={content.definition}
          path={["definition"]}
          ctx={ctx}
          placeholder="A plain-language definition."
          className="block"
          style={{ color: ctx.body, fontSize: 22, lineHeight: 1.5 }}
        />
      </div>

      {/* Right: connector spine (optional) */}
      {content.spine && n > 1 && (
        <div aria-hidden>
          <div
            className="absolute"
            style={{ left: spineX, top: centerY(0), width: 2, height: centerY(n - 1) - centerY(0), background: withAlpha(ctx.accent, 0.35) }}
          />
          {items.map((_, i) => (
            <div
              key={i}
              className="absolute"
              style={{ left: spineX - 4, top: centerY(i) - 4, width: 8, height: 8, borderRadius: "50%", background: ctx.accent }}
            />
          ))}
        </div>
      )}

      {/* Right: icon points */}
      {items.map((item, i) => (
        <div
          key={i}
          className="absolute flex items-start"
          style={{ left: RIGHT_X, top: centerY(i) - ICON / 2, width: 1208 - RIGHT_X, gap: 22 }}
        >
          <span style={{ flex: `0 0 ${ICON}px`, height: ICON }}>
            <IconBadge sticker={item.sticker ?? "lightbulb"} accent={ctx.accent} size={ICON} />
          </span>
          <div style={{ minWidth: 0, paddingTop: 4 }}>
            <EditableText
              value={item.heading}
              path={["items", i, "heading"]}
              ctx={ctx}
              placeholder="Point heading"
              className="block"
              style={{ color: ctx.accent, fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}
            />
            <EditableText
              value={item.body}
              path={["items", i, "body"]}
              ctx={ctx}
              placeholder="One supporting sentence"
              className="block"
              style={{ color: ctx.body, fontSize: 17, lineHeight: 1.45, marginTop: 6 }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
