"use client";

/**
 * The docked AI Content Agent — a Cursor-style chat beside the lesson editor.
 * Streams the agent's work (assistant text + live tool cards), surfaces pending
 * changes in a review bar (Accept / Reject), and takes follow-ups. Conservative,
 * on-brand studio chrome; the ambition lives in the agent behind it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, BarChart3, Check, CheckCheck, ChevronDown, Layers, Lightbulb, ListTree, PanelRightClose, Presentation, ShieldCheck, Sparkles, Square, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { DraftList } from "@/components/comms/DraftList";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { useEditorStore } from "@/lib/course/store";
import { useAgentStore, type QualityReport, type ValidationStatus } from "@/lib/editor/agentStore";
import { useUIStore } from "@/lib/editor/uiStore";
import { useAgentStream } from "./useAgentStream";

/** A calm validation status line ("Found 4 missing slides. Repairing…", "Final
 *  validation passed."). Emerald when the plan was satisfied, amber when the run
 *  fell short, neutral while in progress. */
function ValidationLine({ validation, thinking }: { validation: ValidationStatus; thinking: boolean }) {
  const tone = validation.ok
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : validation.incomplete
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-stone-200 bg-stone-50 text-stone-600";
  return (
    <div className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-xs", tone)}>
      <ShieldCheck className="size-3.5 shrink-0" />
      <span>{validation.message}</span>
      {thinking && !validation.ok && <span className="ml-auto size-1.5 animate-pulse rounded-full bg-current" />}
    </div>
  );
}

/** Soft, OPTIONAL quality findings after a generation. Lint warnings collapse
 *  behind a count; light-review suggestions each get an "Improve" action that
 *  asks the agent to refine that point. Never blocks anything. */
function QualityReportCard({ report, onImprove }: { report: QualityReport; onImprove: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!report.warnings.length && !report.suggestions.length) return null;
  return (
    <div className="rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-stone-700">
        <Lightbulb className="size-3.5 text-amber-500" />
        Quality suggestions
        <span className="ml-auto text-[11px] font-normal text-stone-400">optional</span>
      </div>

      {report.suggestions.length > 0 && (
        <ul className="mt-2 space-y-2">
          {report.suggestions.map((sg, i) => (
            <li key={i} className="rounded-lg bg-stone-50 px-2.5 py-2">
              <p className="font-medium text-stone-700">{sg.title}</p>
              <p className="mt-0.5 text-stone-500">{sg.detail}</p>
              <button
                type="button"
                onClick={() => onImprove(`Please improve this lesson — ${sg.title}: ${sg.detail}`)}
                {...toolAttrs({ tool: "agent-improve-suggestion", action: "AGENT_SEND", label: sg.title })}
                className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-stone-200 px-2 py-0.5 text-[11px] font-medium text-brand-700 transition-colors hover:border-brand-200 hover:bg-brand-50"
              >
                <Sparkles className="size-2.5" />
                Ask AI to improve
              </button>
            </li>
          ))}
        </ul>
      )}

      {report.warnings.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-1 text-[11px] font-medium text-stone-500 hover:text-stone-700"
          >
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            {report.warnings.length} polish note{report.warnings.length === 1 ? "" : "s"}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1 border-l border-stone-200 pl-2.5 text-stone-500">
              {report.warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  get_course_context: "Read course context",
  list_modules: "List modules",
  list_lessons: "List lessons",
  list_course_outline: "Read course outline",
  get_lesson: "Read lesson",
  get_block: "Read block",
  create_module: "Create module",
  create_lesson: "Create lesson",
  rename_lesson: "Rename lesson",
  move_lesson: "Move lesson",
  create_block: "Add block",
  delete_block: "Delete block",
  reorder_blocks: "Reorder blocks",
  write_slide_deck: "Write slide deck",
  write_quiz: "Write knowledge check",
  write_homework: "Write practice",
  write_lecture_text: "Write lecture",
  delete_module: "Delete module",
  delete_lesson: "Delete lesson",
};

const SUGGESTIONS = [
  "Write a 5-slide intro deck for this lesson",
  "Add a 4-question knowledge check",
  "Draft lecture notes from the objective",
];

/** A labeled count chip in the grouped review bar (Structure / Slide / Content),
 *  so structural changes read distinctly from content/slide ones. */
function ChangeGroup({ icon, label, n }: { icon: React.ReactNode; label: string; n: number }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200"
      data-ai-review-group={label}
    >
      <span className="text-amber-500">{icon}</span>
      <span className="font-bold">{n}</span>
      {label}
    </span>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Agent is working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-brand-400"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export function AgentPanel() {
  const messages = useAgentStore((s) => s.messages);
  const toolCards = useAgentStore((s) => s.toolCards);
  const thinking = useAgentStore((s) => s.thinking);
  const error = useAgentStore((s) => s.error);
  const checkpoint = useAgentStore((s) => s.checkpoint);
  const changeSets = useAgentStore((s) => s.changeSets);
  const pendingConfirmation = useAgentStore((s) => s.pendingConfirmation);
  const phase = useAgentStore((s) => s.phase);
  const validation = useAgentStore((s) => s.validation);
  const qualityReport = useAgentStore((s) => s.qualityReport);
  const pendingOutline = useAgentStore((s) => s.pendingOutline);
  const maintenance = useAgentStore((s) => s.maintenance);
  const openFindings = useAgentStore((s) => s.openFindings);
  const autoApprovePlan = useAgentStore((s) => s.autoApprovePlan);
  const setAutoApprovePlan = useAgentStore((s) => s.setAutoApprovePlan);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const { send, resolve, stop } = useAgentStream();

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, toolCards, thinking]);

  const pendingBlocks = useAgentStore((s) => s.pendingBlocks);
  const doc = useEditorStore((s) => s.doc);
  const courseId = useEditorStore((s) => s.courseId);
  const pendingSets = Object.values(changeSets);
  const pendingCount = pendingSets.reduce((n, cs) => n + cs.count, 0);

  // Group the pending changes so STRUCTURE isn't buried inside "N changes": split
  // into Structure (module/lesson ops), Slide (slide_deck blocks) and Content
  // (other blocks). Block type comes from the live doc; a deleted block (gone from
  // the doc) counts as content.
  const groups = useMemo(() => {
    const structure = pendingSets.reduce((n, cs) => n + (cs.structuralCount ?? 0), 0);
    const slideBlockIds = new Set<string>();
    for (const m of doc.modules) for (const l of m.lessons) for (const b of l.blocks) {
      if (b.type === "slide_deck" || b.type === "imported_deck") slideBlockIds.add(b.id);
    }
    let slide = 0;
    let content = 0;
    for (const id of Object.keys(pendingBlocks)) {
      if (slideBlockIds.has(id)) slide++;
      else content++;
    }
    return { structure, slide, content };
  }, [pendingSets, pendingBlocks, doc]);

  const blocked = thinking || !!pendingConfirmation || !!pendingOutline;

  const PHASE_LABEL: Record<string, string> = {
    plan: "Planning",
    generate: "Generating",
    validate: "Checking the plan",
    repair: "Repairing",
    review: "Reviewing",
    critique: "Reviewing",
  };
  const MAINTENANCE_LABEL: Record<string, string> = {
    analyze: "Reading learner analytics",
    findings: "Prioritizing findings",
    remediate: "Proposing fixes",
    comms: "Drafting check-ins",
    report: "Wrapping up",
  };
  const statusText = pendingOutline
    ? "Review the plan"
    : pendingConfirmation
      ? "Paused — needs your OK"
      : maintenance && thinking
        ? `${MAINTENANCE_LABEL[maintenance.stage]}…`
        : phase && thinking
          ? `${PHASE_LABEL[phase]}…`
          : thinking
            ? "Working…"
            : "Ready";

  function submit() {
    if (!input.trim() || blocked) return;
    send(input);
    setInput("");
  }

  async function resolveAll(action: "accept" | "reject") {
    for (const cs of pendingSets) await resolve(cs.id, action);
  }

  const isEmpty = messages.length === 0;

  return (
    <aside
      aria-label="AI Content Agent"
      className="flex w-[360px] shrink-0 flex-col border-l border-stone-200 bg-white"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-stone-200 px-4 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg brand-gradient text-white">
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-stone-800">Content Agent</p>
            {phase && (
              <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-600 ring-1 ring-brand-100">
                {phase}
              </span>
            )}
          </div>
          <p className="text-[11px] text-stone-400">{statusText}</p>
        </div>
        <button
          type="button"
          onClick={() => togglePanel("agentPanel")}
          aria-label="Collapse the agent panel"
          title="Collapse"
          className="ml-auto grid size-7 place-items-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto scrollbar-thin px-4 py-4">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="grid size-11 place-items-center rounded-xl brand-gradient text-white">
              <Sparkles className="size-5" />
            </span>
            <p className="max-w-[16rem] text-sm text-stone-500">
              Ask me to draft slides, a knowledge check, or flesh out lessons. I’ll
              show every change before it sticks.
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  {...toolAttrs({ tool: "agent-suggestion", action: "AGENT_SEND", label: s })}
                  className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "max-w-[88%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed",
                  m.role === "user"
                    ? "ml-auto bg-brand-50 text-brand-900 ring-1 ring-brand-100"
                    : "mr-auto bg-stone-50 text-stone-700"
                )}
              >
                {m.text || (m.streaming ? <TypingDots /> : null)}
              </div>
            ))}

            {toolCards.length > 0 && (
              <div className="space-y-1.5">
                {toolCards.map((c) => (
                  <div
                    key={c.toolCallId}
                    className="flex items-start gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs"
                  >
                    <span
                      className={cn(
                        "mt-px grid size-4 shrink-0 place-items-center rounded",
                        c.status === "done" && "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200",
                        c.status === "running" && "bg-amber-50 text-amber-600 ring-1 ring-amber-200",
                        c.status === "error" && "bg-rose-50 text-rose-600 ring-1 ring-rose-200"
                      )}
                    >
                      {c.status === "done" ? (
                        <Check className="size-2.5" />
                      ) : c.status === "error" ? (
                        <X className="size-2.5" />
                      ) : (
                        <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-stone-700">
                        {TOOL_LABELS[c.tool] ?? c.tool ?? "Working"}
                      </span>
                      {c.summary && <span className="block text-stone-400">{c.summary}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {pendingConfirmation && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                Paused — confirm or cancel the deletion to continue.
              </div>
            )}
            {pendingOutline && (
              <div className="rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2 text-xs text-brand-800">
                A {pendingOutline.kind === "module" ? "module" : "lesson"} plan is ready — review it to continue.
              </div>
            )}
            {validation && <ValidationLine validation={validation} thinking={thinking} />}
            {qualityReport && <QualityReportCard report={qualityReport} onImprove={send} />}
            {maintenance && (
              <div
                className="rounded-xl border border-brand-200 bg-brand-50/50 px-3 py-2.5"
                data-ai-maintenance-status=""
              >
                <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-800">
                  <BarChart3 className="size-3.5" aria-hidden />
                  {maintenance.detail ?? MAINTENANCE_LABEL[maintenance.stage]}
                </p>
                {maintenance.findings.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {maintenance.findings.map((f) => (
                      <li key={f.id} className="flex items-start gap-1.5 text-xs text-stone-600">
                        <span
                          className={cn(
                            "mt-1 size-1.5 shrink-0 rounded-full",
                            f.severity === "high" ? "bg-rose-500" : "bg-amber-400"
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0">{f.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Learner check-in drafts from this run (edit → approve → send;
                    nothing sends without the creator). */}
                {(maintenance.stage === "comms" || maintenance.stage === "report") && (
                  <div className="mt-2">
                    <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.15em] text-stone-400">
                      Messages to review
                    </p>
                    <DraftList courseId={courseId ?? ""} compact />
                  </div>
                )}
              </div>
            )}
            {checkpoint && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {checkpoint}
              </div>
            )}
            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </div>
            )}
          </>
        )}
      </div>

      {/* Review bar — grouped so STRUCTURE changes are never buried in a total. */}
      {pendingCount > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-2.5" data-ai-review-bar="">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-ai-review-groups="">
            {groups.structure > 0 && (
              <ChangeGroup icon={<ListTree className="size-3" />} label="structure" n={groups.structure} />
            )}
            {groups.slide > 0 && (
              <ChangeGroup icon={<Presentation className="size-3" />} label="slide" n={groups.slide} />
            )}
            {groups.content > 0 && (
              <ChangeGroup icon={<Layers className="size-3" />} label="content" n={groups.content} />
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs font-medium text-amber-800">
              <span className="font-bold">{pendingCount}</span> change{pendingCount === 1 ? "" : "s"} to review
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => resolveAll("reject")}
              {...toolAttrs({ tool: "agent-reject-all", action: "REJECT_CHANGES", label: "Reject changes" })}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-white hover:text-stone-700"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => resolveAll("accept")}
              {...toolAttrs({ tool: "agent-accept-all", action: "ACCEPT_CHANGES", label: "Accept changes" })}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
            >
              <CheckCheck className="size-3" />
              {/* Mid-run, accepting locks in what's built so far — lets the user gate
                  out of a long repair loop early. */}
              {thinking ? "Accept what's here" : "Accept all"}
            </button>
          </div>
        </div>
      )}

      {/* Threshold findings invite — the nightly rollup flagged issues; one
          click runs an analysis that adopts them. */}
      {openFindings > 0 && !thinking && !maintenance && (
        <div className="border-t border-stone-200 px-4 py-2.5">
          <button
            type="button"
            onClick={() => send("Analyze the flagged issues in this course.")}
            {...toolAttrs({
              tool: "agent-review-findings",
              action: "AGENT_SEND",
              label: "Review flagged issues",
            })}
            className="flex w-full items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-left text-xs text-amber-800 transition-colors hover:bg-amber-100/70"
          >
            <BarChart3 className="size-3.5 shrink-0 text-amber-600" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-semibold">
                {openFindings} issue{openFindings === 1 ? "" : "s"} flagged
              </span>{" "}
              by learner data — review and propose fixes
            </span>
          </button>
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-stone-200 p-3">
        <label className="mb-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-stone-500">
          <input
            type="checkbox"
            checked={autoApprovePlan}
            onChange={(e) => setAutoApprovePlan(e.target.checked)}
            className="size-3 accent-brand-600"
          />
          Auto-approve the plan (skip the review step)
        </label>
        <div className="flex items-end gap-2 rounded-2xl border border-stone-200 bg-white px-3 py-2 focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={
              pendingConfirmation
                ? "Confirm the deletion to continue…"
                : pendingOutline
                  ? "Approve or discard the plan to continue…"
                  : "Ask the agent, or describe the next change…"
            }
            aria-label="Message the content agent"
            data-ai-tool="agent-input"
            disabled={!!pendingConfirmation || !!pendingOutline}
            className="max-h-32 min-h-[1.5rem] flex-1 resize-none bg-transparent text-[13px] text-stone-700 outline-none placeholder:text-stone-400 disabled:cursor-not-allowed"
          />
          {thinking ? (
            <button
              type="button"
              onClick={stop}
              title="Stop generating"
              {...toolAttrs({ tool: "agent-stop", action: "AGENT_STOP", label: "Stop the agent" })}
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-stone-800 text-white transition-colors hover:bg-stone-900"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim() || blocked}
              {...toolAttrs({ tool: "agent-send", action: "AGENT_SEND", label: "Send message to the agent" })}
              className="grid size-7 shrink-0 place-items-center rounded-lg brand-gradient text-white transition-opacity disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
