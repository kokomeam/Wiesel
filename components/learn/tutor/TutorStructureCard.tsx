"use client";

/**
 * TUTOR-1 A3 Wave 4 — the render-structure card (Class P, presentational).
 *
 * Renders a tutor-emitted tree/graph/timeline/axes shape as a crisp SVG via the
 * REUSED slide-diagram renderer (`components/editor/slide/diagram/DiagramView` —
 * pure, hooks-free, SSR-safe, dependency-free; the audit §5 reuse). The server
 * already mapped the A3 `kind` onto a `lib/course/diagram` spec, validated it with
 * `validateDiagram`, and shipped only the built spec (an invalid one is dropped
 * server-side and never reaches this card) — so this component just SIZES and
 * frames the diagram; it never validates or fabricates structure.
 *
 * A11y: the diagram is a static SVG (no keyboard interaction needed). The whole
 * figure is `role="img"` with the `caption` as its accessible NAME (aria-label),
 * and the visible caption doubles as the on-screen description. When the card
 * carries no caption we fall back to a summary derived from the diagram kind, so
 * the accessible name is never empty.
 *
 * House rules: warm paper/stone chrome matching PracticeCard; NO framer-motion; no
 * Date.now()/Math.random() in render (the diagram maths is deterministic); zod-free
 * (the diagram TYPES ride in via tutorClientTypes; DiagramView imports only the
 * pure types/geometry — never the Zod schemas.ts).
 */

import { DiagramView } from "@/components/editor/slide/diagram/DiagramView";
import type { DiagramPalette } from "@/components/editor/slide/diagram/svg";
import type { TutorRenderStructureCard } from "@/lib/learn/tutorClientTypes";

/**
 * A warm-paper diagram palette for the tutor dock (the slide renderer takes
 * `#rrggbb` hex — its `alpha()` parses it). Brand orange accent + stone ink/body/
 * muted, matching the tutor design system.
 */
const TUTOR_DIAGRAM_PALETTE: DiagramPalette = {
  accent: "#c2410c", // brand-700
  ink: "#292524", // stone-800
  body: "#57534e", // stone-600
  muted: "#a8a29e", // stone-400
};

/** The diagram's logical draw box. The SVG's `viewBox` scales the whole picture
 *  into the card's responsive width, so these are just the aspect-ratio + label
 *  headroom the renderers were tuned for; the dock (~300–520px) shrinks it down. */
const DIAGRAM_W = 520;
const DIAGRAM_H = 360;

export function TutorStructureCard({ card }: { card: TutorRenderStructureCard }) {
  const title = card.title?.trim() || null;
  const caption = card.caption?.trim() || null;
  // The accessible name never goes empty — fall back to a kind summary.
  const accessibleName = caption ?? title ?? `${card.kind} diagram`;

  return (
    <figure
      data-ai-component="tutor-structure-card"
      className="w-[92%] overflow-hidden rounded-2xl border border-stone-200/80 bg-white p-3 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      {title ? (
        <figcaption className="mb-1.5 text-sm font-medium text-stone-800">{title}</figcaption>
      ) : null}

      {/* The visual itself — a labeled teaching object. Static SVG: role=img +
          the caption as the accessible name; no interactive children, so no
          keyboard handling needed. DiagramView emits a `viewBox`+
          `preserveAspectRatio` SVG at the logical DIAGRAM_W×DIAGRAM_H size; the
          `[&>svg]:w-full`/`h-full` overrides let it scale FLUIDLY into the dock's
          fixed-aspect box (~300–520px) instead of overflowing at its fixed px. */}
      <div
        role="img"
        aria-label={accessibleName}
        className="w-full [&>svg]:h-full [&>svg]:w-full"
        style={{ aspectRatio: `${DIAGRAM_W} / ${DIAGRAM_H}` }}
      >
        <DiagramView
          diagram={card.diagram}
          width={DIAGRAM_W}
          height={DIAGRAM_H}
          palette={TUTOR_DIAGRAM_PALETTE}
          uid={`tutor-diag-${card.kind}`}
        />
      </div>

      {/* The caption doubles as the on-screen description (what to notice). It is
          aria-hidden because the figure's aria-label already carries the same
          text as the diagram's accessible name — avoids a double read. */}
      {caption ? (
        <p aria-hidden className="mt-2 text-xs leading-relaxed text-stone-600">
          {caption}
        </p>
      ) : null}
    </figure>
  );
}

export default TutorStructureCard;
