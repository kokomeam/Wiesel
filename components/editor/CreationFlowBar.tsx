"use client";

/**
 * Guided creation-flow strip: a Plan → Create → Publish stepper plus a
 * one-click setup checklist. State is derived from the document (computeCreationFlow)
 * and passed in by the shell. The checklist is a guide, not a gate — it gates
 * nothing for the learner.
 */

import { useState } from "react";
import { Check, ChevronDown, ClipboardList } from "lucide-react";
import { cn } from "@/lib/cn";
import { PHASE_META, type CreationFlowState, type FlowPhase } from "@/lib/course/creationFlow";
import { useEscapeToClose } from "./QualityHintBadge";

const PHASES: FlowPhase[] = ["plan", "create", "publish"];

export function CreationFlowBar({
  flow,
  activeStep,
  onStepClick,
}: {
  flow: CreationFlowState;
  activeStep: FlowPhase;
  onStepClick: (step: FlowPhase) => void;
}) {
  const [open, setOpen] = useState(false);
  useEscapeToClose(open, () => setOpen(false));

  const phaseDone = (p: FlowPhase) =>
    flow.items.filter((i) => i.phase === p).every((i) => i.done);

  return (
    <div className="relative z-20 flex items-center gap-4 border-b border-stone-200 bg-white px-6 py-2">
      {/* Stepper */}
      <ol className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-thin">
        {PHASES.map((p, i) => {
          const done = phaseDone(p);
          const active = activeStep === p;
          return (
            <li key={p} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onStepClick(p)}
                aria-current={active ? "step" : undefined}
                title={`Go to ${PHASE_META[p].label} · ${PHASE_META[p].hint}`}
                className={cn(
                  "flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 transition-colors",
                  active ? "bg-brand-50" : "hover:bg-stone-100"
                )}
              >
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                    done
                      ? "bg-emerald-500 text-white"
                      : active
                        ? "brand-gradient text-white"
                        : "border border-stone-300 bg-white text-stone-400"
                  )}
                >
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                <span
                  className={cn(
                    "whitespace-nowrap text-xs font-medium",
                    active ? "text-brand-700" : done ? "text-stone-700" : "text-stone-500"
                  )}
                >
                  {PHASE_META[p].label}
                </span>
              </button>
              {i < PHASES.length - 1 && (
                <span className="mx-0.5 hidden h-px w-8 bg-stone-200 sm:block" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>

      {/* Setup checklist */}
      <div className="relative shrink-0">
        <button
          type="button"
          aria-expanded={open}
          aria-label="Course setup checklist"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-brand-300 hover:text-brand-700"
        >
          <ClipboardList className="size-3.5 text-stone-400" />
          <span className="hidden sm:inline">Setup</span>
          <span className="tabular-nums text-stone-400">
            {flow.doneCount}/{flow.total}
          </span>
          <span className="hidden h-1 w-12 overflow-hidden rounded-full bg-stone-100 sm:block" aria-hidden>
            <span
              className="block h-full origin-left rounded-full brand-gradient transition-transform"
              style={{ transform: `scaleX(${flow.total ? flow.doneCount / flow.total : 0})` }}
            />
          </span>
          <ChevronDown
            className={cn("size-3.5 text-stone-400 transition-transform", open && "rotate-180")}
          />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-20" aria-hidden onClick={() => setOpen(false)} />
            <div
              role="dialog"
              aria-label="Course setup checklist"
              className="absolute right-0 z-30 mt-2 w-72 rounded-2xl border border-stone-200/80 bg-white p-2 shadow-lg"
            >
              <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                Get your course ready
              </p>
              <ul className="space-y-0.5">
                {flow.items.map((item) => {
                  const isNext = !item.done && item.phase === flow.phase;
                  return (
                    <li
                      key={item.id}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2 py-1.5",
                        isNext && "bg-brand-50"
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded-md border",
                          item.done
                            ? "border-emerald-500 bg-emerald-500 text-white"
                            : isNext
                              ? "border-brand-400"
                              : "border-stone-300"
                        )}
                      >
                        {item.done && <Check className="size-2.5" />}
                      </span>
                      <span
                        className={cn(
                          "text-xs",
                          item.done
                            ? "text-stone-400 line-through"
                            : isNext
                              ? "font-medium text-brand-800"
                              : "text-stone-600"
                        )}
                      >
                        {item.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 border-t border-stone-100 px-2 pt-2 text-[11px] text-stone-400">
                A guide, not a gate — these never block a learner&rsquo;s progress.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
