"use client";

/**
 * The structured-layout RENDER registry: layoutId → layout component. This is
 * the render half of the registry split (PERF-1 D1) — display metadata / AI
 * hints / seeds live in lib/course/slide/structuredLayoutsCore.ts (zod-free),
 * and the strict content schemas in lib/course/slide/structuredLayouts.ts.
 * Nothing reachable from here may import zod or the editor stores: this file
 * ships in the read-only learner bundle via SlideView → StructuredSlide.
 */

import type { ComponentType } from "react";
import type { SlideTemplate } from "@/lib/course/types";
import type { StructuredCtx } from "./common";
import { CodeWalkthroughLayout } from "./CodeWalkthroughLayout";
import { ComparisonColumnsLayout } from "./ComparisonColumnsLayout";
import { ComparisonMatrixLayout } from "./ComparisonMatrixLayout";
import { ConceptExampleLayout } from "./ConceptExampleLayout";
import { DiagramLayout } from "./DiagramLayout";
import { IllustrationLayout } from "./IllustrationLayout";
import { ImageReferenceLayout } from "./ImageReferenceLayout";
import { ImageSupportingLayout } from "./ImageSupportingLayout";
import { KeyConceptLayout } from "./KeyConceptLayout";
import { MetricsLayout } from "./MetricsLayout";
import { OutlineListLayout } from "./OutlineListLayout";
import { ProcessLayout } from "./ProcessLayout";
import { ProseLayout } from "./ProseLayout";
import { SectionBreakLayout } from "./SectionBreakLayout";

type LayoutId = SlideTemplate["layoutId"];

/** Each layout component, keyed by its template id; the prop types are the
 *  per-layout content types, so the map is checked per entry. */
const LAYOUT_COMPONENTS: {
  [K in LayoutId]: ComponentType<{
    content: Extract<SlideTemplate, { layoutId: K }>["content"];
    ctx: StructuredCtx;
  }>;
} = {
  process_steps: ProcessLayout,
  key_concept: KeyConceptLayout,
  metrics_overview: MetricsLayout,
  code_walkthrough_steps: CodeWalkthroughLayout,
  section_break: SectionBreakLayout,
  concept_example: ConceptExampleLayout,
  outline_list: OutlineListLayout,
  prose: ProseLayout,
  comparison_columns: ComparisonColumnsLayout,
  comparison_matrix: ComparisonMatrixLayout,
  diagram: DiagramLayout,
  illustration: IllustrationLayout,
  image_reference: ImageReferenceLayout,
  image_supporting: ImageSupportingLayout,
};

/** Render a structured template through the registry. The cast is sound: the
 *  map above pairs every layoutId with the component typed for its content. */
export function renderStructuredLayout(template: SlideTemplate, ctx: StructuredCtx) {
  const Layout = LAYOUT_COMPONENTS[template.layoutId] as ComponentType<{
    content: SlideTemplate["content"];
    ctx: StructuredCtx;
  }>;
  return <Layout content={template.content} ctx={ctx} />;
}
