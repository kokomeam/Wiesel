"use client";

/**
 * Marketing Agent chat panel. Streams the reason→act→observe loop over SSE,
 * renders assistant text + live tool cards, and surfaces the shared
 * ApprovalCard / QuestionCard inline when the loop blocks on a human (the
 * gate's two pause shapes). Approvals route the same server actions the hub
 * inbox uses; reversible/auto-executed results stay quiet tool lines.
 */

import { memo, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Loader2, Sparkles } from "lucide-react";
import { decodeSSE, type AgentFollowUp } from "@/lib/marketing/agent/events";
import { useApprovalSync } from "@/lib/marketing/approvalSync";
import type { QuestionSpec } from "@/lib/marketing/questions";
import type { PendingActionPayload } from "@/app/(app)/marketing/actions";
import { ApprovalCard } from "@/components/marketing/ApprovalCard";
import { QuestionCard } from "@/components/marketing/QuestionCard";
import {
  ChatPublishCards,
  PUBLISH_CHAT_SUGGESTIONS,
  PUBLISH_CAPABILITY_BLURB,
} from "@/components/marketing/publish/ChatPublishCards";
import type { PublishCardPayload } from "@/components/marketing/publish/PublishApprovalCard";
import { marketingToolLabel, marketingToolRunningCopy, toolStatusLabel } from "./toolCopy";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "observation"; text: string }
  | { kind: "tool"; tool: string; summary: string; status: string }
  | { kind: "approval"; pending: PendingActionPayload }
  | { kind: "question"; questionId: string; question: QuestionSpec }
  | { kind: "publishCards"; cards: PublishCardPayload[] }
  | { kind: "error"; text: string };

// The connected-publishing suggestion strings are imported from the
// allowlisted publish module — this file carries no publish vocabulary of
// its own (AC-MD.5 both-directions fence).
const SUGGESTIONS = [
  "Generate a landing page and a launch sequence",
  "How's my funnel doing?",
  "Draft a followup for people who viewed but didn't enroll",
  ...PUBLISH_CHAT_SUGGESTIONS,
];

/** One transcript row, memoized on item identity (PERF-1 D5, A5 §2.2's
 *  un-memoized map): setItems only ever replaces the entry being updated (the
 *  streaming assistant tail / the resolving tool card), so a per-flush render
 *  re-renders that row alone — settled history bails out. */
const ItemRow = memo(function ItemRow({ it }: { it: Item }) {
  if (it.kind === "user")
    return (
      <div className="ml-auto max-w-[85%] rounded-card bg-brand-50 px-4 py-2.5 text-sm text-brand-900 ring-1 ring-brand-100">
        {it.text}
      </div>
    );
  if (it.kind === "assistant")
    return (
      <div className="max-w-[90%] whitespace-pre-wrap rounded-card bg-white px-4 py-2.5 text-sm text-stone-700 ring-1 ring-stone-200">
        {it.text}
      </div>
    );
  if (it.kind === "observation")
    return (
      <div className="flex items-center gap-2 px-1 text-xs text-stone-500">
        <Sparkles className="size-3.5" /> {it.text}
      </div>
    );
  if (it.kind === "tool")
    return (
      <div className="flex items-start gap-2 rounded-panel border border-stone-200 bg-stone-50/60 px-3 py-2 text-xs">
        <span
          className={
            "mt-0.5 grid size-4 place-items-center rounded " +
            (it.status === "run"
              ? "bg-amber-100 text-amber-700"
              : it.status === "error"
                ? "bg-status-destructive-bg text-status-destructive"
                : it.status === "pending_approval"
                  ? "bg-status-destructive-bg text-status-destructive"
                  : it.status === "needs_clarification"
                    ? "bg-status-pending-bg text-status-pending"
                    : "bg-emerald-100 text-emerald-700")
          }
        >
          {/* UI polish (2026-07-08): accessible text/title on the bare glyphs (glyphs unchanged) */}
          {it.status === "run" ? (
            <Loader2 className="size-3 animate-spin" aria-label="Working" />
          ) : (
            <span role="img" title={toolStatusLabel(it.status)} aria-label={toolStatusLabel(it.status)}>
              {it.status === "needs_clarification" ? "?" : "✓"}
            </span>
          )}
        </span>
        {/* UI polish (2026-07-08): humanized tool name + tool-aware running copy (render only) */}
        <span className="font-medium text-stone-600">{marketingToolLabel(it.tool)}</span>
        <span className="text-stone-500">— {it.status === "run" ? marketingToolRunningCopy(it.tool) : it.summary}</span>
        {it.status === "executed" ? (
          <span className="ml-auto shrink-0 rounded-full bg-status-pending-bg px-2 py-0.5 font-medium text-status-pending ring-1 ring-inset ring-status-pending-ring">
            auto · policy
          </span>
        ) : null}
      </div>
    );
  if (it.kind === "publishCards") return <ChatPublishCards cards={it.cards} />;
  if (it.kind === "approval") return <ApprovalCard pending={it.pending} compact />;
  if (it.kind === "question")
    return (
      <QuestionCard
        questionId={it.questionId}
        question={it.question.question}
        options={it.question.options}
        compact
      />
    );
  return (
    <div className="rounded-panel border border-status-destructive-ring bg-status-destructive-bg px-3 py-2 text-xs text-status-destructive">
      {it.text}
    </div>
  );
});

export function AgentPanel({
  courseId,
  pageId,
  seed,
  onSeedConsumed,
}: {
  courseId: string;
  pageId?: string;
  /** A message queued from outside (the hub ask-bar / dock) — auto-sent once
   *  when it arrives. Parent clears it via onSeedConsumed. */
  seed?: string | null;
  onSeedConsumed?: () => void;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const convoRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seedingRef = useRef(false);
  /** Blockers this transcript rendered ("a:{actionId}" / "q:{questionId}") —
   *  when one resolves (here, on the hub, or in another tab) with an agent
   *  follow-up, the follow-up is replayed into the transcript exactly once. */
  const renderedBlockersRef = useRef(new Set<string>());
  const consumedFollowUpsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!seed || streaming || seedingRef.current) return;
    seedingRef.current = true;
    onSeedConsumed?.();
    void send(seed).finally(() => {
      seedingRef.current = false;
    });
    // send/streaming are stable enough for a one-shot seed; re-running on
    // their identity would double-send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  function push(item: Item) {
    setItems((prev) => [...prev, item]);
    queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  }

  /** Translate a resumed run into transcript items; nested blockers (the
   *  resume paused again) render live cards and register for THEIR follow-up. */
  function replayFollowUp(followUp: AgentFollowUp) {
    if (followUp.conversationId && !convoRef.current) convoRef.current = followUp.conversationId;
    const additions: Item[] = [];
    for (const f of followUp.items) {
      if (f.kind === "observation") additions.push({ kind: "observation", text: f.text });
      else if (f.kind === "assistant") additions.push({ kind: "assistant", text: f.text });
      else if (f.kind === "tool") additions.push({ kind: "tool", tool: f.tool, summary: f.summary, status: f.status });
      else if (f.kind === "error") additions.push({ kind: "error", text: f.text });
      else if (f.kind === "approval") {
        renderedBlockersRef.current.add(`a:${f.actionId}`);
        additions.push({
          kind: "approval",
          pending: {
            actionId: f.actionId,
            toolName: f.tool,
            summary: f.summary,
            preview: f.preview,
            editableParams: null,
            requestedBy: "agent",
          },
        });
      } else if (f.kind === "question") {
        renderedBlockersRef.current.add(`q:${f.questionId}`);
        additions.push({ kind: "question", questionId: f.questionId, question: f.question });
      } else if (f.kind === "publish_cards") {
        for (const c of f.cards) renderedBlockersRef.current.add(`p:${c.approvalId}`);
        additions.push({ kind: "publishCards", cards: f.cards });
      }
    }
    if (additions.length) {
      setItems((prev) => [...prev, ...additions]);
      queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
    }
  }

  // Watch the cross-surface sync store: whichever surface resolves a blocker
  // this transcript shows, the agent's continuation appears HERE (previously
  // the resume ran headlessly and the chat went silent after an approval).
  useEffect(() => {
    const consume = (state: ReturnType<typeof useApprovalSync.getState>) => {
      for (const key of renderedBlockersRef.current) {
        if (consumedFollowUpsRef.current.has(key)) continue;
        const followUp = key.startsWith("a:")
          ? state.actions[key.slice(2)]?.followUp
          : key.startsWith("q:")
            ? state.questions[key.slice(2)]?.followUp
            : state.publishCards[key.slice(2)]?.followUp;
        if (followUp) {
          consumedFollowUpsRef.current.add(key);
          replayFollowUp(followUp);
        }
      }
    };
    consume(useApprovalSync.getState());
    return useApprovalSync.subscribe(consume);
    // replayFollowUp closes over setState + refs only — safe to run once.
  }, []);
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
    // Coalesce assistant_delta frames (PERF-1 D5, A5 §2.2's per-token setItems):
    // buffer and flush at most once per animation frame — 50ms timer fallback,
    // hidden tabs starve rAF — as ONE appendAssistant; every non-delta event
    // flushes first, so transcript order is unchanged. Local to the run — the
    // `streaming` guard means one stream at a time.
    let deltaBuf = "";
    let deltaRaf: number | null = null;
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDeltas = () => {
      if (deltaRaf !== null) {
        cancelAnimationFrame(deltaRaf);
        deltaRaf = null;
      }
      if (deltaTimer !== null) {
        clearTimeout(deltaTimer);
        deltaTimer = null;
      }
      if (!deltaBuf) return;
      const text = deltaBuf;
      deltaBuf = "";
      appendAssistant(text);
    };
    const queueDelta = (text: string) => {
      deltaBuf += text;
      if (deltaRaf !== null || deltaTimer !== null) return;
      deltaRaf = requestAnimationFrame(flushDeltas);
      deltaTimer = setTimeout(flushDeltas, 50);
    };
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
          if (ev.type === "assistant_delta") {
            queueDelta(ev.text);
            continue;
          }
          flushDeltas(); // buffered text lands before any other event's row
          if (ev.type === "conversation") convoRef.current = ev.conversationId;
          else if (ev.type === "observation") push({ kind: "observation", text: ev.summary });
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
          else if (ev.type === "agent_blocked") {
            if (ev.kind === "approval" && ev.actionId) {
              renderedBlockersRef.current.add(`a:${ev.actionId}`);
              push({
                kind: "approval",
                pending: {
                  actionId: ev.actionId,
                  toolName: ev.tool,
                  summary: ev.summary,
                  preview: ev.preview ?? null,
                  editableParams: null, // chat cards defer edits to the hub/builder
                  requestedBy: "agent",
                },
              });
            } else if (ev.kind === "question" && ev.questionId && ev.question) {
              renderedBlockersRef.current.add(`q:${ev.questionId}`);
              push({ kind: "question", questionId: ev.questionId, question: ev.question });
            }
          } else if (ev.type === "publish_cards") {
            if (ev.cards.length) {
              for (const c of ev.cards) renderedBlockersRef.current.add(`p:${c.approvalId}`);
              push({ kind: "publishCards", cards: ev.cards });
            }
          } else if (ev.type === "error") push({ kind: "error", text: ev.message });
          else if (ev.type === "done") router.refresh(); // reflect draft edits in the live preview
        }
      }
    } catch (err) {
      flushDeltas(); // the error row must land after every received token
      push({ kind: "error", text: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      flushDeltas(); // a stream that closes mid-delta still lands its text
      setStreaming(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto scrollbar-thin px-1 py-2">
        {items.length === 0 ? (
          <div className="mx-auto mt-10 max-w-md text-center">
            <span className="brand-gradient grid size-11 place-items-center rounded-card text-white font-display text-xl mx-auto">
              *
            </span>
            <p className="mt-4 text-stone-600">
              I can generate your landing page, sequences, and followups, watch the funnel, and propose
              what to do next. I’ll always ask before anything goes out. {PUBLISH_CAPABILITY_BLURB}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-panel border border-stone-200 bg-white px-3 py-2 text-sm text-stone-600 hover:border-brand-200 hover:bg-brand-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {items.map((it, i) => (
          <ItemRow key={i} it={it} />
        ))}

        {/* UI polish (2026-07-08): transient thinking row while streaming with no
            in-progress assistant/tool item (additive; CSS pulse is frozen by the
            global prefers-reduced-motion guard). */}
        {streaming &&
        !(() => {
          const last = items[items.length - 1];
          return last?.kind === "assistant" || (last?.kind === "tool" && last.status === "run");
        })() ? (
          <div className="flex items-center gap-2 px-1 text-xs text-stone-400" aria-live="polite">
            <span className="size-2 animate-pulse rounded-full bg-brand-400" aria-hidden="true" />
            Thinking…
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="mt-2 flex items-center gap-2 rounded-card border border-stone-200 bg-white p-2 shadow-card"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the agent to generate, analyze, or send…"
          className="flex-1 bg-transparent px-2 text-sm text-stone-900 placeholder:text-stone-500 focus:outline-none"
          disabled={streaming}
        />
        <button
          type="submit"
          disabled={streaming || !input.trim()}
          className="brand-gradient grid size-8 place-items-center rounded-panel text-white disabled:opacity-50"
        >
          {streaming ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </form>
    </div>
  );
}
