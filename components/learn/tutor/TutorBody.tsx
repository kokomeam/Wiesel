"use client";

/**
 * TUTOR-1 Wave 4 — the tutor panel BODY (the heavy, next/dynamic-imported
 * surface). Owns the whole conversation UI: the SSE-backed transcript, grounded/
 * supplemental span rendering, citation chips, the scaffolding rung + "Just show
 * me", formative practice cards + self-report, suggestion chips, the composer,
 * the escalation card (dormant behind the flag), and the docked width-drag
 * divider. The streaming/history/vitals plumbing lives in the sibling
 * `useTutorStream` hook — this component is presentation + local interaction.
 *
 * House rules honoured here: warm paper/stone design system; NO framer-motion
 * (reduced motion via a hydration-safe media query); no Date.now()/Math.random()
 * in render (event handlers only); zod-free (types come from tutorClientTypes /
 * useTutorStream, never outputContract/events.ts).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, RotateCw, Send, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useMediaQuery } from "@/lib/ui/useMediaQuery";
import { useTutorStore, type TutorAmbient } from "@/lib/learn/tutorStore";
import {
  gradePracticeAnswer,
  selfReportStableKey,
  type TutorCitation,
  type TutorPracticeItem,
  type TutorSpan,
} from "@/lib/learn/tutorClientTypes";
import { useTutorStream, type TutorChatTurn } from "@/lib/learn/useTutorStream";
import { TutorEscalationCard } from "./TutorEscalationCard";

/** The props contract TutorMount mounts this component with (unchanged from the
 *  package-A placeholder). `onClose` returns focus to the edge tab (TutorMount
 *  owns the requestAnimationFrame focus). */
export interface TutorBodyProps {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  slug: string;
  escalationsUi: boolean;
  onClose: () => void;
}

/** The ambient envelope a `send` carries — the live lesson context. */
type SendAmbient = {
  lessonId: string | null;
  blockId: string | null;
  slideId: string | null;
  quizActive: boolean;
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const DESKTOP = "(min-width: 1024px)";

/** The four static suggestion chips. The "review next" chip's label is a
 *  constant; its SENT message is prefilled from the review queue when available. */
const SUGGESTIONS = [
  { key: "explain", label: "Explain this simply", message: "Explain this simply" },
  { key: "quiz", label: "Quiz me on this lesson", message: "Quiz me on this lesson" },
  { key: "review", label: "What should I review next?", message: "What should I review next?" },
  { key: "plan", label: "Make me a study plan", message: "Make me a study plan" },
] as const;

/* ─────────────────────────────── the body ───────────────────────────────── */

export function TutorBody({
  userId,
  courseId,
  publicationId,
  version,
  slug,
  escalationsUi,
  onClose,
}: TutorBodyProps) {
  const router = useRouter();
  const reduce = useMediaQuery(REDUCED_MOTION);
  const isDesktop = useMediaQuery(DESKTOP);

  // Ambient lives in the store (the lesson page fills it); read the pieces the
  // composer + citation routing + `send` need.
  const ambient = useTutorStore((s) => s.ambient);
  const requestCitation = useTutorStore((s) => s.requestCitation);
  const setSuggestionDot = useTutorStore((s) => s.setSuggestionDot);
  const setUserSlice = useTutorStore((s) => s.setUserSlice);
  const scrollPos = useTutorStore((s) => s.byUser[userId]?.scrollPos ?? 0);

  const { turns, status, historyLoaded, send, retry } = useTutorStream({
    userId,
    courseId,
    publicationId,
    version,
    slug,
  });

  // Consume any pending store seed as the INITIAL composer value (lazy init, so
  // there's no setState-in-effect). The effect below only tells the store the
  // seed was consumed (an external-store update, not a React setState).
  const [draft, setDraft] = useState(() => useTutorStore.getState().seed ?? "");
  // The "review next" message, prefilled from my_review_queue top titles.
  const reviewMessageRef = useRef<string>("What should I review next?");

  /* ── the ambient envelope every `send` carries ── */
  const sendAmbient: SendAmbient = useMemo(
    () => ({
      lessonId: ambient.lessonId,
      blockId: ambient.blockId,
      slideId: ambient.slideId,
      quizActive: ambient.quizActive ?? false,
    }),
    [ambient.lessonId, ambient.blockId, ambient.slideId, ambient.quizActive]
  );

  const busy = status.kind === "thinking" || status.kind === "queued";

  const doSend = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text || busy) return;
      send(text, sendAmbient);
    },
    [send, sendAmbient, busy]
  );

  function submitDraft() {
    if (!draft.trim()) return;
    doSend(draft);
    setDraft("");
  }

  /* ── seed one-shot: the store seed prefills the composer exactly once. The
   *    initial value is read at mount (lazy useState above); this subscription
   *    catches a seed that ARRIVES after mount (e.g. a deep link fired while the
   *    panel is already open) and consumes it — setDraft here fires from an
   *    external-store event, not synchronously inside an effect body. ── */
  useEffect(() => {
    // Drain a seed already present at mount (the lazy init read it, but the
    // store still holds it — clear it so it can't re-prefill on remount).
    if (useTutorStore.getState().seed) useTutorStore.getState().consumeSeed();
    return useTutorStore.subscribe((s, prev) => {
      if (s.seed && s.seed !== prev.seed) {
        setDraft(s.seed);
        s.consumeSeed();
      }
    });
  }, []);

  /* ── suggestion prefill + dot from the review queue (browser RPC, own rows) ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.rpc("my_review_queue", { p_course_id: courseId });
        if (cancelled || !Array.isArray(data) || data.length === 0) return;
        const titles = data
          .map((r: { title?: string | null }) => r.title)
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .slice(0, 3);
        if (titles.length > 0) {
          reviewMessageRef.current = `What should I review next? I've been flagged on: ${titles.join(", ")}.`;
          setSuggestionDot(true);
        }
      } catch {
        /* the queue is best-effort — the chip still works with its default text */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId, setSuggestionDot]);

  /* ── scroll: restore on mount, persist (throttled) on scroll ── */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    // Restore once, after history has rendered (so the saved offset is valid).
    if (restoredRef.current || !historyLoaded) return;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = scrollPos > 0 ? scrollPos : el.scrollHeight;
      restoredRef.current = true;
    }
  }, [historyLoaded, scrollPos]);

  const scrollThrottleRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (scrollThrottleRef.current !== null) return;
    scrollThrottleRef.current = window.setTimeout(() => {
      scrollThrottleRef.current = null;
      const el = scrollRef.current;
      if (el) setUserSlice(userId, { scrollPos: el.scrollTop });
    }, 300);
  }, [setUserSlice, userId]);
  useEffect(() => {
    return () => {
      if (scrollThrottleRef.current !== null) window.clearTimeout(scrollThrottleRef.current);
    };
  }, []);

  // Follow new turns to the bottom while the learner is at/near the bottom (the
  // restore effect owns the FIRST scroll; this keeps up as replies land).
  useEffect(() => {
    if (!restoredRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns, status]);

  /* ── keyboard: Esc closes (focus return owned by TutorMount's onClose) ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* ── overlay (<lg) focus trap: mirror the house Drawer recipe. On desktop the
   *    panel is docked (not modal) so no trap — Tab flows to the lesson. ── */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trapTab = useCallback(
    (e: React.KeyboardEvent) => {
      if (isDesktop || e.key !== "Tab" || !rootRef.current) return;
      const focusables = Array.from(
        rootRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === rootRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [isDesktop]
  );

  return (
    <div ref={rootRef} onKeyDown={trapTab} className="relative flex h-full flex-col">
      {/* Docked width-drag divider (lg+ only). Overlay mode is a fixed sheet. */}
      {isDesktop ? <ResizeHandle userId={userId} setUserSlice={setUserSlice} /> : null}

      <header className="flex items-center justify-between border-b border-stone-200/80 px-4 py-3">
        <h2 className="text-sm font-medium text-stone-800">Course tutor</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tutor"
          data-ai-tool="tutor-close"
          className="grid size-8 place-items-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-thin px-4 py-4"
      >
        {!historyLoaded ? (
          <p className="py-8 text-center text-sm text-stone-400">Loading your conversation…</p>
        ) : turns.length === 0 ? (
          <EmptyState />
        ) : (
          turns.map((turn) => (
            <TurnBubble
              key={turn.id}
              turn={turn}
              ambient={ambient}
              slug={slug}
              escalationsUi={escalationsUi}
              router={router}
              requestCitation={requestCitation}
              courseId={courseId}
              publicationId={publicationId}
              version={version}
              onSend={doSend}
            />
          ))
        )}

        {status.kind === "thinking" ? <ThinkingRow reduce={reduce} /> : null}
        {status.kind === "queued" ? (
          <p className="text-xs text-stone-400">{status.position} ahead of you…</p>
        ) : null}
        {status.kind === "error" ? (
          <div
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50/70 px-3 py-2.5 text-sm text-rose-700"
          >
            <p>{status.message}</p>
            <button
              type="button"
              onClick={retry}
              data-ai-tool="tutor-retry"
              className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-white px-3 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40"
            >
              <RotateCw className="size-3.5" aria-hidden />
              Retry
            </button>
          </div>
        ) : null}
      </div>

      {/* Suggestion chips + composer */}
      <div className="border-t border-stone-200/80 px-4 py-3">
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              data-ai-tool="tutor-suggestion"
              disabled={busy}
              onClick={() => doSend(s.key === "review" ? reviewMessageRef.current : s.message)}
              className="rounded-full border border-stone-200/80 bg-white px-3 py-1 text-xs text-stone-600 transition-colors hover:border-brand-300 hover:text-brand-700 disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitDraft();
              }
            }}
            data-ai-tool="tutor-composer"
            rows={1}
            placeholder="Ask the tutor…"
            className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-2xl border border-stone-200/80 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <button
            type="button"
            onClick={submitDraft}
            disabled={busy || !draft.trim()}
            aria-label="Send message"
            data-ai-tool="tutor-send"
            className="grid size-10 shrink-0 place-items-center rounded-full brand-gradient text-white shadow-sm shadow-brand-600/25 transition-all hover:opacity-95 active:scale-95 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <Send className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── sub-views ──────────────────────────────── */

function EmptyState() {
  return (
    <div className="py-8 text-center">
      <p className="text-sm font-medium text-stone-700">Ask your course tutor anything</p>
      <p className="mx-auto mt-1.5 max-w-[36ch] text-sm leading-relaxed text-stone-500">
        Grounded in this course&apos;s material — it&apos;ll point you back to the exact
        slide or block behind each answer.
      </p>
    </div>
  );
}

function ThinkingRow({ reduce }: { reduce: boolean }) {
  if (reduce) {
    return <p className="text-xs text-stone-400">Thinking…</p>;
  }
  return (
    <div className="flex items-center gap-1.5 text-stone-400" aria-label="Thinking">
      <span className="tutor-dot size-1.5 animate-pulse rounded-full bg-stone-400" />
      <span className="tutor-dot size-1.5 animate-pulse rounded-full bg-stone-400 [animation-delay:150ms]" />
      <span className="tutor-dot size-1.5 animate-pulse rounded-full bg-stone-400 [animation-delay:300ms]" />
    </div>
  );
}

/** One transcript turn — learner right, tutor/instructor left. */
function TurnBubble({
  turn,
  ambient,
  slug,
  escalationsUi,
  router,
  requestCitation,
  courseId,
  publicationId,
  version,
  onSend,
}: {
  turn: TutorChatTurn;
  ambient: TutorAmbient;
  slug: string;
  escalationsUi: boolean;
  router: ReturnType<typeof useRouter>;
  requestCitation: (t: { lessonId: string; blockId: string; slideId: string | null }) => void;
  courseId: string;
  publicationId: string;
  version: number;
  onSend: (message: string) => void;
}) {
  const isLearner = turn.role === "learner";
  const payload = turn.payload ?? null;
  const spans = payload?.spans ?? turn.grounding?.spans ?? null;
  const citations = payload?.citations ?? turn.grounding?.citations ?? [];
  const rung = payload?.rung ?? turn.grounding?.rung ?? null;
  const practiceItems = payload?.practiceItems ?? null;
  const escalation = payload?.escalationProposal ?? null;

  if (isLearner) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 text-sm leading-relaxed text-white">
          {turn.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-stone-200/80 bg-stone-50/80 px-3.5 py-2.5 text-sm leading-relaxed text-stone-800">
        {rung !== null ? <RungBadge rung={rung} /> : null}
        <TutorProse spans={spans} content={turn.content} />
        {citations.length > 0 ? (
          <CitationChips
            citations={citations}
            ambient={ambient}
            slug={slug}
            router={router}
            requestCitation={requestCitation}
          />
        ) : null}
        {/* Always-visible de-scaffold escape hatch on tutor replies. */}
        <button
          type="button"
          data-ai-tool="tutor-just-show-me"
          onClick={() => onSend("just show me")}
          className="mt-2 text-[11px] font-medium text-stone-400 underline decoration-dotted underline-offset-2 transition-colors hover:text-brand-700"
        >
          Just show me
        </button>
      </div>

      {practiceItems && practiceItems.length > 0
        ? practiceItems.map((item) => (
            <PracticeCard
              key={item.practiceItemRef}
              item={item}
              courseId={courseId}
              publicationId={publicationId}
              version={version}
              ambient={ambient}
              onSend={onSend}
            />
          ))
        : null}

      {escalationsUi && escalation ? <TutorEscalationCard proposal={escalation} /> : null}
    </div>
  );
}

/** The 0–4 scaffolding rung badge. */
function RungBadge({ rung }: { rung: number }) {
  const labels = ["Direct answer", "Big hint", "Nudge", "Small nudge", "Socratic"];
  const clamped = Math.max(0, Math.min(4, rung));
  return (
    <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-700 ring-1 ring-inset ring-brand-200/70">
      Rung {rung} · {labels[clamped]}
    </span>
  );
}

/** Render the reply text as grounded/supplemental spans. Supplemental runs get a
 *  tinted left border + a tiny "beyond this course" label. Falls back to the raw
 *  content when no span map is present. */
function TutorProse({ spans, content }: { spans: TutorSpan[] | null; content: string }) {
  if (!spans || spans.length === 0) {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }
  return (
    <div className="space-y-2">
      {spans.map((span, i) =>
        span.kind === "supplemental" ? (
          <div
            key={i}
            className="border-l-2 border-amber-300/80 bg-amber-50/50 py-0.5 pl-2.5 text-stone-700"
          >
            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-amber-600">
              beyond this course
            </span>
            <p className="whitespace-pre-wrap">{span.text}</p>
          </div>
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {span.text}
          </p>
        )
      )}
    </div>
  );
}

/** Citation chips — same-lesson jumps in place (store request → the player);
 *  cross-lesson navigates (keeping the tutor open, its state survives). */
function CitationChips({
  citations,
  ambient,
  slug,
  router,
  requestCitation,
}: {
  citations: TutorCitation[];
  ambient: TutorAmbient;
  slug: string;
  router: ReturnType<typeof useRouter>;
  requestCitation: (t: { lessonId: string; blockId: string; slideId: string | null }) => void;
}) {
  function jump(c: TutorCitation) {
    if (ambient.lessonId && c.lessonId === ambient.lessonId) {
      requestCitation({ lessonId: c.lessonId, blockId: c.blockId, slideId: c.slideId });
    } else {
      const slidePart = c.slideId ? `&slide=${encodeURIComponent(c.slideId)}` : "";
      router.push(`/learn/${slug}/${c.lessonId}?block=${encodeURIComponent(c.blockId)}${slidePart}`);
    }
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {citations.map((c, i) => {
        const sameLesson = ambient.lessonId != null && c.lessonId === ambient.lessonId;
        return (
          <button
            key={`${c.blockId}:${c.slideId ?? ""}:${i}`}
            type="button"
            data-ai-tool="tutor-citation"
            onClick={() => jump(c)}
            className="inline-flex items-center gap-1 rounded-full border border-stone-200/80 bg-white px-2.5 py-0.5 text-[11px] font-medium text-stone-600 transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <ArrowRight className="size-3" aria-hidden />
            {sameLesson ? "Show me" : "Go there"}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────── practice ───────────────────────────────── */

/** A formative practice card. mc = 4 choice buttons; short = input + submit.
 *  Grades locally against the key that rides the item; a keyless item cannot be
 *  graded (no fake verdict) — it offers a "Discuss with the tutor" affordance
 *  that sends the answer into the conversation. On a graded answer it reveals the
 *  verdict + explanation and POSTs practice_answer. Self-report chips ride each
 *  card. */
function PracticeCard({
  item,
  courseId,
  publicationId,
  version,
  ambient,
  onSend,
}: {
  item: TutorPracticeItem;
  courseId: string;
  publicationId: string;
  version: number;
  ambient: TutorAmbient;
  onSend: (message: string) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [verdict, setVerdict] = useState<boolean | null>(null);
  const [graded, setGraded] = useState(false);
  const attemptRef = useRef(0);

  const keyless =
    item.kind === "mc"
      ? item.correctChoiceIndex === null
      : !item.acceptedAnswers || item.acceptedAnswers.length === 0;

  function postSignal(action: string, extra: Record<string, unknown>) {
    // Fire-and-forget — evidence is best-effort; a failure never blocks the UI.
    void fetch("/api/learn/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        courseId,
        publicationId,
        version,
        lessonId: ambient.lessonId,
        nodeId: item.nodeId,
        ...extra,
      }),
    }).catch(() => {});
  }

  function grade(answer: { choiceIndex?: number | null; text?: string | null }) {
    const v = gradePracticeAnswer(item, answer);
    setVerdict(v);
    setGraded(true);
    if (v !== null) {
      attemptRef.current += 1;
      postSignal("practice_answer", {
        practiceItemRef: item.practiceItemRef,
        attemptOrdinal: attemptRef.current,
        evidenceCorrect: v,
      });
    }
  }

  function reportSelf(correct: boolean) {
    // Date.now()/new Date() is fine in an event handler (never in render).
    const stableKey = selfReportStableKey(item.nodeId, ambient.lessonId, new Date().toISOString());
    postSignal("self_report", { evidenceCorrect: correct, stableKey });
  }

  return (
    <div
      data-ai-tool="tutor-practice-card"
      className="w-[92%] rounded-2xl border border-stone-200/80 bg-white p-3 text-sm shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      <p className="font-medium text-stone-800">{item.prompt}</p>

      {item.kind === "mc" && item.choices ? (
        <div className="mt-2.5 space-y-1.5">
          {item.choices.map((choice, i) => {
            const isSel = selected === i;
            const isKey = graded && item.correctChoiceIndex === i;
            const isWrongPick = graded && isSel && verdict === false;
            return (
              <button
                key={i}
                type="button"
                disabled={graded}
                onClick={() => setSelected(i)}
                className={[
                  "block w-full rounded-xl border px-3 py-1.5 text-left transition-colors disabled:cursor-default",
                  isKey
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                    : isWrongPick
                      ? "border-rose-300 bg-rose-50 text-rose-800"
                      : isSel
                        ? "border-brand-300 bg-brand-50 text-brand-800"
                        : "border-stone-200/80 bg-white text-stone-700 hover:border-stone-300",
                ].join(" ")}
              >
                {choice}
              </button>
            );
          })}
          {!graded ? (
            <button
              type="button"
              disabled={selected === null}
              onClick={() => grade({ choiceIndex: selected })}
              className="mt-1 rounded-full bg-stone-900 px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40"
            >
              Check
            </button>
          ) : null}
        </div>
      ) : keyless ? (
        // Keyless short-answer: NO fake grading — send it into the conversation.
        <div className="mt-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="Your answer…"
            className="w-full resize-none rounded-xl border border-stone-200/80 bg-white px-2.5 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => {
              onSend(`Here's my answer to "${item.prompt}": ${text.trim()}`);
              setText("");
            }}
            className="mt-1.5 rounded-full border border-stone-300/80 bg-white px-3.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-40"
          >
            Discuss with the tutor
          </button>
        </div>
      ) : (
        <div className="mt-2.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={graded}
            placeholder="Your answer…"
            className="w-full rounded-xl border border-stone-200/80 bg-white px-2.5 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-stone-50"
          />
          {!graded ? (
            <button
              type="button"
              disabled={!text.trim()}
              onClick={() => grade({ text })}
              className="mt-1.5 rounded-full bg-stone-900 px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40"
            >
              Check
            </button>
          ) : null}
        </div>
      )}

      {graded && verdict !== null ? (
        <div className="mt-2.5 space-y-1.5">
          <p className={verdict ? "text-xs font-medium text-emerald-700" : "text-xs font-medium text-rose-700"}>
            {verdict ? "Correct" : "Not quite"}
          </p>
          {item.explanation ? (
            <p className="text-xs leading-relaxed text-stone-600">{item.explanation}</p>
          ) : null}
        </div>
      ) : null}

      {/* Self-report — always available on a practice card (the tutor learns from
          honest self-assessment even without a gradable key). */}
      <div className="mt-2.5 flex items-center gap-2 border-t border-stone-100 pt-2.5">
        <span className="text-[11px] text-stone-400">How&apos;d that feel?</span>
        <button
          type="button"
          onClick={() => reportSelf(true)}
          className="rounded-full border border-emerald-200 bg-emerald-50/60 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50"
        >
          Got it
        </button>
        <button
          type="button"
          onClick={() => reportSelf(false)}
          className="rounded-full border border-amber-200 bg-amber-50/60 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-50"
        >
          Still shaky
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────── resize handle ──────────────────────────── */

/** The docked-panel width-drag divider (lg+). Pointer-captured drag clamps to
 *  300–520 via the store's own clampWidth (in setUserSlice). One store write per
 *  pointermove is fine — the slice write is cheap + the value is transient. */
function ResizeHandle({
  userId,
  setUserSlice,
}: {
  userId: string;
  setUserSlice: (userId: string, patch: { width?: number }) => void;
}) {
  const draggingRef = useRef(false);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    // The panel is pinned to the right edge; width grows as the pointer moves left.
    const width = window.innerWidth - e.clientX;
    setUserSlice(userId, { width });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize tutor panel"
      data-ai-tool="tutor-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-brand-300/40"
    />
  );
}

export default TutorBody;
