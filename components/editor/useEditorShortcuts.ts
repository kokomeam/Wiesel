"use client";

/**
 * Global editor keyboard shortcuts (one listener, mounted by the shell):
 *   Cmd/Ctrl + \        toggle both side panels (outline + inspector)
 *   Cmd/Ctrl + .        toggle the inspector
 *   Cmd/Ctrl + K        expand + focus the AI command bar
 *   Cmd/Ctrl + Z        undo · Shift+Cmd/Ctrl+Z redo
 *   Cmd/Ctrl + +/−/0    canvas zoom in / out / reset
 * Typing targets swallow everything except Cmd+K. Element-level keys
 * (arrows/Delete/Cmd+D) live with the stage, popover Escapes live with
 * their popovers.
 */

import { useEffect } from "react";
import { pasteSlidePatch } from "@/lib/course/commands";
import { findSlide } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import { copySlideToClipboards } from "@/lib/editor/clipboard";
import { useUIStore } from "@/lib/editor/uiStore";

export const AI_COMMAND_INPUT_ID = "ai-command-input";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

export function useEditorShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        useUIStore.getState().setPanel("aiBar", false);
        // The bar may need a frame to mount before it can take focus.
        requestAnimationFrame(() => {
          document.getElementById(AI_COMMAND_INPUT_ID)?.focus();
        });
        return;
      }

      if (isTypingTarget(e.target)) return;

      const ui = useUIStore.getState();
      if (e.key === "=" || e.key === "+") {
        e.preventDefault(); // override browser page-zoom inside the editor
        ui.zoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        ui.zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        ui.setZoom(1);
      } else if (e.key === "\\") {
        e.preventDefault();
        const anyOpen = !ui.collapsed.outline || !ui.collapsed.inspector;
        ui.setPanel("outline", anyOpen);
        ui.setPanel("inspector", anyOpen);
      } else if (e.key === ".") {
        e.preventDefault();
        ui.togglePanel("inspector");
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        const editor = useEditorStore.getState();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (e.key.toLowerCase() === "c") {
        // Copy the selected slide (plain text copying is untouched — we only
        // act when a slide is the active selection).
        const editor = useEditorStore.getState();
        if (editor.selection.kind !== "slide") return;
        const hit = findSlide(editor.doc, editor.selection.blockId, editor.selection.id);
        if (hit) {
          e.preventDefault();
          // clears the element clipboard too — the clipboard holds ONE thing
          copySlideToClipboards(hit.slide);
        }
      } else if (e.key.toLowerCase() === "v") {
        const editor = useEditorStore.getState();
        const clipboard = useUIStore.getState().slideClipboard;
        const sel = editor.selection;
        if (!clipboard || (sel.kind !== "slide" && sel.kind !== "element")) return;
        e.preventDefault();
        const blockId = sel.blockId;
        editor.apply(pasteSlidePatch(blockId, clipboard), "human");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
