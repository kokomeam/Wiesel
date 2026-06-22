"use client";

/**
 * The `diagram` structured layout — a teaching VISUAL slide. Renders a title, the
 * programmatic diagram (DiagramView → crisp SVG), and a teaching caption /
 * takeaways. With takeaways present the diagram sits beside them (a "diagram +
 * explanation" slide); otherwise it goes full-width.
 *
 * The visual is exposed as a TEACHING OBJECT: it carries `role="img"` + the
 * spec's alt text for a11y, and (interactively) the machine-readable
 * `data-ai-*` envelope (spec §14) so an agent can find, validate, and act on it.
 */

import { DiagramView } from "../diagram/DiagramView";
import type { DiagramContent } from "@/lib/course/diagram/types";
import { EditableText, withAlpha, type StructuredCtx } from "./common";

const PAD = 80;
const DIAG_TOP = 150;

export function DiagramLayout({ content, ctx }: { content: DiagramContent; ctx: StructuredCtx }) {
  const { spec, diagram } = content;
  const takeaways = content.takeaways ?? [];
  const hasTakeaways = takeaways.length > 0;
  const hasCaption = !!content.caption?.text?.trim();

  const bottomReserve = hasCaption ? 92 : 44;
  const diagH = 720 - DIAG_TOP - bottomReserve;
  const takeawaysW = hasTakeaways ? 372 : 0;
  const gap = hasTakeaways ? 36 : 0;
  const diagW = 1280 - PAD * 2 - takeawaysW - gap;

  const palette = { accent: ctx.accent, ink: ctx.ink, body: ctx.body, muted: ctx.muted };
  const aiEnvelope = ctx.interactive
    ? {
        "data-ai-component": "slide-visual",
        "data-ai-type": diagram.kind,
        "data-ai-source": spec.source ?? "programmatic",
        "data-ai-validation-status": "passed",
        "data-ai-role": spec.role,
        "data-ai-purpose": spec.pedagogicalPurpose,
        "data-ai-actions": "regenerate,replace,simplify,edit_labels,add_caption,remove,validate",
      }
    : {};

  return (
    <div className="absolute inset-0" style={{ overflow: "hidden" }}>
      <EditableText
        value={content.title}
        path={["title"]}
        ctx={ctx}
        placeholder="Slide title"
        className="absolute block [font-family:var(--font-display)]"
        style={{ left: PAD, top: 52, right: PAD, color: ctx.ink, fontSize: 42, fontWeight: 300, lineHeight: 1.1, letterSpacing: "-0.02em" }}
      />

      {/* The visual itself — a labeled teaching object. */}
      <div
        {...aiEnvelope}
        role="img"
        aria-label={`Visual: ${spec.altText}`}
        className="absolute"
        style={{ left: PAD, top: DIAG_TOP, width: diagW, height: diagH }}
      >
        <DiagramView diagram={diagram} width={diagW} height={diagH} palette={palette} uid={ctx.slideId} />
      </div>

      {/* Takeaways column (turns it into a diagram + explanation slide). */}
      {hasTakeaways && (
        <div className="absolute flex flex-col" style={{ left: PAD + diagW + gap, top: DIAG_TOP + 8, width: takeawaysW, gap: 16 }}>
          {takeaways.map((tk, i) => (
            <div key={i} className="flex items-start" style={{ gap: 12 }}>
              <span aria-hidden style={{ flex: "0 0 auto", marginTop: 9, width: 8, height: 8, borderRadius: "50%", background: ctx.accent }} />
              <EditableText
                value={tk}
                path={["takeaways", i]}
                ctx={ctx}
                placeholder="A key point"
                className="block"
                style={{ color: ctx.ink, fontSize: 18, lineHeight: 1.45 }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Teaching caption — what to notice. */}
      {(hasCaption || ctx.interactive) && (
        <div className="absolute flex items-start" style={{ left: PAD, right: PAD, bottom: 40, gap: 12 }}>
          <span aria-hidden style={{ flex: "0 0 auto", marginTop: 9, width: 26, height: 3, borderRadius: 2, background: withAlpha(ctx.accent, 0.7) }} />
          <EditableText
            value={content.caption}
            path={["caption"]}
            ctx={ctx}
            placeholder="What should the learner notice?"
            className="block"
            style={{ color: ctx.body, fontSize: 18, lineHeight: 1.5, maxWidth: 1040 }}
          />
        </div>
      )}
    </div>
  );
}
