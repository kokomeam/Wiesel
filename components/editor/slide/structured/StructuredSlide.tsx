"use client";

/**
 * Dispatches a renderer-owned structured slide to its layout component, behind
 * a themed corner-blob + dot-grid backdrop (renderer-owned decoration — never a
 * per-slide AI choice). Clicking the background selects the slide; text slots
 * edit in place. The freeform element canvas is bypassed entirely here.
 */

import { aiAttrs } from "@/lib/course/aiAttributes";
import { findTheme } from "@/lib/course/slide/themes";
import { useEditorStore } from "@/lib/course/store";
import type { Slide } from "@/lib/course/types";
import { withAlpha, type StructuredCtx } from "./common";
import { CodeWalkthroughLayout } from "./CodeWalkthroughLayout";
import { ComparisonColumnsLayout } from "./ComparisonColumnsLayout";
import { ComparisonMatrixLayout } from "./ComparisonMatrixLayout";
import { ConceptExampleLayout } from "./ConceptExampleLayout";
import { KeyConceptLayout } from "./KeyConceptLayout";
import { MetricsLayout } from "./MetricsLayout";
import { OutlineListLayout } from "./OutlineListLayout";
import { ProcessLayout } from "./ProcessLayout";
import { ProseLayout } from "./ProseLayout";
import { SectionBreakLayout } from "./SectionBreakLayout";

function StructuredBackdrop({ accent }: { accent: string }) {
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

export function StructuredSlide({
  slide,
  blockId,
  lessonId,
  interactive,
}: {
  slide: Slide;
  blockId: string;
  lessonId: string;
  interactive: boolean;
}) {
  const select = useEditorStore((s) => s.select);
  const theme = findTheme(slide.style.theme.id);
  const template = slide.template;
  if (!template) return null;

  const ctx: StructuredCtx = {
    blockId,
    slideId: slide.id,
    interactive,
    accent: theme.accentColor,
    ink: theme.colors.heading,
    body: theme.colors.body,
    muted: theme.colors.muted,
  };

  return (
    <div
      className="absolute inset-0"
      {...(interactive
        ? aiAttrs({
            component: "structured-slide",
            type: "slide",
            id: slide.id,
            parentId: blockId,
            order: slide.order,
            purpose: slide.ai.purpose,
            label: `Structured slide (${template.layoutId})`,
          })
        : { "aria-hidden": true as const })}
      onClick={
        interactive
          ? (e) => {
              e.stopPropagation();
              select({ kind: "slide", id: slide.id, blockId, lessonId });
            }
          : undefined
      }
    >
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
    </div>
  );
}
