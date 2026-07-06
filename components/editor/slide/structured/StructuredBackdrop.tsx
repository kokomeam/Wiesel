/**
 * The themed ambient backdrop for renderer-owned structured slides: two soft
 * corner glows (radial gradients that bleed off the canvas) + a faint accent
 * dot-grid. Pure + presentational.
 *
 * Single-sourced so it renders BOTH for a structured slide (via StructuredSlide)
 * AND for a slide that was ejected to editable elements (via SlideStage, when
 * `slide.backdrop === "structured"`). The glows bleed past the 1280×720 edges,
 * so they can't be materialized as canvas-clamped elements — they stay a
 * non-interactive themed layer, which is also the right UX (you don't drag the
 * corner glow).
 */

import { withAlpha } from "@/lib/course/slide/structured/styleConstants";

export function StructuredBackdrop({ accent }: { accent: string }) {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      <div
        className="absolute"
        style={{ right: -130, top: -150, width: 470, height: 470, borderRadius: "50%", background: `radial-gradient(circle at 32% 32%, ${withAlpha(accent, 0.16)}, transparent 70%)` }}
      />
      <div
        className="absolute"
        style={{ left: -130, bottom: -170, width: 430, height: 430, borderRadius: "50%", background: `radial-gradient(circle at 60% 40%, ${withAlpha(accent, 0.09)}, transparent 70%)` }}
      />
      <div
        className="absolute"
        style={{ right: 60, top: 66, width: 118, height: 80, opacity: 0.55, backgroundImage: `radial-gradient(${withAlpha(accent, 0.5)} 1.4px, transparent 1.4px)`, backgroundSize: "18px 18px" }}
      />
    </div>
  );
}
