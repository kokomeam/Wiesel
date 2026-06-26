"use client";

/**
 * Marketing Agent chat panel. Streams the reason→act→observe loop over SSE,
 * renders assistant text + live tool cards, and surfaces an inline Approve/Deny
 * when the loop pauses at an irreversible action (the gate). Approvals route the
 * same server actions the hub inbox uses.
 */

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Check, Loader2, ShieldAlert, Sparkles } from "lucide-react";
import { decodeSSE } from "@/lib/marketing/agent/events";
import { approvePendingAction, denyPendingAction } from "@/app/(app)/marketing/actions";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "observation"; text: string }
  | { kind: "tool"; tool: string; summary: string; status: string }
  | { kind: "approval"; actionId: string; tool: string; summary: string; resolved?: "approved" | "denied" }
  | { kind: "error"; text: string };

const SUGGESTIONS = [
  "Generate a landing page and a launch sequence",
  "How's my funnel doing?",
  "Draft a followup for people who viewed but didn't enroll",
];

export function AgentPanel({ courseId, pageId }: { courseId: string; pageId?: string }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [, startTransition] = useTransition();
  const convoRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function push(item: Item) {
    setItems((prev) => [...prev, item]);
    queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  }
  function appendAssistant(delta: string) {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "assistant") {
        return [...prev.slice(0, -1), { kind: "assistant", text: last.text + delta }];
      }
      return [...prev, { kind: "assistant", text: delta }];
    });
    queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  }

  async function send(message: string) {
    if (!message.trim() || streaming) return;
    setInput("");
    push({ kind: "user", text: message });
    setStreaming(true);
    try {
      const res = await fetch("/api/marketing/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId, message, conversationId: convoRef.current, pageId }),
      });
      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const ev = decodeSSE(frame);
          if (!ev) continue;
          if (ev.type === "conversation") convoRef.current = ev.conversationId;
          else if (ev.type === "observation") push({ kind: "observation", text: ev.summary });
          else if (ev.type === "assistant_delta") appendAssistant(ev.text);
          else if (ev.type === "tool_start") push({ kind: "tool", tool: ev.tool, summary: "working…", status: "run" });
          else if (ev.type === "tool_result")
            setItems((prev) => {
              // update the most recent running card for this tool
              const idx = [...prev].reverse().findIndex((i) => i.kind === "tool" && i.tool === ev.tool && i.status === "run");
              if (idx >= 0) {
                const realIdx = prev.length - 1 - idx;
                const next = [...prev];
                next[realIdx] = { kind: "tool", tool: ev.tool, summary: ev.summary, status: ev.status };
                return next;
              }
              return [...prev, { kind: "tool", tool: ev.tool, summary: ev.summary, status: ev.status }];
            });
          else if (ev.type === "approval_request")
            push({ kind: "approval", actionId: ev.actionId, tool: ev.tool, summary: ev.summary });
          else if (ev.type === "error") push({ kind: "error", text: ev.message });
          else if (ev.type === "done") router.refresh(); // reflect draft edits in the live preview
        }
      }
    } catch (err) {
      push({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      setStreaming(false);
    }
  }

  function resolve(actionId: string, decision: "approve" | "deny") {
    startTransition(async () => {
      if (decision === "approve") await approvePendingAction(actionId);
      else await denyPendingAction(actionId);
      setItems((prev) =>
        prev.map((i) =>
          i.kind === "approval" && i.actionId === actionId
            ? { ...i, resolved: decision === "approve" ? "approved" : "denied" }
            : i
        )
      );
      router.refresh();
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto scrollbar-thin px-1 py-2">
        {items.length === 0 ? (
          <div className="mx-auto mt-10 max-w-md text-center">
            <span className="brand-gradient grid size-11 place-items-center rounded-2xl text-white [font-family:var(--font-display)] text-xl mx-auto">
              *
            </span>
            <p className="mt-4 text-stone-600">
              I can generate your landing page, sequences, and followups, watch the funnel, and propose
              what to do next. I’ll always ask before anything goes out.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-600 hover:border-brand-200 hover:bg-brand-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {items.map((it, i) => {
          if (it.kind === "user")
            return (
              <div key={i} className="ml-auto max-w-[85%] rounded-2xl bg-brand-50 px-4 py-2.5 text-sm text-brand-900 ring-1 ring-brand-100">
                {it.text}
              </div>
            );
          if (it.kind === "assistant")
            return (
              <div key={i} className="max-w-[90%] whitespace-pre-wrap rounded-2xl bg-white px-4 py-2.5 text-sm text-stone-700 ring-1 ring-stone-200">
                {it.text}
              </div>
            );
          if (it.kind === "observation")
            return (
              <div key={i} className="flex items-center gap-2 px-1 text-xs text-stone-400">
                <Sparkles className="size-3.5" /> {it.text}
              </div>
            );
          if (it.kind === "tool")
            return (
              <div key={i} className="flex items-start gap-2 rounded-xl border border-stone-200 bg-stone-50/60 px-3 py-2 text-xs">
                <span
                  className={
                    "mt-0.5 grid size-4 place-items-center rounded " +
                    (it.status === "run"
                      ? "bg-amber-100 text-amber-700"
                      : it.status === "error"
                        ? "bg-red-100 text-red-700"
                        : it.status === "pending_approval"
                          ? "bg-red-100 text-red-700"
                          : "bg-emerald-100 text-emerald-700")
                  }
                >
                  {it.status === "run" ? <Loader2 className="size-3 animate-spin" /> : "✓"}
                </span>
                <span className="font-mono text-stone-500">{it.tool}</span>
                <span className="text-stone-500">— {it.summary}</span>
              </div>
            );
          if (it.kind === "approval")
            return (
              <div key={i} className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-red-800">
                  <ShieldAlert className="size-4" /> Approval required
                </div>
                <p className="mt-1 text-red-700">{it.summary}</p>
                {it.resolved ? (
                  <p className="mt-2 text-xs font-medium text-stone-500">
                    {it.resolved === "approved" ? "Approved — done." : "Denied."}
                  </p>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => resolve(it.actionId, "approve")}
                      className="brand-gradient inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-white"
                    >
                      <Check className="size-3.5" /> Approve &amp; run
                    </button>
                    <button
                      onClick={() => resolve(it.actionId, "deny")}
                      className="rounded-full border border-stone-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-stone-600"
                    >
                      Deny
                    </button>
                  </div>
                )}
              </div>
            );
          return (
            <div key={i} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {it.text}
            </div>
          );
        })}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="mt-2 flex items-center gap-2 rounded-2xl border border-stone-200 bg-white p-2 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the agent to generate, analyze, or send…"
          className="flex-1 bg-transparent px-2 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none"
          disabled={streaming}
        />
        <button
          type="submit"
          disabled={streaming || !input.trim()}
          className="brand-gradient grid size-8 place-items-center rounded-xl text-white disabled:opacity-50"
        >
          {streaming ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </form>
    </div>
  );
}
