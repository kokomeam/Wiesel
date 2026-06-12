"use client";

/**
 * Inspector section listing the AI actions available for the selected
 * component. Each row submits a preset prompt through the shared pipeline —
 * exactly the same path as typing it into the command bar.
 */

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { suggestionsFor } from "@/lib/course/ai/rules";
import { useEditorStore } from "@/lib/course/store";
import { useAICommand } from "./useAICommand";

export function AIActionMenu() {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const { run, thinking } = useAICommand();

  const suggestions = suggestionsFor(selection, doc);
  if (suggestions.length === 0) return null;

  return (
    <div className="space-y-1">
      {suggestions.map((prompt) => (
        <button
          key={prompt}
          type="button"
          disabled={thinking}
          onClick={() => run(prompt)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-stone-600 transition-colors hover:bg-brand-50 hover:text-brand-700",
            thinking && "animate-pulse opacity-60"
          )}
        >
          <Sparkles className="size-3.5 shrink-0 text-brand-500" />
          {prompt}
        </button>
      ))}
    </div>
  );
}
