"use client";

/**
 * AI Tutor PREVIEW — a WiseSel-styled chat column for the student home's
 * right rail. Deliberately offline: sending appends the learner's bubble and
 * a canned, deterministic assistant reply that makes clear the tutor ships
 * soon (no network calls, no model). The panel is labeled "Preview" so the
 * affordance is honest, per the no-fake-UI rule.
 */

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { GraduationCap, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/ease";
import { Badge } from "@/components/ui/Badge";

interface TutorMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

const GREETING =
  "Hi! I'm your WiseSel tutor. Soon I'll be able to explain lessons, quiz you, and plan your studying — grounded in the courses you're actually taking. Try a question below to see how it'll feel.";

const SUGGESTIONS = [
  "Explain this lesson simply",
  "Quiz me on what I learned",
  "What should I review next?",
  "Make me a study plan",
] as const;

/** Deterministic canned replies — keyed by intent, with a default. */
const CANNED_REPLIES: Array<{ match: RegExp; reply: string }> = [
  {
    match: /explain/i,
    reply:
      "Love that instinct — asking for the simple version is how the pros learn. When I launch, I'll re-explain any lesson in plain words, with examples pulled from the exact slides you just read. For now, re-opening the lesson's key-concept slides is your best move.",
  },
  {
    match: /quiz\s*me|test\s*me/i,
    reply:
      "Soon I'll generate quick practice questions from any lesson you've finished — and grade them instantly. Until then, the built-in knowledge checks are great reps: retaking a quiz you got wrong is one of the highest-value minutes in learning.",
  },
  {
    match: /review|revisit|weak/i,
    reply:
      "That's exactly what I'm being built for: I'll watch your quiz results and dwell time, then point you at the one lesson that will help most. Meanwhile, check the \"Worth a review\" list on this page — it already ranks your shakiest quizzes worst-first.",
  },
  {
    match: /study\s*plan|schedule|plan/i,
    reply:
      "A study plan is on my roadmap: pick a goal date and I'll pace your remaining lessons and reviews across the week. Until I'm live, a simple rule works wonders — one lesson a day keeps your streak (and your memory) alive.",
  },
];

const DEFAULT_REPLY =
  "Great question — and exactly the kind I'm being trained on. The WiseSel tutor is coming soon: it will answer from your enrolled courses, not the open internet. Until then, your lessons, quizzes, and the review list on this page are the best places to dig in.";

function replyFor(text: string): string {
  for (const { match, reply } of CANNED_REPLIES) {
    if (match.test(text)) return reply;
  }
  return DEFAULT_REPLY;
}

export function TutorPanel({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const [messages, setMessages] = useState<TutorMessage[]>([
    { id: 0, role: "assistant", text: GREETING },
  ]);
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState(false);
  const nextId = useRef(1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest message in view (DOM write only — no state).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Clear a pending reply timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || replying) return;
    const userId = nextId.current++;
    const assistantId = nextId.current++;
    setMessages((prev) => [...prev, { id: userId, role: "user", text: trimmed }]);
    setDraft("");
    setReplying(true);
    timerRef.current = setTimeout(
      () => {
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", text: replyFor(trimmed) },
        ]);
        setReplying(false);
      },
      reduced ? 0 : 550
    );
  }

  return (
    <motion.section
      aria-label="AI tutor preview"
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-stone-100 bg-gradient-to-r from-learn-50/60 to-white px-4 py-3">
        <div className="learn-gradient grid size-8 shrink-0 place-items-center rounded-full text-white">
          <Sparkles className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-stone-900">AI Tutor</p>
          <p className="text-[11px] text-stone-400">Grounded in your courses</p>
        </div>
        <Badge tone="learn">Preview</Badge>
      </div>

      {/* Messages */}
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        className="flex max-h-80 min-h-40 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        {messages.map((message) => (
          <motion.div
            key={message.id}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className={cn(
              "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
              message.role === "assistant"
                ? "self-start rounded-tl-md bg-stone-100 text-stone-700"
                : "learn-gradient self-end rounded-tr-md text-white"
            )}
          >
            {message.text}
          </motion.div>
        ))}
        {replying ? (
          <div
            className="self-start rounded-2xl rounded-tl-md bg-stone-100 px-3.5 py-2.5 text-sm text-stone-400"
            aria-hidden
          >
            …
          </div>
        ) : null}
      </div>

      {/* Suggestion chips */}
      <div className="flex flex-wrap gap-1.5 px-4 pb-3">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => send(suggestion)}
            disabled={replying}
            className="rounded-full border border-learn-200 bg-learn-50 px-3 py-1 text-xs font-medium text-learn-800 transition-colors hover:bg-learn-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-learn-500/40 disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* Composer */}
      <form
        className="flex items-center gap-2 border-t border-stone-100 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <label htmlFor="tutor-preview-input" className="sr-only">
          Ask the tutor
        </label>
        <input
          id="tutor-preview-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about your courses…"
          autoComplete="off"
          className="h-9 min-w-0 flex-1 rounded-full border border-stone-200 bg-stone-50/60 px-3.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-learn-300 focus:outline-none focus:ring-2 focus:ring-learn-500/30"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!draft.trim() || replying}
          className="learn-gradient grid size-9 shrink-0 place-items-center rounded-full text-white shadow-sm shadow-learn-600/25 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-learn-500/40 disabled:opacity-40"
        >
          <Send className="size-4" aria-hidden />
        </button>
      </form>

      {/* Honest footer */}
      <p className="flex items-center gap-1.5 border-t border-stone-100 bg-stone-50/60 px-4 py-2 text-[11px] text-stone-400">
        <GraduationCap className="size-3.5 shrink-0" aria-hidden />
        Preview — replies are canned. The real tutor is coming soon.
      </p>
    </motion.section>
  );
}
