"use client";

/**
 * Course reviews — learner surfaces (Milestone 9).
 *
 * - StarRating: an accessible 1–5 radiogroup rendered as large tappable stars.
 * - ReviewForm: the whole flow — rating first (the only required input), the
 *   comment box appears only AFTER a rating is picked (progressive
 *   disclosure), and on submit the form is REPLACED IN PLACE by a
 *   confirmation ("Thanks — this goes straight to {creator}").
 * - ReviewSlideIn: the non-blocking bottom-right ask near course completion.
 *   Never a modal; "Maybe later" persists a dismissal server-side (re-shown
 *   after a gap, capped — lib/learn/reviews.ts owns that logic).
 * - CourseReviewSection: the persistent course-page block — shows the
 *   existing review with an Edit affordance (pre-populated), or a quiet
 *   inline form while eligible-and-unreviewed.
 *
 * Reviews are DIRECT human input: straight to /api/learn/reviews → the
 * eligibility-gated RPC. No change-set, no approval step.
 *
 * Enter/exit animations are CSS transitions (@starting-style via Tailwind's
 * `starting:` variant + a delayed unmount for the slide-in's exit) instead of
 * framer-motion — this file is statically imported by the /learn/[slug]
 * LANDING (CourseReviewSection + StarRow), and the dep was riding into that
 * route's bundle for three small fades (PERF-1 D3; the ConfirmDialog.tsx
 * rewrite is the in-repo pattern). The globals.css reduced-motion guard
 * zeroes the transition durations, so `prefers-reduced-motion` still
 * collapses every phase to instant.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, PencilLine, Star, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  REVIEW_TEXT_MAX_CHARS,
  shouldShowReviewPrompt,
  type LearnerReview,
  type ReviewPromptState,
} from "@/lib/learn/reviewsShared";
import {
  applyValue,
  confirmValue,
  failValue,
  idleValue,
  resetValue,
  type OptimisticValue,
} from "@/lib/perf/optimistic";

/* ─────────────────────────────── Stars ─────────────────────────────────── */

const STAR_LABELS = ["1 star", "2 stars", "3 stars", "4 stars", "5 stars"];

export function StarRating({
  value,
  onChange,
  name,
  size = "lg",
}: {
  value: number | null;
  onChange: (rating: number) => void;
  /** Distinct radio-group name per mounted instance. */
  name: string;
  size?: "lg" | "sm";
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const shown = hovered ?? value ?? 0;
  return (
    <div
      role="radiogroup"
      aria-label="Rate this course"
      className="flex items-center gap-1"
      onMouseLeave={() => setHovered(null)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <label
          key={n}
          className="cursor-pointer rounded-lg p-0.5 focus-within:ring-2 focus-within:ring-brand-300"
          onMouseEnter={() => setHovered(n)}
        >
          <input
            type="radio"
            name={name}
            value={n}
            checked={value === n}
            onChange={() => onChange(n)}
            className="sr-only"
            aria-label={STAR_LABELS[n - 1]}
          />
          <Star
            aria-hidden
            className={cn(
              size === "lg" ? "size-8" : "size-4",
              "transition-colors",
              n <= shown ? "fill-amber-400 text-amber-400" : "fill-transparent text-stone-300"
            )}
          />
        </label>
      ))}
    </div>
  );
}

/** Read-only star row (confirmation + display states). */
export function StarRow({ rating, size = "sm" }: { rating: number; size?: "lg" | "sm" }) {
  return (
    <span
      className="inline-flex items-center gap-0.5"
      role="img"
      aria-label={STAR_LABELS[Math.min(5, Math.max(1, rating)) - 1]}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden
          className={cn(
            size === "lg" ? "size-6" : "size-4",
            n <= rating ? "fill-amber-400 text-amber-400" : "fill-transparent text-stone-300"
          )}
        />
      ))}
    </span>
  );
}

/* ─────────────────────────────── Form ──────────────────────────────────── */

export function ReviewForm({
  courseId,
  creatorName,
  initial,
  idPrefix,
  onSubmitted,
}: {
  courseId: string;
  creatorName: string;
  initial: LearnerReview | null;
  /** Unique per mount — star radio-group name + textarea id. */
  idPrefix: string;
  onSubmitted?: (review: LearnerReview) => void;
}) {
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null);
  const [text, setText] = useState(initial?.reviewText ?? "");
  // OPTIMISTIC submit (PERF-1 B3): value = the review shown as submitted (null
  // while the form is up). Apply renders the confirmation IMMEDIATELY; a
  // failure rolls back to the form with an inline error. Pure transitions in
  // lib/perf/optimistic.ts; `onSubmitted` fires only on server CONFIRM (the
  // parent stores the review as saved truth — never the optimistic copy).
  const [submitState, setSubmitState] = useState<OptimisticValue<LearnerReview | null>>(() =>
    idleValue<LearnerReview | null>(null)
  );
  const done = submitState.value;
  const error = submitState.error;

  async function submit() {
    if (rating === null || submitState.inFlight) return; // double-fire guard
    const optimistic: LearnerReview = {
      rating,
      reviewText: text.trim() ? text.trim() : null,
      updatedAt: new Date().toISOString(),
    };
    const { state, op } = applyValue(submitState, optimistic);
    setSubmitState(state);
    try {
      const res = await fetch("/api/learn/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          courseId,
          rating,
          reviewText: text.trim() ? text.trim() : null,
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { review?: LearnerReview; error?: string }
        | null;
      if (!res.ok || !payload?.review) {
        throw new Error(payload?.error ?? "Couldn't save your review — try again.");
      }
      setSubmitState((s) => confirmValue(s, op, payload.review));
      onSubmitted?.(payload.review);
    } catch (err) {
      setSubmitState((s) =>
        failValue(s, op, err instanceof Error ? err.message : "Something went wrong")
      );
    }
  }

  if (done) {
    // Confirmation replaces the form in place — their rating reflected back.
    // Enter-only fade/scale via @starting-style (it never exits animated).
    return (
      <div
        className="flex origin-left scale-100 items-start gap-3 opacity-100 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-[0.96] starting:opacity-0"
        data-ai-id="review-confirmation"
      >
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" aria-hidden />
        <div>
          <StarRow rating={done.rating} />
          <p className="mt-1 text-sm text-stone-600">
            Thanks — this goes straight to {creatorName}.
          </p>
          <button
            type="button"
            onClick={() => setSubmitState((s) => resetValue(s, null))}
            className="mt-1 text-xs font-medium text-stone-400 underline-offset-2 hover:text-stone-600 hover:underline"
          >
            Edit your review
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-ai-id="review-form">
      <StarRating
        value={rating}
        onChange={setRating}
        name={`${idPrefix}-stars`}
      />
      {/* Progressive disclosure: no visible text field before a rating.
          Height-auto enter animation via the grid-rows trick + @starting-style
          (0fr → 1fr); un-rating never happens mid-session, so exit is an
          instant unmount. */}
      {rating !== null ? (
        <div className="grid grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] starting:grid-rows-[0fr] starting:opacity-0">
          <div className="overflow-hidden">
            <label className="mt-3 block">
              <span className="sr-only">Anything you want the creator to know? (optional)</span>
              <textarea
                id={`${idPrefix}-text`}
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, REVIEW_TEXT_MAX_CHARS))}
                rows={3}
                placeholder="Anything you want the creator to know? (optional)"
                className="w-full resize-y rounded-xl border border-stone-200 px-3 py-2 text-sm leading-relaxed text-stone-700 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200/60"
              />
            </label>
            {error ? <p className="mt-1 text-xs font-medium text-rose-600">{error}</p> : null}
            <button
              type="button"
              onClick={() => void submit()}
              className="brand-gradient mt-2 rounded-full px-5 py-2 text-sm font-semibold text-white shadow-sm shadow-brand-600/25 transition-opacity hover:opacity-95"
              data-ai-tool="review-submit"
            >
              {initial ? "Update review" : "Send review"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── Slide-in ask ────────────────────────────── */

export function ReviewSlideIn({
  courseId,
  courseTitle,
  state,
}: {
  courseId: string;
  courseTitle: string;
  /** The server-loaded prompt state; the show/gap/cap decision runs here in
   *  an effect (react-hooks/purity forbids Date.now() in render — even in the
   *  server component that loads the state). */
  state: ReviewPromptState;
}) {
  const creatorName = state.creatorName;
  const [visible, setVisible] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Delayed unmount for the exit transition (the ConfirmDialog pattern): the
  // aside stays in the DOM for the 400ms slide-out, then unmounts.
  const [rendered, setRendered] = useState(false);
  // OPTIMISTIC dismiss (PERF-1 B3): value = closed. "Maybe later" closes the
  // ask immediately; a failed persist re-surfaces it with an inline error
  // (otherwise the server-side gap/cap logic would silently forget the
  // dismissal). The post-submit X is a purely local close (nothing persists).
  const [dismiss, setDismiss] = useState<OptimisticValue<boolean>>(() => idleValue(false));
  const closed = dismiss.value;

  // Appear a beat after the page settles — post-action, never blocking. The
  // decision runs inside the timer callback (the DraftList deferred-setState
  // pattern; wall-clock reads are legal outside render).
  useEffect(() => {
    const t = setTimeout(() => setVisible(shouldShowReviewPrompt(state, Date.now())), 1200);
    return () => clearTimeout(t);
  }, [state]);

  async function maybeLater() {
    if (dismiss.inFlight) return; // double-fire guard
    const { state: next, op } = applyValue(dismiss, true);
    setDismiss(next);
    try {
      const res = await fetch("/api/learn/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", courseId }),
        keepalive: true,
      });
      if (!res.ok) throw new Error("dismiss failed");
      setDismiss((s) => confirmValue(s, op));
    } catch {
      setDismiss((s) => failValue(s, op, "Couldn't save that — try again."));
    }
  }

  const open = visible && !closed;
  // Render-phase mount latch (React-19-safe; the ConfirmDialog pattern) —
  // the aside mounts the same render `open` flips true, so @starting-style
  // sees a real first frame.
  if (open && !rendered) setRendered(true);
  useEffect(() => {
    if (open || !rendered) return;
    const t = setTimeout(() => setRendered(false), 400);
    return () => clearTimeout(t);
  }, [open, rendered]);

  if (!rendered) return null;
  return (
    <aside
          role="complementary"
          aria-label="Rate this course"
          className={cn(
            "fixed bottom-5 right-5 z-40 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_16px_40px_rgba(68,48,28,0.14)]",
            "transition-[opacity,transform] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            open
              ? "translate-y-0 opacity-100 starting:translate-y-6 starting:opacity-0"
              : "pointer-events-none translate-y-6 opacity-0"
          )}
          data-ai-id="review-slide-in"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold text-stone-800">
              How was “{courseTitle}”?
            </p>
            <button
              type="button"
              aria-label="Close"
              onClick={() => (submitted ? setDismiss((s) => resetValue(s, true)) : void maybeLater())}
              className="grid size-6 shrink-0 place-items-center rounded-md text-stone-400 hover:bg-stone-100"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="mt-3">
            <ReviewForm
              courseId={courseId}
              creatorName={creatorName}
              initial={null}
              idPrefix="review-slidein"
              onSubmitted={() => setSubmitted(true)}
            />
          </div>
          {!submitted ? (
            <button
              type="button"
              onClick={() => void maybeLater()}
              className="mt-3 text-xs font-medium text-stone-400 underline-offset-2 hover:text-stone-600 hover:underline"
              data-ai-tool="review-maybe-later"
            >
              Maybe later
            </button>
          ) : null}
          {dismiss.error ? (
            <p className="mt-2 text-xs font-medium text-rose-600">{dismiss.error}</p>
          ) : null}
    </aside>
  );
}

/* ─────────────────────── Course-page review section ────────────────────── */

export function CourseReviewSection({
  courseId,
  creatorName,
  review,
  eligible,
}: {
  courseId: string;
  creatorName: string;
  review: LearnerReview | null;
  eligible: boolean;
}) {
  // "display" shows the saved review; "form" hosts ReviewForm, whose own
  // in-place confirmation covers the just-submitted moment (we deliberately
  // do NOT flip back to display on submit — that would clobber the
  // "Thanks — this goes straight to…" beat with a stale server prop).
  const [current, setCurrent] = useState<LearnerReview | null>(review);
  const [mode, setMode] = useState<"display" | "form">(review ? "display" : "form");
  if (!review && !eligible) return null;

  return (
    <section
      className="mt-16 rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)] sm:mt-20"
      aria-label="Your review"
    >
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-700">
        Your review
      </p>
      {mode === "display" && current ? (
        <div className="mt-3 flex items-start justify-between gap-4">
          <div>
            <StarRow rating={current.rating} size="lg" />
            {current.reviewText ? (
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-stone-600">
                {current.reviewText}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-stone-400">
              Only {creatorName} sees this.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMode("form")}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-600 hover:border-brand-200 hover:bg-brand-50/50 hover:text-brand-700"
            data-ai-tool="review-edit"
          >
            <PencilLine className="size-3.5" aria-hidden />
            Edit
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <ReviewForm
            courseId={courseId}
            creatorName={creatorName}
            initial={current}
            idPrefix="review-section"
            onSubmitted={setCurrent}
          />
        </div>
      )}
    </section>
  );
}
