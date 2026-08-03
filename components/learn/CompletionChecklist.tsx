"use client";

/**
 * The "what's left" card for a trackable lesson. Purely presentational — the
 * items are derived in LearnLessonView from the SAME `lessonTrackables`
 * units the server-side completion rule uses (lib/learn/completion.ts), so
 * this list can never promise something the server won't honor. Completion
 * truth stays server-owned; this only makes the implicit rule legible.
 */

import { CheckCircle2, Circle } from "lucide-react";
import { cn } from "@/lib/cn";

export interface ChecklistItem {
  id: string;
  label: string;
  /** Short live status, e.g. "3/8 slides" · "Watched" · "Try it once". */
  detail: string;
  done: boolean;
}

export function CompletionChecklist({ items }: { items: ChecklistItem[] }) {
  if (items.length === 0) return null;
  const done = items.filter((i) => i.done).length;

  return (
    <section
      aria-label="What's left to finish this lesson"
      className="rounded-2xl border border-stone-200/80 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400">
          To finish this lesson
        </p>
        <p className="text-xs tabular-nums text-stone-400">
          {done}/{items.length} done
        </p>
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2.5 text-sm">
            {item.done ? (
              <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden />
            ) : (
              <Circle className="size-4 shrink-0 text-stone-300" aria-hidden />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                item.done ? "text-stone-400 line-through decoration-stone-300" : "text-stone-700"
              )}
            >
              {item.label}
            </span>
            <span
              className={cn(
                "shrink-0 text-xs tabular-nums",
                item.done ? "font-medium text-emerald-600" : "text-stone-400"
              )}
            >
              {item.detail}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
