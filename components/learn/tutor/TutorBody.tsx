"use client";

/**
 * TUTOR-1 Wave 4 — the tutor panel BODY. This is the heavy surface (SSE stream,
 * transcript render, citation controls, practice, suggestion chips, width drag,
 * vitals) — it is next/dynamic-imported by TutorMount with `ssr:false` so NONE
 * of that weight lands in the eager learn-route bundle.
 *
 * PACKAGE A ships a MINIMAL, HONEST placeholder: a header, a working close
 * button, and one line stating the conversation arrives next. Package B
 * replaces this component's contents while keeping the props contract below.
 */

import { X } from "lucide-react";

export interface TutorBodyProps {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  slug: string;
  escalationsUi: boolean;
  /** Return focus to the edge tab when the panel closes. */
  onClose: () => void;
}

export function TutorBody({ onClose }: TutorBodyProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-stone-200/80 px-4 py-3">
        <h2 className="text-sm font-medium text-stone-800">Course tutor</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tutor"
          data-ai-tool="tutor-close"
          className="grid size-8 place-items-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className="flex-1 px-4 py-6 text-sm leading-relaxed text-stone-500">
        The tutor conversation arrives in the next package.
      </div>
    </div>
  );
}

export default TutorBody;
