"use client";

/**
 * Publish step — a light review destination for the third stepper phase. Shows
 * the readiness checklist and course stats, with a Publish CTA gated on the
 * same minimums as the header button. Visibility/pricing are deferred (no
 * payments yet). Nothing here gates a learner.
 */

import { Check, Rocket } from "lucide-react";
import { cn } from "@/lib/cn";
import { computeCreationFlow } from "@/lib/course/creationFlow";
import { useEditorStore } from "@/lib/course/store";

export function PublishPanel() {
  const doc = useEditorStore((s) => s.doc);
  const flow = computeCreationFlow(doc);
  const lessons = doc.modules.flatMap((m) => m.lessons);
  const blocks = lessons.reduce((n, l) => n + l.blocks.length, 0);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-xl px-6 py-12 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl brand-gradient text-white">
          <Rocket className="size-5" />
        </div>
        <h1 className="mt-4 text-2xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
          {flow.readyToPublish ? "Ready when you are" : "A few things first"}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-stone-500">
          {flow.readyToPublish
            ? "Your course meets the basics to go live. Review and publish whenever you like."
            : "Finish the essentials below, then you can publish. Learners are never blocked by any of this."}
        </p>

        <ul className="mx-auto mt-6 max-w-sm space-y-1 text-left">
          {flow.items.map((item) => (
            <li key={item.id} className="flex items-center gap-2.5 rounded-lg px-3 py-1.5">
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-md border",
                  item.done
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-stone-300"
                )}
              >
                {item.done && <Check className="size-2.5" />}
              </span>
              <span
                className={cn(
                  "text-sm",
                  item.done ? "text-stone-400 line-through" : "text-stone-700"
                )}
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>

        <div className="mx-auto mt-6 flex max-w-sm items-center justify-center gap-6 text-xs text-stone-500">
          <span>
            <b className="text-stone-800">{doc.modules.length}</b> modules
          </span>
          <span>
            <b className="text-stone-800">{lessons.length}</b> lessons
          </span>
          <span>
            <b className="text-stone-800">{blocks}</b> blocks
          </span>
        </div>

        <div className="mt-8">
          <button
            type="button"
            disabled={!flow.readyToPublish}
            title={
              flow.readyToPublish
                ? "Publish your course"
                : "Add a course title and at least one lesson with content to publish"
            }
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white transition-opacity",
              flow.readyToPublish
                ? "brand-gradient hover:opacity-90"
                : "cursor-not-allowed bg-stone-300"
            )}
          >
            <Rocket className="size-4" />
            Publish course
          </button>
          <p className="mt-3 text-[11px] text-stone-400">
            Visibility and pricing are set at publish time. <span className="italic">Coming soon.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
