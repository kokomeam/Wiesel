"use client";

/**
 * Editor UI state: panel collapse, focus mode, inspector tab, custom slide
 * layouts, and the slide clipboard. Persisted to localStorage with
 * skipHydration — SSR and the first client paint always render the defaults,
 * then UIHydrator rehydrates in an effect, so there is never a hydration
 * mismatch. Clipboard and the focus-mode snapshot are deliberately not
 * persisted.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FlowPhase } from "@/lib/course/creationFlow";
import type { SlideLayoutDef } from "@/lib/course/slide/layouts";
import type { Slide, SlideElement } from "@/lib/course/types";

export type PanelKey =
  | "appSidebar"
  | "outline"
  | "inspector"
  | "aiBar"
  | "filmstrip";

export type InspectorTab = "design" | "content" | "ai" | "metadata";

/** Canvas right-click menu state (viewport coords). targetId null = empty
 *  stage area (paste target). */
export interface ContextMenuState {
  x: number;
  y: number;
  blockId: string;
  slideId: string;
  lessonId: string;
  targetId: string | null;
  /** Right-click point in logical slide coords — paste lands here. */
  canvasPoint: { x: number; y: number } | null;
}

/** Copied slide elements (deep clones) + where they came from, so paste can
 *  land in place on OTHER slides and offset on the same one (GS). */
export interface ElementClipboard {
  elements: SlideElement[];
  sourceSlideId: string;
}

type PanelSnapshot = Record<PanelKey, boolean>;

/** A pending image-dialog request. Carried in the store (not React context)
 *  so the toolbar, canvas placeholders, AND the inspector can all open it. */
export interface ImageDialogRequest {
  blockId: string;
  slideId: string;
  /** Element count on the slide — used to place a newly inserted image. */
  elementCount: number;
  /** Set to replace an existing image element; omit to insert a new one. */
  replaceElementId?: string;
  /** Set to use the upload as the slide background instead of an element. */
  forBackground?: boolean;
}

interface UIState {
  collapsed: PanelSnapshot;
  focusMode: boolean;
  /** Panel states before focus mode, restored on exit. Not persisted. */
  preFocusSnapshot: PanelSnapshot | null;
  inspectorTab: InspectorTab;
  customLayouts: SlideLayoutDef[];
  /** In-memory slide clipboard. Not persisted. */
  slideClipboard: Slide | null;
  /** Pending image-upload dialog request. Not persisted. */
  imageDialog: ImageDialogRequest | null;
  /** Element clipboard. Not persisted (mirrored to the OS clipboard). */
  elementClipboard: ElementClipboard | null;
  /** Open canvas context menu. Not persisted. */
  contextMenu: ContextMenuState | null;
  /** Canvas zoom factor on top of the fit-to-width scale. Not persisted. */
  zoom: number;
  /** Active creation-flow step (Plan / Create / Publish). null = derive from
   *  the doc (empty course → Plan, otherwise Create). Not persisted. */
  activeStep: FlowPhase | null;

  togglePanel: (key: PanelKey) => void;
  setActiveStep: (step: FlowPhase) => void;
  openImageDialog: (req: ImageDialogRequest) => void;
  closeImageDialog: () => void;
  setElementClipboard: (clip: ElementClipboard | null) => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setPanel: (key: PanelKey, collapsed: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  enterFocusMode: () => void;
  exitFocusMode: () => void;
  resetLayout: () => void;
  saveCustomLayout: (layout: SlideLayoutDef) => void;
  deleteCustomLayout: (id: string) => void;
  setSlideClipboard: (slide: Slide | null) => void;
}

const defaultPanels: PanelSnapshot = {
  appSidebar: false,
  outline: false,
  inspector: false,
  aiBar: false,
  filmstrip: false,
};

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
function clampZoom(z: number): number {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      collapsed: { ...defaultPanels },
      focusMode: false,
      preFocusSnapshot: null,
      inspectorTab: "design",
      customLayouts: [],
      slideClipboard: null,
      imageDialog: null,
      elementClipboard: null,
      contextMenu: null,
      zoom: 1,
      activeStep: null,

      togglePanel: (key) =>
        set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),

      setActiveStep: (step) => set({ activeStep: step }),

      openImageDialog: (req) => set({ imageDialog: req }),
      closeImageDialog: () => set({ imageDialog: null }),
      setElementClipboard: (clip) => set({ elementClipboard: clip }),
      openContextMenu: (menu) => set({ contextMenu: menu }),
      closeContextMenu: () => set({ contextMenu: null }),

      setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
      zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom * ZOOM_STEP) })),
      zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom / ZOOM_STEP) })),

      setPanel: (key, collapsed) =>
        set((s) => ({ collapsed: { ...s.collapsed, [key]: collapsed } })),

      setInspectorTab: (tab) => set({ inspectorTab: tab }),

      enterFocusMode: () =>
        set((s) => ({
          focusMode: true,
          preFocusSnapshot: { ...s.collapsed },
          collapsed: {
            ...s.collapsed,
            appSidebar: true,
            outline: true,
            inspector: true,
            aiBar: true,
          },
        })),

      exitFocusMode: () =>
        set((s) => ({
          focusMode: false,
          collapsed: s.preFocusSnapshot ?? { ...defaultPanels },
          preFocusSnapshot: null,
        })),

      resetLayout: () =>
        set({
          collapsed: { ...defaultPanels },
          focusMode: false,
          preFocusSnapshot: null,
          inspectorTab: "design",
        }),

      saveCustomLayout: (layout) =>
        set((s) => ({
          customLayouts: [...s.customLayouts.filter((l) => l.id !== layout.id), layout],
        })),

      deleteCustomLayout: (id) =>
        set((s) => ({ customLayouts: s.customLayouts.filter((l) => l.id !== id) })),

      setSlideClipboard: (slide) => set({ slideClipboard: slide }),
    }),
    {
      name: "cgp-editor-ui",
      skipHydration: true,
      partialize: (s) => ({
        collapsed: s.collapsed,
        inspectorTab: s.inspectorTab,
        customLayouts: s.customLayouts,
      }),
    }
  )
);
