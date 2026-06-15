"use client";

/**
 * Plan step — the structured brief the AI agents read before generating
 * lessons, slides, and checks. Title/subtitle/audience reuse the existing
 * course-text patches; category/level/outcomes/prerequisites/teaching-style
 * flow through UPDATE_PLAN. Every field commits one patch on blur, so Plan is
 * editable anytime and nothing is ever locked.
 */

import { Sparkles } from "lucide-react";
import { updatePlanPatch, updateTextPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { CourseLevel } from "@/lib/course/types";
import { Segmented } from "../blocks/controls";
import { AddMoreList, PlanTextArea, PlanTextField } from "./planControls";

const levelOptions: { value: CourseLevel; label: string }[] = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-sm font-semibold text-stone-800">{label}</span>
        {optional && (
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
            Optional
          </span>
        )}
      </div>
      {hint && <p className="mb-2 text-xs leading-relaxed text-stone-500">{hint}</p>}
      {children}
    </div>
  );
}

export function PlanPage() {
  const doc = useEditorStore((s) => s.doc);
  const apply = useEditorStore((s) => s.apply);
  const plan = doc.plan;

  const setCourseText = (field: "title" | "description" | "audience", value: string) =>
    apply(updateTextPatch({ kind: "course", field }, value), "human");
  const setPlan = (input: Parameters<typeof updatePlanPatch>[0]) =>
    apply(updatePlanPatch(input), "human");

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-brand-700">
          Plan your course
        </p>
        <h1 className="mt-2 text-[28px] font-light leading-tight tracking-tight text-stone-900 [font-family:var(--font-display)]">
          Brief your AI co-author
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-stone-500">
          These details become the context your AI agents read before drafting lessons, slides,
          and knowledge checks.
        </p>

        {/* AI-grounding helper note — light and encouraging, near the top. */}
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-brand-200/70 bg-gradient-to-br from-brand-50 to-white px-4 py-3 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-600" />
          <p className="text-xs leading-relaxed text-stone-600">
            <span className="font-semibold text-stone-800">
              The more specific you are here, the better the AI works toward what you want.
            </span>{" "}
            Think of it as a creative brief — concrete outcomes, a clear audience, and your
            preferred tone all steer the lessons, slides, and quizzes it generates later. Refine
            it whenever you like; nothing here is locked.
          </p>
        </div>

        <div className="mt-8 space-y-7">
          <Field label="Course title" hint="Clear and specific beats clever.">
            <PlanTextField
              value={doc.title}
              ariaLabel="Course title"
              placeholder="e.g. Intro to Data Visualization"
              maxLength={120}
              onCommit={(v) => setCourseText("title", v)}
            />
          </Field>

          <Field
            label="Subtitle"
            hint="A one-line hook — what is this course, in a sentence?"
            optional
          >
            <PlanTextField
              value={doc.description ?? ""}
              ariaLabel="Course subtitle"
              placeholder="e.g. Turn raw spreadsheets into clear, persuasive charts"
              maxLength={160}
              onCommit={(v) => setCourseText("description", v)}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Category / topic" optional>
              <PlanTextField
                value={plan.category ?? ""}
                ariaLabel="Category or topic"
                placeholder="e.g. Data & analytics"
                onCommit={(v) => setPlan({ plan: { category: v } })}
              />
            </Field>
            <Field label="Level">
              <div className="pt-0.5">
                <Segmented
                  options={levelOptions}
                  value={doc.level ?? "beginner"}
                  aria-label="Course level"
                  onChange={(level) => setPlan({ level })}
                />
              </div>
            </Field>
          </div>

          <Field
            label="Who is this course for?"
            hint="Describe your intended learners — their background, goals, and starting point."
          >
            <PlanTextArea
              value={doc.audience ?? ""}
              ariaLabel="Intended learners"
              placeholder="e.g. Analysts and PMs comfortable in spreadsheets but new to charting."
              rows={3}
              onCommit={(v) => setCourseText("audience", v)}
            />
          </Field>

          <Field
            label="What will learners be able to do?"
            hint="A few concrete outcomes. These directly guide what the AI teaches and tests."
          >
            <AddMoreList
              items={plan.outcomes}
              ariaPrefix="Outcome"
              placeholder="e.g. Choose the right chart type for a given dataset"
              addLabel="Add another outcome"
              onChange={(outcomes) => setPlan({ plan: { outcomes } })}
            />
          </Field>

          <Field
            label="Prerequisites"
            hint="What should learners already know? Keep the barrier low — list only what's truly needed."
            optional
          >
            <AddMoreList
              items={plan.prerequisites}
              ariaPrefix="Prerequisite"
              placeholder="e.g. Comfortable working with spreadsheets"
              addLabel="Add a prerequisite"
              onChange={(prerequisites) => setPlan({ plan: { prerequisites } })}
            />
          </Field>

          <Field
            label="Teaching style & tone"
            hint="How should it sound? This shapes the AI's voice across the whole course."
            optional
          >
            <PlanTextArea
              value={plan.teachingStyle ?? ""}
              ariaLabel="Teaching style and tone"
              placeholder="e.g. Friendly and practical — lead with examples, then the principle."
              rows={2}
              onCommit={(v) => setPlan({ plan: { teachingStyle: v } })}
            />
          </Field>
        </div>

        <p className="mt-9 text-center text-xs text-stone-400">
          Saved to your course as you go. Move on to{" "}
          <span className="font-medium text-stone-500">Create content</span> whenever you&rsquo;re
          ready — or come back and refine this anytime.
        </p>
      </div>
    </div>
  );
}
