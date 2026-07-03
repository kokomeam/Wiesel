"use client";

/**
 * TEMPORARY visual-diff harness for materialize-on-eject (delete after the
 * before/after pass — it is NOT part of the product). Renders ONE slide at a
 * fixed 1280×720 in either structured or ejected form, selected by query params
 * (?layout=concept_example&mode=structured|elements). Wrapped in Suspense so the
 * slide (and its crypto ids) renders client-side only — no SSR / hydration.
 */

import { Suspense, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { SlideStage } from "@/components/editor/slide/SlideStage";
import { createBlock, createLesson, createModule, createStructuredSlide } from "@/lib/course/factories";
import { findSlide } from "@/lib/course/queries";
import { materializeSlide } from "@/lib/course/slide/materialize";
import { useEditorStore } from "@/lib/course/store";
import type { CourseDocument, Slide, SlideDeckBlock, StructuredLayoutId } from "@/lib/course/types";

function ejectedSlide(layout: string): Slide {
  const structured = createStructuredSlide(layout as StructuredLayoutId);
  const els = materializeSlide(structured);
  if (!els) return structured;
  return { ...structured, template: undefined, backdrop: "structured", elements: els, layout: structured.layout };
}

/** Static (non-interactive) preview for the before/after pixel pass. */
function StaticPreview({ layout, mode }: { layout: string; mode: string }) {
  const slide = useMemo<Slide>(() => (mode === "elements" ? ejectedSlide(layout) : createStructuredSlide(layout as StructuredLayoutId)), [layout, mode]);
  return (
    <div id="stage-wrap" data-ready="1" style={{ width: 1280, height: 720, background: "#ffffff" }}>
      <SlideStage slide={slide} blockId="preview" lessonId="preview" mode="thumbnail" />
    </div>
  );
}

/** Interactive edit preview — hydrates the store with an ejected slide and
 *  selects a list (or text) element, so the keyboard editor can be driven. */
function EditPreview({ layout, selectType }: { layout: string; selectType: "text" | "bullet_list" }) {
  const built = useMemo(() => {
    const slide = ejectedSlide(layout);
    const deck = createBlock("slide_deck", 0) as SlideDeckBlock;
    deck.slides = [slide];
    const lesson = createLesson("L", 0);
    lesson.blocks = [deck];
    const mod = createModule("M", 0);
    mod.lessons = [lesson];
    const doc: CourseDocument = {
      id: "preview",
      title: "Edit preview",
      plan: { outcomes: [], prerequisites: [] },
      modules: [mod],
      theme: { name: "x", accent: "amber", slideDefaults: { layout: "blank", themeId: "editorial-warm" } },
      metadata: { createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z", aiReadableVersion: "1.0" },
    };
    const target = slide.elements.find((e) => e.type === selectType) ?? slide.elements.find((e) => e.type === "bullet_list");
    return { doc, deckId: deck.id, lessonId: lesson.id, slideId: slide.id, listElId: target?.id };
  }, [layout, selectType]);

  useEffect(() => {
    const st = useEditorStore.getState();
    st.hydrate(built.doc, "preview");
    if (built.listElId) st.select({ kind: "element", id: built.listElId, slideId: built.slideId, blockId: built.deckId, lessonId: built.lessonId });
  }, [built]);

  const slide = useEditorStore((s) => findSlide(s.doc, built.deckId, built.slideId)?.slide);
  if (!slide) return null;
  return (
    <div id="stage-wrap" data-ready="1" data-list-el={built.listElId} style={{ width: 1280, height: 720, background: "#ffffff" }}>
      <SlideStage slide={slide} blockId={built.deckId} lessonId={built.lessonId} mode="edit" />
    </div>
  );
}

function Preview() {
  const sp = useSearchParams();
  const layout = sp.get("layout") ?? "concept_example";
  const mode = sp.get("mode") ?? "structured";
  if (sp.get("edit") === "1") return <EditPreview layout={layout} selectType={sp.get("el") === "text" ? "text" : "bullet_list"} />;
  return <StaticPreview layout={layout} mode={mode} />;
}

export default function MaterializePreviewPage() {
  // Dev-only diagnostic — never renders in a production build.
  if (process.env.NODE_ENV === "production") return null;
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
