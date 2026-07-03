"use client";

/**
 * Read-only learner renderers for the text-ish block types. The editor's
 * components for these are all editors (InlineText + patches), so the student
 * runtime renders the same content shapes with zero editing affordances.
 * Hints and solutions are self-serve reveals — practice here is low-stakes by
 * design, so a learner may check their own work.
 */

import { useState } from "react";
import { ExternalLink, Lightbulb, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import type {
  ExampleBlock,
  ExerciseBlock,
  LectureTextBlock,
  ResourceBlock,
} from "@/lib/course/types";

export function LearnLecture({ block }: { block: LectureTextBlock }) {
  return (
    <div className="space-y-4">
      {block.paragraphs.map((p) => (
        <p
          key={p.id}
          className={cn(
            "text-[15px] leading-relaxed text-stone-700",
            p.kind === "key_idea" &&
              "rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 font-medium text-stone-800",
            p.kind === "aside" && "border-l-2 border-stone-200 pl-4 text-sm italic text-stone-500"
          )}
        >
          {p.text}
        </p>
      ))}
    </div>
  );
}

export function LearnExample({ block }: { block: ExampleBlock }) {
  return (
    <div className="space-y-4">
      {block.context ? (
        <p className="text-sm font-medium text-stone-500">{block.context}</p>
      ) : null}
      <p className="text-[15px] leading-relaxed text-stone-700">{block.explanation}</p>
      {block.steps.length > 0 ? (
        <ol className="space-y-2">
          {block.steps.map((step, i) => (
            <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-stone-700">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-semibold text-stone-500">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {block.takeaway ? (
        <p className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-sm font-medium text-emerald-800">
          {block.takeaway}
        </p>
      ) : null}
    </div>
  );
}

export function RevealPanel({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-stone-300/80 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
      >
        {icon}
        {open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
      </button>
      {open ? (
        <div className="mt-3 rounded-xl border border-stone-200/80 bg-stone-50/70 px-4 py-3 text-sm leading-relaxed text-stone-700">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function LearnExercise({ block }: { block: ExerciseBlock }) {
  return (
    <div className="space-y-4">
      <p className="text-[15px] leading-relaxed text-stone-700">{block.prompt}</p>
      <div className="flex flex-wrap gap-4">
        {block.hint ? (
          <RevealPanel label="Hint" icon={<Lightbulb className="h-3.5 w-3.5" aria-hidden />}>
            {block.hint}
          </RevealPanel>
        ) : null}
        {block.solution ? (
          <RevealPanel label="Solution" icon={<Sparkles className="h-3.5 w-3.5" aria-hidden />}>
            {block.solution}
          </RevealPanel>
        ) : null}
      </div>
    </div>
  );
}

export function LearnResource({ block }: { block: ResourceBlock }) {
  return (
    <ul className="space-y-2">
      {block.links.map((link) => (
        <li key={link.id}>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            className="group flex items-start gap-2 rounded-xl border border-stone-200/80 bg-white px-4 py-3 transition-colors hover:border-brand-200 hover:bg-brand-50/40"
          >
            <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-stone-400 group-hover:text-brand-600" aria-hidden />
            <span>
              <span className="block text-sm font-medium text-stone-800">{link.label}</span>
              {link.note ? (
                <span className="block text-xs text-stone-500">{link.note}</span>
              ) : null}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
