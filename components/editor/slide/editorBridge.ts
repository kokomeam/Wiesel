"use client";

/**
 * The slide renderers' editing seam (PERF-1 D1). Shared renderers
 * (StructuredSlide + layout components, CodeElement, ImageElementView) run on
 * BOTH the editor canvas and the read-only SlideView the learner route ships.
 * They must never import the editor stores or lib/course/commands directly —
 * that chain drags patches.ts/factories.ts/zod into the read-only bundle.
 * Instead they read this context: SlideStage (the editor entry) provides a
 * store-backed value; everywhere else it stays null and edit affordances are
 * inert. All imports here are TYPE-ONLY, so consuming this file costs nothing.
 */

import { createContext, useContext } from "react";
import type { CoursePatch } from "@/lib/course/patches";
import type { Selection } from "@/lib/course/types";
import type { ImageDialogRequest } from "@/lib/editor/uiStore";

/** The patch creators the shared renderers use — a type-only view of
 *  lib/course/commands so the module itself stays out of the view bundle. */
export type EditorPatchCommands = Pick<
  typeof import("@/lib/course/commands"),
  "updateElementPatch" | "updateTemplateContentPatch"
>;

export interface SlideEditorBridge {
  /** Applies one human patch through the editor store (source pinned "human"). */
  apply: (patch: CoursePatch) => void;
  select: (selection: Selection) => void;
  openImageDialog: (req: ImageDialogRequest) => void;
  commands: EditorPatchCommands;
}

const SlideEditorBridgeContext = createContext<SlideEditorBridge | null>(null);

export const SlideEditorBridgeProvider = SlideEditorBridgeContext.Provider;

/** null ⇒ read-only render (SlideView / thumbnails / learner runtime). */
export function useSlideEditorBridge(): SlideEditorBridge | null {
  return useContext(SlideEditorBridgeContext);
}
