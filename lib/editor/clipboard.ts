"use client";

/**
 * Clipboard bridge: the in-memory stores stay the same-tab fast path, and
 * every copy is mirrored to the OS clipboard as a markered JSON payload —
 * so element paste survives reloads and crosses tabs, and plain text copied
 * anywhere pastes as a new text element (GS behavior).
 *
 * Rules:
 *  - The clipboard holds ONE thing: copying elements clears the slide
 *    clipboard and vice versa (and the OS payload marker keeps the two
 *    paste paths from misfiring on each other).
 *  - Same-tab in-memory content is authoritative; the OS clipboard is the
 *    fallback. (Known limitation: a copy in ANOTHER tab won't beat this
 *    tab's newer in-memory clipboard until reload.)
 *  - OS access can be denied — every call degrades silently to in-memory.
 */

import {
  pasteElementsPatches,
  pasteTextElementPatch,
} from "@/lib/course/commands";
import { findSlide } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import type { Slide, SlideElement } from "@/lib/course/types";
import { useUIStore, type ElementClipboard } from "./uiStore";

interface ElementsPayload {
  coursegen: "elements";
  elements: SlideElement[];
  sourceSlideId: string;
}

export function copyElementsToClipboards(
  elements: SlideElement[],
  sourceSlideId: string
): void {
  const clip: ElementClipboard = {
    elements: structuredClone(elements),
    sourceSlideId,
  };
  const ui = useUIStore.getState();
  ui.setElementClipboard(clip);
  ui.setSlideClipboard(null); // the clipboard holds one thing
  void writeOS({ coursegen: "elements", ...clip });
}

export function copySlideToClipboards(slide: Slide): void {
  const ui = useUIStore.getState();
  ui.setSlideClipboard(structuredClone(slide));
  ui.setElementClipboard(null);
  void writeOS({ coursegen: "slide", slide });
}

async function writeOS(payload: unknown): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload));
  } catch {
    // permission denied / insecure context → in-memory clipboard only
  }
}

async function readOS(): Promise<ElementsPayload | string | null> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "coursegen" in parsed
      ) {
        const p = parsed as { coursegen: string };
        if (p.coursegen === "elements" && Array.isArray((p as ElementsPayload).elements)) {
          return p as ElementsPayload;
        }
        return null; // our slide payload — not element-pasteable
      }
    } catch {
      // not JSON → treat as plain text
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * THE element-paste path (keyboard ⌘V and context-menu Paste): in-memory
 * clipboard first, OS clipboard as fallback (cross-tab / reload), plain
 * text becomes a new text element. Selects what was pasted.
 */
export async function pasteIntoSlide(
  blockId: string,
  slideId: string,
  lessonId: string,
  at?: { x: number; y: number }
): Promise<void> {
  const state = useEditorStore.getState();
  let clip: ElementClipboard | null = useUIStore.getState().elementClipboard;
  let plainText: string | null = null;

  if (!clip || clip.elements.length === 0) {
    const os = await readOS();
    if (os && typeof os === "object") {
      clip = { elements: os.elements, sourceSlideId: os.sourceSlideId };
    } else if (typeof os === "string") {
      plainText = os;
    }
  }

  let patches;
  if (clip && clip.elements.length > 0) {
    patches = pasteElementsPatches(blockId, slideId, clip.elements, {
      sameSlide: clip.sourceSlideId === slideId,
      at,
    });
  } else if (plainText) {
    const hit = findSlide(state.doc, blockId, slideId);
    patches = [
      pasteTextElementPatch(
        blockId,
        slideId,
        plainText,
        hit?.slide.elements.length ?? 0,
        at
      ),
    ];
  } else {
    return;
  }

  // applyMany Zod-validates — malformed/foreign OS payloads are rejected
  // here rather than corrupting the document.
  const result = state.applyMany(patches, "human");
  if (!result.ok) return;
  const ids = patches.flatMap((p) =>
    p.action === "ADD_SLIDE_ELEMENT" ? [p.element.id] : []
  );
  if (ids.length === 1) {
    state.select({ kind: "element", id: ids[0], slideId, blockId, lessonId });
  } else if (ids.length > 1) {
    state.select({ kind: "elements", ids, slideId, blockId, lessonId });
  }
}
