"use client";

/**
 * The agent's PLAN review — a prominent modal mounted at the EDITOR shell level
 * (not inside the collapsible AgentPanel) so a proposed lesson/module plan always
 * surfaces and never scrolls past. Driven by `agentStore.pendingOutline`;
 * Approve runs the generation pipeline, Discard sets it aside. Auto-approve
 * (off by default) skips this entirely server-side.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ClipboardList, X } from "lucide-react";
import { EASE } from "@/lib/ease";
import { useAgentStore } from "@/lib/editor/agentStore";
import { useAgentStream } from "./useAgentStream";

type SlideRow = { label: string; layout: string; depth: string };

function SlideList({ rows }: { rows: SlideRow[] }) {
  return (
    <ol className="space-y-1.5">
      {rows.map((s, i) => (
        <li key={i} className="flex gap-2 text-[13px] leading-snug text-stone-600">
          <span className="shrink-0 font-semibold text-stone-400">{i + 1}.</span>
          <span className="min-w-0">
            <span className="text-stone-800">{s.label}</span>
            <span className="ml-1.5 rounded bg-stone-100 px-1.5 py-px font-mono text-[10px] text-brand-600">{s.layout}</span>
            <span className="ml-1 text-[11px] text-stone-400">· {s.depth}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AgentPlanHost() {
  const pending = useAgentStore((s) => s.pendingOutline);
  const { approvePlan } = useAgentStream();
  const reduce = useReducedMotion();
  const open = !!pending;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void approvePlan("discard");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, approvePlan]);

  if (typeof document === "undefined") return null;

  const isModule = pending?.kind === "module";
  const title = isModule ? "Review the module plan" : "Review the lesson plan";
  const summary = isModule
    ? `${pending.outline.moduleTitle} · ${pending.outline.lessons.length} lesson${pending.outline.lessons.length === 1 ? "" : "s"}`
    : pending
      ? `${pending.outline.slides.length} slides`
      : "";

  return createPortal(
    <AnimatePresence>
      {open && pending && (
        <motion.div
          className="fixed inset-0 z-[100] grid place-items-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.15 }}
          role="presentation"
        >
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => void approvePlan("discard")}
            className="absolute inset-0 cursor-default bg-stone-900/40 backdrop-blur-[2px]"
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: reduce ? 0 : 0.18, ease: EASE }}
            className="relative flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.22)]"
          >
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-stone-100 px-5 py-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl brand-gradient text-white">
                <ClipboardList className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
                <p className="truncate text-[12px] text-stone-500">{summary}</p>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
              {isModule ? (
                <div className="space-y-4">
                  {pending.outline.lessons.map((l, i) => (
                    <div key={i} className="rounded-xl border border-stone-200 p-3">
                      <p className="text-[13px] font-semibold text-stone-800">
                        <span className="text-stone-400">Lesson {i + 1}:</span> {l.title}
                      </p>
                      {l.objective && <p className="mb-2 mt-0.5 text-[12px] text-stone-500">{l.objective}</p>}
                      <SlideList rows={l.slides.map((s) => ({ label: s.concept, layout: s.layout, depth: s.depth }))} />
                    </div>
                  ))}
                </div>
              ) : (
                <SlideList rows={pending.outline.slides.map((s) => ({ label: s.title || s.teachingGoal, layout: s.layout, depth: s.depth }))} />
              )}
            </div>

            {/* Sticky footer */}
            <div className="flex items-center gap-2 border-t border-stone-100 px-5 py-3.5">
              <p className="flex-1 text-[11px] text-stone-400">
                Generated content is staged for review — Accept or Reject after.
              </p>
              <button
                type="button"
                onClick={() => void approvePlan("discard")}
                className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                <X className="size-3.5" />
                Discard
              </button>
              <button
                type="button"
                onClick={() => void approvePlan("approve")}
                className="inline-flex items-center gap-1.5 rounded-full brand-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-sm"
              >
                <Check className="size-3.5" />
                Approve &amp; generate
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
