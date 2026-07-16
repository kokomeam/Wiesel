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

import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BRAND_TOKENS, watermarkText } from "@/lib/marketing/brand/tokens";
import {
  CLIP_CAPTION_STYLE_SPECS,
  CLIP_TEXT_STYLES,
  captionAnchor,
  clipTextPresetDefaults,
  hookAnchor,
  usableTextWidth,
} from "@/lib/marketing/clips/textStyles";
import {
  applyCaseRule,
  groupCaptionWords,
  planHookFit,
} from "@/lib/marketing/clips/textTrack";
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
  SLIDE_SHORT_H,
  SLIDE_SHORT_W,
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
        <p style={{ color: BRAND_TOKENS.colors.ink, fontFamily: BRAND_TOKENS.fonts.display }} className="text-[60px] font-light leading-tight">
          {title}
        </p>
      )}
      {rest.map((t, i) => (
        <p key={i} style={{ color: BRAND_TOKENS.colors.ink }} className="text-[30px] leading-snug opacity-80">
          {t}
        </p>
      ))}
    </div>
  );
}

/* ──────────── kinetic captions (H-4: shared style constants) ───────────── */

/**
 * A CSS ring-shadow approximating the libass stroke (12 points on a circle
 * of the layer's strokePx) — the T-2 non-optional outline, rendered the
 * browser way. Values come only from CLIP_TEXT_STYLES.
 */
function strokeShadow(strokePx: number, withDrop: boolean, dropPx = 0): string {
  const ring: string[] = [];
  for (let step = 0; step < 12; step++) {
    const a = (step / 12) * 2 * Math.PI;
    const dx = Math.round(Math.cos(a) * strokePx * 10) / 10;
    const dy = Math.round(Math.sin(a) * strokePx * 10) / 10;
    ring.push(`${dx}px ${dy}px 0 ${CLIP_TEXT_STYLES.stroke}`);
  }
  if (withDrop && dropPx > 0) {
    ring.push(`${dropPx}px ${dropPx}px ${Math.round(dropPx * 2)}px rgba(0,0,0,0.45)`);
  }
  return ring.join(", ");
}

/**
 * Word-level karaoke, ONE line at a time in 3–4 word groups — the SAME
 * grouping the burn path uses (groupCaptionWords) and the SAME T-3 style
 * data (CLIP_CAPTION_STYLE_SPECS keyed by the preset's default), so
 * slide-short captions are indistinguishable from burned ones.
 */
function Captions({ spec, tMs }: { spec: SlideShortSpec; tMs: number }) {
  const groups = useMemo(
    () => groupCaptionWords(spec.captionWords, spec.durationMs),
    [spec.captionWords, spec.durationMs]
  );
  if (groups.length === 0) return null;
  const group = groups.find((g) => tMs >= g.startMs && tMs < g.endMs);
  if (!group) return null;
  const cap = CLIP_TEXT_STYLES.caption;
  const styleSpec = CLIP_CAPTION_STYLE_SPECS[clipTextPresetDefaults(spec.preset).captionStyle];
  return (
    <div
      data-zone="captions"
      className="flex flex-wrap items-center justify-center gap-x-4 text-center"
      style={{
        fontFamily: `"${CLIP_TEXT_STYLES.fonts.caption.family}"`,
        fontWeight: 700,
        fontSize: cap.sizePx,
        lineHeight: CLIP_TEXT_STYLES.lineHeightFrac,
        color: CLIP_TEXT_STYLES.fill,
        textShadow: strokeShadow(cap.strokePx, false),
      }}
    >
      {group.words.map((w, i) => {
        const active = tMs >= w.startMs && tMs < w.endMs;
        const scale = active ? styleSpec.activeScalePct / 100 : 1;
        return (
          <span
            key={`${group.startMs}-${i}`}
            style={{
              color: active && styleSpec.activeFill ? styleSpec.activeFill : CLIP_TEXT_STYLES.fill,
              transform: `scale(${scale})`,
              ...(active && styleSpec.activeBox
                ? {
                    backgroundColor: styleSpec.boxFill,
                    borderRadius: Math.round(CLIP_TEXT_STYLES.boxPadPx * 0.8),
                    padding: `0 ${CLIP_TEXT_STYLES.boxPadPx}px`,
                    textShadow: "none",
                  }
                : {}),
            }}
          >
            {w.w}
          </span>
        );
      })}
    </div>
  );
}

/* ───────────── hook overlay (H-4: shared style constants) ──────────────── */

function HookOverlay({ spec, opacity }: { spec: SlideShortSpec; opacity: number }) {
  const defaults = clipTextPresetDefaults(spec.preset);
  const fit = useMemo(() => {
    const displayText = applyCaseRule(spec.hookText, defaults.hookCase);
    const wordCount = spec.hookText.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount === 0) return null;
    return planHookFit({
      displayText,
      wordCount,
      usableWidthPx: usableTextWidth(spec.platform, SLIDE_SHORT_W, SLIDE_SHORT_H),
      scale: 1, // 1080×1920 IS the reference canvas
      charFrac:
        defaults.hookCase === "upper"
          ? CLIP_TEXT_STYLES.avgCharWidthFrac.hookUpper
          : CLIP_TEXT_STYLES.avgCharWidthFrac.hookTitle,
      lowKey: defaults.lowKeyHook,
    });
  }, [spec.hookText, spec.platform, defaults]);
  if (!fit) return null;
  const blockH = Math.round(fit.lines.length * fit.style.sizePx * CLIP_TEXT_STYLES.lineHeightFrac);
  const anchor = hookAnchor(spec.platform, spec.preset, SLIDE_SHORT_W, SLIDE_SHORT_H, blockH);
  return (
    <div
      data-zone="hook"
      className="absolute inset-x-0 text-center"
      style={{
        top: anchor.y - blockH / 2,
        opacity,
        fontFamily: `"${CLIP_TEXT_STYLES.fonts.hook.family}"`,
        fontSize: fit.style.sizePx,
        lineHeight: CLIP_TEXT_STYLES.lineHeightFrac,
        color: CLIP_TEXT_STYLES.fill,
        textShadow: strokeShadow(fit.style.strokePx, fit.style.shadowPx > 0, fit.style.shadowPx),
      }}
    >
      {fit.lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
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

      {/* hook overlay (≤2s) — typography/position from CLIP_TEXT_STYLES (H-4) */}
      {hookOpacity > 0 && <HookOverlay spec={spec} opacity={hookOpacity} />}

      {/* kinetic captions — anchored inside the platform safe area (H-4) */}
      <div
        className="absolute inset-x-0"
        style={{
          top:
            captionAnchor(spec.platform, SLIDE_SHORT_W, SLIDE_SHORT_H).bottomY -
            Math.round(CLIP_TEXT_STYLES.caption.sizePx * CLIP_TEXT_STYLES.lineHeightFrac),
        }}
      >
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
            className="font-medium leading-tight"
            style={{
              color: BRAND_TOKENS.colors.onDark,
              fontFamily: BRAND_TOKENS.fonts.display,
              // T-2: the end-card CTA layer consumes the shared table (H-4)
              fontSize: CLIP_TEXT_STYLES.endCard.sizePx,
              textShadow: strokeShadow(
                CLIP_TEXT_STYLES.endCard.strokePx,
                CLIP_TEXT_STYLES.endCard.shadowPx > 0,
                CLIP_TEXT_STYLES.endCard.shadowPx
              ),
            }}
          >
            {spec.endCardCta ??
              (spec.preset === "bofu_preview"
                ? `This is one moment from “${spec.courseTitle}” — the full course is open.`
                : "Want the full lesson? It's in the course.")}
          </p>
          <p className="text-[30px]" style={{ color: BRAND_TOKENS.colors.brand }}>
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
