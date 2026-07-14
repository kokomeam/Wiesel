/**
 * The WiseSel slide-short composition (amendment FR-6) — 1080×1920, 30fps:
 *
 *   [hook overlay ≤2s] → slides advancing on their SYNC timestamps (the
 *   lesson's REAL slides through the PURE structured layout components +
 *   DiagramView — the renderToStaticMarkup-proven base; NOT SlideStage,
 *   which is browser-measurement-gated) → kinetic word-level captions →
 *   preset-appropriate end card. Audio = the pre-cut span's own track.
 *
 * Brand values come ONLY from lib/marketing/brand/tokens (D-1 — the
 * divergence check scans this folder). Element-based (non-template) slides
 * render through a pure text-extraction card — honest fallback, surfaced in
 * docs/clips.md (the proven pure base covers structured templates; the
 * freeform element canvas is editor-measurement territory).
 */

import React from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BRAND_TOKENS, watermarkText } from "@/lib/marketing/brand/tokens";
import { findTheme } from "@/lib/course/slide/themes";
import type { Slide, SlideElement } from "@/lib/course/types";
import type { StructuredCtx } from "@/components/editor/slide/structured/common";
import { StructuredBackdrop } from "@/components/editor/slide/structured/StructuredBackdrop";
import { CodeWalkthroughLayout } from "@/components/editor/slide/structured/CodeWalkthroughLayout";
import { ComparisonColumnsLayout } from "@/components/editor/slide/structured/ComparisonColumnsLayout";
import { ComparisonMatrixLayout } from "@/components/editor/slide/structured/ComparisonMatrixLayout";
import { ConceptExampleLayout } from "@/components/editor/slide/structured/ConceptExampleLayout";
import { DiagramLayout } from "@/components/editor/slide/structured/DiagramLayout";
import { IllustrationLayout } from "@/components/editor/slide/structured/IllustrationLayout";
import { ImageReferenceLayout } from "@/components/editor/slide/structured/ImageReferenceLayout";
import { ImageSupportingLayout } from "@/components/editor/slide/structured/ImageSupportingLayout";
import { KeyConceptLayout } from "@/components/editor/slide/structured/KeyConceptLayout";
import { MetricsLayout } from "@/components/editor/slide/structured/MetricsLayout";
import { OutlineListLayout } from "@/components/editor/slide/structured/OutlineListLayout";
import { ProcessLayout } from "@/components/editor/slide/structured/ProcessLayout";
import { ProseLayout } from "@/components/editor/slide/structured/ProseLayout";
import { SectionBreakLayout } from "@/components/editor/slide/structured/SectionBreakLayout";
import { CLIP_PRESET_META } from "../../presets";
import {
  SLIDE_SHORT_ENDCARD_MS,
  SLIDE_SHORT_HOOK_MS,
  type SlideShortSpec,
} from "./spec";

/* ─────────────── pure slide dispatch (StructuredSlide, sans store) ─────── */

function PureStructuredSlide({ slide }: { slide: Slide }) {
  const theme = findTheme(slide.style.theme.id);
  const template = slide.template;
  if (!template) return <PureElementSlide slide={slide} />;
  const ctx: StructuredCtx = {
    blockId: "clip-render",
    slideId: slide.id,
    interactive: false,
    accent: theme.accentColor,
    ink: theme.colors.heading,
    body: theme.colors.body,
    muted: theme.colors.muted,
  };
  return (
    <div className="absolute inset-0" aria-hidden>
      <StructuredBackdrop accent={theme.accentColor} />
      {template.layoutId === "process_steps" && <ProcessLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "key_concept" && <KeyConceptLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "metrics_overview" && <MetricsLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "code_walkthrough_steps" && <CodeWalkthroughLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "section_break" && <SectionBreakLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "concept_example" && <ConceptExampleLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "outline_list" && <OutlineListLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "prose" && <ProseLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "comparison_columns" && <ComparisonColumnsLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "comparison_matrix" && <ComparisonMatrixLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "diagram" && <DiagramLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "illustration" && <IllustrationLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "image_reference" && <ImageReferenceLayout content={template.content} ctx={ctx} />}
      {template.layoutId === "image_supporting" && <ImageSupportingLayout content={template.content} ctx={ctx} />}
    </div>
  );
}

/** Pure fallback for freeform ELEMENT slides: extract the text content and
 *  render a clean branded card (the element canvas itself is editor-
 *  measurement territory — deliberately not reimplemented here). */
function PureElementSlide({ slide }: { slide: Slide }) {
  const texts = (slide.elements as SlideElement[])
    .map((el) => ("text" in el && typeof el.text === "string" ? el.text.trim() : ""))
    .filter((t) => t.length > 0)
    .slice(0, 6);
  const [title, ...rest] = texts;
  return (
    <div
      className="absolute inset-0 flex flex-col justify-center gap-8 px-24"
      style={{ backgroundColor: BRAND_TOKENS.colors.canvas }}
      aria-hidden
    >
      {title && (
        <p style={{ color: BRAND_TOKENS.colors.ink, fontFamily: BRAND_TOKENS.fonts.display }} className="text-6xl font-light leading-tight">
          {title}
        </p>
      )}
      {rest.map((t, i) => (
        <p key={i} style={{ color: BRAND_TOKENS.colors.ink }} className="text-3xl leading-snug opacity-80">
          {t}
        </p>
      ))}
    </div>
  );
}

/* ──────────────────────── kinetic captions ────────────────────────────── */

const CAPTION_WINDOW = 5;

function Captions({ spec, tMs }: { spec: SlideShortSpec; tMs: number }) {
  const words = spec.captionWords;
  if (words.length === 0) return null;
  let idx = words.findIndex((w) => tMs >= w.startMs && tMs < w.endMs);
  if (idx === -1) {
    idx = words.findIndex((w) => w.startMs > tMs);
    if (idx === -1) idx = words.length - 1;
  }
  const start = Math.max(0, idx - Math.floor(CAPTION_WINDOW / 2));
  const visible = words.slice(start, start + CAPTION_WINDOW);
  return (
    <div
      data-zone="captions"
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-16 text-center"
    >
      {visible.map((w, i) => {
        const active = start + i === idx && tMs >= w.startMs && tMs < w.endMs;
        return (
          <span
            key={`${start + i}`}
            className="text-5xl font-bold uppercase tracking-tight"
            style={{
              fontFamily: BRAND_TOKENS.fonts.sans,
              color: active ? BRAND_TOKENS.colors.brand : BRAND_TOKENS.colors.onDark,
              transform: active ? "scale(1.08)" : "scale(1)",
            }}
          >
            {w.w}
          </span>
        );
      })}
    </div>
  );
}

/* ───────────────────────────── the composition ─────────────────────────── */

export function SlideShortComposition(props: Record<string, unknown>) {
  const spec = props as unknown as SlideShortSpec;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tMs = (frame / fps) * 1000;

  const active =
    spec.slides.find((s) => tMs >= s.fromMs && tMs < s.toMs) ??
    (tMs < spec.slides[0].fromMs ? spec.slides[0] : spec.slides[spec.slides.length - 1]);

  const hookOpacity = interpolate(
    tMs,
    [0, 200, SLIDE_SHORT_HOOK_MS - 400, SLIDE_SHORT_HOOK_MS],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const endCardAtMs = spec.durationMs - SLIDE_SHORT_ENDCARD_MS;
  const endCardOpacity = interpolate(tMs, [endCardAtMs, endCardAtMs + 350], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const preset = CLIP_PRESET_META[spec.preset];

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND_TOKENS.colors.backdrop }}>
      <Audio src={spec.mediaUrl} />

      {/* slide zone: the 1280×720 logical canvas scaled to full width */}
      <div className="absolute left-0 top-[340px] h-[608px] w-full" data-zone="slide">
        <div
          className="relative origin-top-left overflow-hidden rounded-none"
          style={{ width: 1280, height: 720, transform: `scale(${1080 / 1280})` }}
        >
          <PureStructuredSlide key={(active.slide as { id?: string }).id ?? active.fromMs} slide={active.slide as unknown as Slide} />
        </div>
      </div>

      {/* hook overlay (≤2s) */}
      {hookOpacity > 0 && (
        <div
          data-zone="hook"
          className="absolute inset-x-0 top-[120px] px-14 text-center"
          style={{ opacity: hookOpacity }}
        >
          <p
            className="text-6xl font-semibold leading-tight"
            style={{ color: BRAND_TOKENS.colors.onDark, fontFamily: BRAND_TOKENS.fonts.display }}
          >
            {spec.hookText}
          </p>
        </div>
      )}

      {/* kinetic captions */}
      <div className="absolute inset-x-0 top-[1030px]">
        <Captions spec={spec} tMs={tMs} />
      </div>

      {/* persistent watermark */}
      <p
        className="absolute bottom-[64px] w-full text-center font-mono text-2xl tracking-wide"
        style={{ color: BRAND_TOKENS.colors.onDarkMuted }}
      >
        {watermarkText(spec.creatorHandle)}
      </p>

      {/* preset-appropriate end card */}
      {endCardOpacity > 0 && (
        <AbsoluteFill
          data-zone="endcard"
          style={{ backgroundColor: BRAND_TOKENS.colors.backdrop, opacity: endCardOpacity }}
          className="items-center justify-center gap-10 px-16 text-center"
        >
          <p
            className="text-5xl font-medium leading-tight"
            style={{ color: BRAND_TOKENS.colors.onDark, fontFamily: BRAND_TOKENS.fonts.display }}
          >
            {spec.endCardCta ??
              (spec.preset === "bofu_preview"
                ? `This is one moment from “${spec.courseTitle}” — the full course is open.`
                : "Want the full lesson? It's in the course.")}
          </p>
          <p className="text-3xl" style={{ color: BRAND_TOKENS.colors.brand }}>
            {preset.endCardFraming === "enroll / link-in-bio framing"
              ? "Enroll — link in bio"
              : "Comment the keyword and I'll send it"}
          </p>
          <p className="font-mono text-2xl" style={{ color: BRAND_TOKENS.colors.onDarkMuted }}>
            {watermarkText(spec.creatorHandle)}
          </p>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
