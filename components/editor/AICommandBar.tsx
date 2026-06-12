"use client";

/**
 * Contextual AI command bar, docked under the workspace. Suggestion chips and
 * free-text prompts both go through useAICommand → the mock LLM seam → atomic
 * validated patches. The result line confirms what happened and offers Undo.
 * Minimizes to a floating sparkle button so it never hogs vertical space
 * (Cmd/Ctrl+K brings it back and focuses the input).
 */

import { useState } from "react";
import { ArrowUp, Check, ChevronDown, Info, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { suggestionsFor } from "@/lib/course/ai/rules";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { resolveSelection } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import { AI_COMMAND_INPUT_ID } from "./useEditorShortcuts";
import { useAICommand } from "./useAICommand";

export function AICommandBar() {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const lastAIResult = useEditorStore((s) => s.lastAIResult);
  const setLastAIResult = useEditorStore((s) => s.setLastAIResult);
  const undo = useEditorStore((s) => s.undo);
  const collapsed = useUIStore((s) => s.collapsed.aiBar);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const { run, thinking } = useAICommand();
  const [prompt, setPrompt] = useState("");

  const resolved = resolveSelection(doc, selection);
  const suggestions = suggestionsFor(selection, doc);

  async function submit(text: string) {
    if (!text.trim() || thinking) return;
    setPrompt("");
    await run(text);
  }

  if (collapsed) {
    return (
      <button
        type="button"
        {...toolAttrs({
          tool: "expand-ai-bar",
          action: "TOGGLE_PANEL",
          targetType: "panel",
          label: "Open the AI command bar (Cmd+K)",
        })}
        onClick={() => togglePanel("aiBar")}
        title="AI assistant (⌘K)"
        className={cn(
          "absolute bottom-4 right-4 z-30 grid size-11 place-items-center rounded-full brand-gradient text-white",
          "shadow-[0_6px_20px_rgba(124,58,237,0.35)] transition-transform hover:scale-105",
          thinking && "animate-pulse"
        )}
      >
        <Sparkles className="size-5" />
      </button>
    );
  }

  return (
    <div
      data-ai-component="ai-command-bar"
      className="border-t border-stone-200/80 bg-white/85 px-8 pb-4 pt-2.5 backdrop-blur"
    >
      <div className="mx-auto max-w-3xl">
        {lastAIResult && (
          <div
            role="status"
            className={cn(
              "mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs",
              lastAIResult.ok
                ? "bg-brand-50 text-brand-700"
                : "bg-stone-50 text-stone-500"
            )}
          >
            {lastAIResult.ok ? (
              <Check className="size-3.5 shrink-0" />
            ) : (
              <Info className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{lastAIResult.summary}</span>
            {lastAIResult.ok && (
              <button
                type="button"
                onClick={() => {
                  undo();
                  setLastAIResult(null);
                }}
                className="shrink-0 font-medium underline-offset-2 hover:underline"
              >
                Undo
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setLastAIResult(null)}
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
            {resolved ? resolved.typeName.replace(/_/g, " ") : "course"}
          </span>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={thinking}
              onClick={() => submit(s)}
              className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs text-stone-500 transition-colors hover:border-brand-200 hover:text-brand-700 disabled:opacity-50"
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            {...toolAttrs({
              tool: "collapse-ai-bar",
              action: "TOGGLE_PANEL",
              targetType: "panel",
              label: "Minimize the AI command bar",
            })}
            onClick={() => togglePanel("aiBar")}
            className="ml-auto grid size-6 place-items-center rounded-md text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(prompt);
          }}
          className="flex items-center gap-3 rounded-2xl border border-stone-200/80 bg-white py-2 pl-2 pr-2 shadow-[0_4px_16px_rgba(16,24,40,0.06)]"
        >
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-xl brand-gradient text-white",
              thinking && "animate-pulse"
            )}
          >
            <Sparkles className="size-4" />
          </span>
          <input
            id={AI_COMMAND_INPUT_ID}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={thinking}
            placeholder={
              thinking
                ? "Thinking…"
                : `Ask AI to edit ${resolved ? `“${resolved.title}”` : "this course"}…`
            }
            aria-label="AI command"
            className="min-w-0 flex-1 bg-transparent text-sm text-stone-800 outline-none placeholder:text-stone-400"
          />
          <button
            type="submit"
            disabled={!prompt.trim() || thinking}
            aria-label="Send AI command"
            className="grid size-8 shrink-0 place-items-center rounded-xl bg-stone-900 text-white transition-opacity hover:bg-stone-800 disabled:opacity-30"
          >
            <ArrowUp className="size-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
