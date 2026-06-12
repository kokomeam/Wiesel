"use client";

/**
 * A preset AI action as a quiet brand-tinted pill. Submits its prompt through
 * the same pipeline as the command bar (useAICommand), optionally retargeting
 * the selection first — so "Simplify" on a lecture block works even when
 * something else is selected.
 */

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Selection } from "@/lib/course/types";
import { useAICommand } from "./useAICommand";

export function AIActionButton({
  prompt,
  label,
  selection,
  className,
}: {
  prompt: string;
  label?: string;
  selection?: Selection;
  className?: string;
}) {
  const { run, thinking } = useAICommand();
  return (
    <button
      type="button"
      disabled={thinking}
      onClick={(e) => {
        e.stopPropagation();
        run(prompt, selection);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-100",
        thinking && "animate-pulse opacity-70",
        className
      )}
    >
      <Sparkles className="size-3" />
      {label ?? prompt}
    </button>
  );
}
