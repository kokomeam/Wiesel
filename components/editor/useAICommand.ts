"use client";

/**
 * The one AI pipeline. Command-bar input, suggestion chips, inspector AI
 * actions, and block-level AI buttons all submit prompts through here:
 * prompt → requestAIPatches (the LLM seam) → atomic applyMany → result.
 */

import { useState } from "react";
import { requestAIPatches } from "@/lib/course/ai/mockClient";
import { useEditorStore } from "@/lib/course/store";
import type { Selection } from "@/lib/course/types";

export function useAICommand() {
  const [thinking, setThinking] = useState(false);

  async function run(prompt: string, selectionOverride?: Selection) {
    const { doc, selection, applyMany, setLastAIResult, select } =
      useEditorStore.getState();
    const target = selectionOverride ?? selection;
    if (selectionOverride) select(selectionOverride);
    setThinking(true);
    setLastAIResult(null);
    try {
      const response = await requestAIPatches({ prompt, selection: target, doc });
      if (!response.ok || response.patches.length === 0) {
        setLastAIResult({ ok: false, summary: response.summary });
        return;
      }
      const result = applyMany(response.patches, "ai");
      setLastAIResult(
        result.ok
          ? { ok: true, summary: response.summary }
          : { ok: false, summary: result.error }
      );
    } finally {
      setThinking(false);
    }
  }

  return { run, thinking };
}
