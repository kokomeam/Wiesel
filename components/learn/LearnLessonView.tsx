"use client";

/**
 * The lesson player body: renders the published blocks IN ORDER with zero
 * editing chrome, wires each trackable block's signals into
 * /api/learn/progress, and surfaces live completion state. The completion
 * rule itself is pure + shared (lib/learn/completion.ts) — this component
 * only decides WHICH control to show (e.g. "Mark complete" appears exactly
 * when the lesson has no trackable units); the server remains the judge.
 *
 * Liveness layer (2026-07-08): a local per-unit state (seeded from the
 * server's progress_state + attempt counts, advanced by the same callbacks
 * that report to the server) powers the sticky micro-progress bar and the
 * CompletionChecklist. `unitView` MIRRORS lib/learn/completion.ts
 * `unitFraction` (not exported; lib is out of this surface's lane) — it is
 * display-only and never asserts completion: the completed flip still comes
 * exclusively from the server's recomputed snapshot via `absorb`.
 *
 * ⚠ Interactive/tracked blocks (slides, video, quiz, homework, imported
 * decks) must stay permanently mounted — dwell tracking + progress reporting
 * hang off their mount/unmount lifecycle. Only TEXT blocks are collapsible
 * (CollapsibleBlock keeps even those mounted).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  BookOpen,
  CheckCircle2,
  Dumbbell,
  HelpCircle,
  Layers,
  Lightbulb,
  Link2,
  PenLine,
  PlayCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { PublishedLesson } from "@/lib/course/publish/schemas";
import type { DeckImportView } from "@/lib/course/imports/deckImportTypes";
import { lessonTrackables, VIDEO_COMPLETE_PCT, type TrackableUnit } from "@/lib/learn/completion";
import type { LearnerVideoData } from "@/lib/learn/media";
import type { LessonProgressSnapshot, ProgressState } from "@/lib/learn/schemas";
import { useTutorStore } from "@/lib/learn/tutorStore";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useAnalytics } from "./AnalyticsProvider";
import { CollapsibleBlock } from "./CollapsibleBlock";
import { CompletionChecklist, type ChecklistItem } from "./CompletionChecklist";
import type { PriorSubmission } from "./LearnHomework";
import { LearnImportedDeck } from "./LearnImportedDeck";
import { LearnQuiz } from "./LearnQuiz";
import { LearnSlideDeck, type SlideFeedbackMap } from "./LearnSlideDeck";
import { LearnVideo } from "./LearnVideo";
import { LearnExample, LearnExercise, LearnLecture, LearnResource } from "./readOnlyBlocks";
import { reportProgress } from "./progressClient";

// framer-motion stays out of the critical lesson bundle — the celebration
// only ever renders after a client-side completion transition.
const LessonCelebration = dynamic(
  () => import("./LessonCelebration").then((m) => m.LessonCelebration),
  { ssr: false }
);

// supabase-js (~55 KB gz — the homework file-upload path) loads only for
// lessons that actually contain a homework block (PERF-1 D1). The loading
// box matches the block card's footprint so nothing shifts.
const LearnHomework = dynamic(
  () => import("./LearnHomework").then((m) => m.LearnHomework),
  {
    loading: () => (
      <div className="h-40 animate-pulse rounded-2xl border border-stone-200/70 bg-stone-100/60" />
    ),
  }
);

/* ───────────────────────── Block identity (chips) ──────────────────────── */

const BLOCK_META: Record<string, { label: string; icon: LucideIcon; interactive?: boolean }> = {
  slide_deck: { label: "Slides", icon: Layers },
  imported_deck: { label: "Slides", icon: Layers },
  video: { label: "Video", icon: PlayCircle },
  lecture_text: { label: "Reading", icon: BookOpen },
  quiz: { label: "Knowledge check", icon: HelpCircle, interactive: true },
  homework: { label: "Homework", icon: PenLine, interactive: true },
  exercise: { label: "Practice", icon: Dumbbell },
  example: { label: "Worked example", icon: Lightbulb },
  resource: { label: "Resources", icon: Link2 },
};

/** Text-only blocks — the ONLY types safe to collapse (no tracking hooks). */
const TEXT_BLOCK_TYPES = new Set(["lecture_text", "example", "exercise", "resource"]);

function BlockChip({ icon: Icon, interactive }: { icon: LucideIcon; interactive?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg",
        interactive ? "bg-learn-50 text-learn-600" : "bg-stone-100 text-stone-500"
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/* ─────────────────────── Live per-unit progress view ───────────────────── */

interface LiveUnitState {
  viewedSlides: Record<string, string[]>;
  videoPct: Record<string, number>;
  viewedBlocks: string[];
  attemptedQuizzes: string[];
}

/**
 * Display MIRROR of lib/learn/completion.ts `unitFraction` — same math per
 * unit kind (slides seen/total · video min(pct/90, 1) · binary units). Keep
 * the two in sync; the server verdict always wins via `absorb`.
 */
function unitView(
  unit: TrackableUnit,
  state: LiveUnitState
): { fraction: number; detail: string; fallbackLabel: string } {
  switch (unit.kind) {
    case "slides": {
      const viewed = new Set(state.viewedSlides[unit.blockId] ?? []);
      const total = unit.slideIds.length;
      const seen = unit.slideIds.filter((id) => viewed.has(id)).length;
      return {
        fraction: total === 0 ? 1 : seen / total,
        detail: seen >= total ? "All slides viewed" : `${seen}/${total} slides`,
        fallbackLabel: "Slides",
      };
    }
    case "imported_deck": {
      const done = state.viewedBlocks.includes(unit.blockId);
      return {
        fraction: done ? 1 : 0,
        detail: done ? "Viewed" : "Page to the end",
        fallbackLabel: "Slides",
      };
    }
    case "video": {
      const pct = state.videoPct[unit.blockId] ?? 0;
      const fraction = Math.min(pct / VIDEO_COMPLETE_PCT, 1);
      return {
        fraction,
        detail:
          fraction >= 1
            ? "Watched"
            : pct > 0
              ? `${Math.round(pct)}% watched`
              : `Watch to ${VIDEO_COMPLETE_PCT}%`,
        fallbackLabel: "Video",
      };
    }
    case "quiz": {
      const done = state.attemptedQuizzes.includes(unit.blockId);
      return {
        fraction: done ? 1 : 0,
        detail: done ? "Attempted" : "Try it once",
        fallbackLabel: "Knowledge check",
      };
    }
  }
}

/* ──────────────────────────────── View ─────────────────────────────────── */

export interface LessonProgressView {
  status: "not_started" | "in_progress" | "completed";
  pct: number;
}

export function LearnLessonView({
  courseId,
  publicationId,
  lesson,
  role,
  userId,
  videoData,
  deckViews,
  quizAttemptCounts,
  homeworkSubmissions,
  initialProgress,
  initialProgressState = null,
  slideFeedback = {},
  courseTitle,
  lessonNumber,
  lessonCount,
  nextLesson,
  courseHref,
  onProgressChange,
  tutorEnvelope,
  initialFocus,
}: {
  courseId: string;
  publicationId: string;
  lesson: PublishedLesson;
  role: "student" | "author";
  userId: string;
  videoData: Record<string, LearnerVideoData | null>;
  deckViews: Record<string, DeckImportView | null>;
  quizAttemptCounts: Record<string, number>;
  homeworkSubmissions: Record<string, PriorSubmission[]>;
  initialProgress: LessonProgressView | null;
  /** The learner's stored progress_state for THIS lesson (server-loaded) —
   *  seeds the live checklist so prior sessions show as already done. */
  initialProgressState?: ProgressState | null;
  /** M10: slideId → the learner's latest reaction (my_slide_feedback RPC). */
  slideFeedback?: SlideFeedbackMap;
  courseTitle: string;
  /** 1-based position of this lesson in course order. */
  lessonNumber: number;
  lessonCount: number;
  /** Null on the last lesson — the celebration CTA falls back to the course. */
  nextLesson: { title: string; href: string } | null;
  courseHref: string;
  onProgressChange?: (progress: LessonProgressView) => void;
  /** TUTOR-1 W4: the publication envelope for the tutor bus. `version` isn't
   *  otherwise a prop here; the page passes it (with courseId/publicationId for
   *  self-containment). Absent ⇒ the bus stays inert (author-preview / no
   *  tutor). */
  tutorEnvelope?: { courseId: string; publicationId: string; version: number };
  /** TUTOR-1 W4: a deep-link focus target (from ?block=&slide=) — scrolls to
   *  the block and jumps the deck once on mount. */
  initialFocus?: { blockId: string; slideId: string | null };
}) {
  const isStudent = role === "student";
  const [progress, setProgress] = useState<LessonProgressView>(
    initialProgress ?? { status: "not_started", pct: 0 }
  );
  const [markBusy, setMarkBusy] = useState(false);

  const absorb = useCallback(
    (snapshot: LessonProgressSnapshot | null | undefined) => {
      if (!snapshot || snapshot.lessonId !== lesson.id) return;
      const next: LessonProgressView = { status: snapshot.status, pct: snapshot.pct };
      setProgress(next);
      onProgressChange?.(next);
    },
    [lesson.id, onProgressChange]
  );

  const { track } = useAnalytics();

  useEffect(() => {
    if (!isStudent) return;
    track({ eventType: "lesson_started" });
    void reportProgress(courseId, { action: "lesson_opened", lessonId: lesson.id }).then(absorb);
  }, [isStudent, courseId, lesson.id, absorb, track]);

  const trackables = useMemo(() => lessonTrackables(lesson), [lesson]);
  const showMarkComplete = isStudent && trackables.length === 0;

  // Live unit state: seeded from the server, advanced by the SAME handlers
  // that report to /api/learn/progress (display only — never authoritative).
  const [unitState, setUnitState] = useState<LiveUnitState>(() => ({
    viewedSlides: initialProgressState?.viewedSlides ?? {},
    videoPct: initialProgressState?.videoPct ?? {},
    viewedBlocks: initialProgressState?.viewedBlocks ?? [],
    attemptedQuizzes: Object.entries(quizAttemptCounts)
      .filter(([, n]) => n > 0)
      .map(([id]) => id),
  }));

  const noteSlidesViewed = useCallback((blockId: string, slideIds: string[]) => {
    setUnitState((s) => {
      const prev = s.viewedSlides[blockId] ?? [];
      const merged = new Set(prev);
      for (const id of slideIds) merged.add(id);
      if (merged.size === prev.length) return s;
      return { ...s, viewedSlides: { ...s.viewedSlides, [blockId]: [...merged] } };
    });
  }, []);
  const noteVideoPct = useCallback((blockId: string, pct: number) => {
    setUnitState((s) =>
      pct <= (s.videoPct[blockId] ?? 0)
        ? s
        : { ...s, videoPct: { ...s.videoPct, [blockId]: pct } }
    );
  }, []);
  const noteBlockViewed = useCallback((blockId: string) => {
    setUnitState((s) =>
      s.viewedBlocks.includes(blockId) ? s : { ...s, viewedBlocks: [...s.viewedBlocks, blockId] }
    );
  }, []);
  const noteQuizAttempted = useCallback((blockId: string) => {
    setUnitState((s) =>
      s.attemptedQuizzes.includes(blockId)
        ? s
        : { ...s, attemptedQuizzes: [...s.attemptedQuizzes, blockId] }
    );
  }, []);

  const completedNow = progress.status === "completed";

  // Celebrate ONLY on a false→true transition DURING the session (the
  // setState-during-render derived pattern — completed-on-load never pops).
  const [prevCompleted, setPrevCompleted] = useState(completedNow);
  const [celebrate, setCelebrate] = useState(false);
  if (completedNow !== prevCompleted) {
    setPrevCompleted(completedNow);
    if (completedNow) setCelebrate(true);
  }

  const blockById = useMemo(() => new Map(lesson.blocks.map((b) => [b.id, b])), [lesson]);

  /* ───────────────────────── Tutor bus (TUTOR-1 W4) ─────────────────────── */
  // This component is the seam between the page tree (players) and the layout
  // tree (the tutor sidebar): it publishes ambient lesson context, forwards the
  // player taps as ambient block/slide/position/quiz signals, and honours the
  // sidebar's citation jumps by scrolling to a block + steering its deck.
  const setAmbient = useTutorStore((s) => s.setAmbient);
  const citationRequest = useTutorStore((s) => s.citationRequest);
  const consumeCitation = useTutorStore((s) => s.consumeCitation);

  // blockId → the block's <section> node (scrollIntoView target).
  const sectionRefs = useRef(new Map<string, HTMLElement | null>());
  const registerSection = useCallback(
    (blockId: string) => (node: HTMLElement | null) => {
      sectionRefs.current.set(blockId, node);
    },
    []
  );
  // blockId → a jump request handed to that slide deck (bumped nonce).
  const [deckNav, setDeckNav] = useState<Record<string, { index: number; nonce: number }>>({});
  const navNonceRef = useRef(0);

  // Publish the lesson envelope on mount + whenever the lesson changes. `version`
  // rides tutorEnvelope (not otherwise a prop here); absent ⇒ the bus is inert.
  useEffect(() => {
    setAmbient({
      courseId: tutorEnvelope?.courseId ?? courseId,
      publicationId: tutorEnvelope?.publicationId ?? publicationId,
      version: tutorEnvelope?.version ?? null,
      lessonId: lesson.id,
      // A new lesson clears the last-interacted block context.
      blockId: null,
      slideId: null,
      positionPct: null,
      quizActive: null,
    });
  }, [setAmbient, tutorEnvelope, courseId, publicationId, lesson.id]);

  // Scroll to a block + (for a slide deck) steer it to the cited slide. Shared
  // by the sidebar citation subscription and the initial deep-link focus.
  const focusBlock = useCallback(
    (blockId: string, slideId: string | null) => {
      const node = sectionRefs.current.get(blockId);
      if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
      const block = blockById.get(blockId);
      if (slideId && block?.type === "slide_deck") {
        const index = block.slides.findIndex((sl) => sl.id === slideId);
        if (index >= 0) {
          navNonceRef.current += 1;
          const nonce = navNonceRef.current;
          setDeckNav((prev) => ({ ...prev, [blockId]: { index, nonce } }));
        }
      }
    },
    [blockById]
  );

  // Sidebar → player: honour a citation targeting THIS lesson, then clear it.
  useEffect(() => {
    if (!citationRequest || citationRequest.lessonId !== lesson.id) return;
    focusBlock(citationRequest.blockId, citationRequest.slideId);
    consumeCitation();
  }, [citationRequest, lesson.id, focusBlock, consumeCitation]);

  // One-shot deep-link focus (?block=&slide=) on mount / lesson change.
  const initialFocusKey = initialFocus ? `${initialFocus.blockId}:${initialFocus.slideId ?? ""}` : null;
  useEffect(() => {
    if (!initialFocus) return;
    focusBlock(initialFocus.blockId, initialFocus.slideId);
    // Fire once per target; focusBlock is stable across the lesson.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFocusKey]);

  const unitViews = trackables.map((unit) => ({ unit, ...unitView(unit, unitState) }));
  const checklistItems: ChecklistItem[] = unitViews.map(({ unit, fraction, detail, fallbackLabel }) => ({
    id: unit.blockId,
    label: blockById.get(unit.blockId)?.title || fallbackLabel,
    detail,
    done: fraction >= 1,
  }));
  // The lesson's own unit completion for the sticky bar — mirrors the server's
  // pct shape (mean of fractions, capped at 99 until the server confirms).
  const unitPct = completedNow
    ? 100
    : unitViews.length === 0
      ? Math.round(progress.pct)
      : Math.min(
          99,
          Math.round(
            (unitViews.reduce((sum, v) => sum + v.fraction, 0) / unitViews.length) * 100
          )
        );

  return (
    <div className="space-y-8">
      {/* ── Sticky micro-progress (below the h-14 shell header) ── */}
      <div className="sticky top-16 z-20">
        <div className="flex items-center gap-3 rounded-full border border-stone-200/80 bg-white/90 px-4 py-2 shadow-[0_2px_10px_rgba(68,48,28,0.1)] backdrop-blur">
          <span className="min-w-0 flex-1 truncate text-xs text-stone-500">
            <span className="font-medium text-stone-700">{courseTitle}</span>
            <span aria-hidden> · </span>
            Lesson {lessonNumber} of {lessonCount}
          </span>
          {isStudent ? (
            <>
              <span className="sr-only">Lesson progress</span>
              <span className="w-20 shrink-0 sm:w-28">
                <ProgressBar pct={unitPct} tone={completedNow ? "emerald" : "learn"} />
              </span>
              <span
                className={cn(
                  "shrink-0 text-[11px] font-medium tabular-nums",
                  completedNow ? "text-emerald-600" : "text-learn-700"
                )}
              >
                {unitPct}%
              </span>
            </>
          ) : null}
        </div>
      </div>

      {lesson.objective ? (
        <p className="rounded-xl border border-learn-100 bg-learn-50/60 px-5 py-4 text-sm leading-relaxed text-stone-600">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-learn-700">
            Objective
          </span>
          <span className="mt-1 block text-[15px] text-stone-700">{lesson.objective}</span>
        </p>
      ) : null}

      {lesson.blocks.map((block) => {
        const meta = BLOCK_META[block.type] ?? { label: "Content", icon: BookOpen };
        const chip = <BlockChip icon={meta.icon} interactive={meta.interactive} />;

        // TEXT blocks collapse (content stays mounted); tracked blocks never do.
        if (TEXT_BLOCK_TYPES.has(block.type)) {
          return (
            <CollapsibleBlock
              key={block.id}
              chip={chip}
              eyebrow={meta.label}
              title={block.title ?? null}
              ariaLabel={block.title ?? meta.label}
            >
              {block.type === "lecture_text" ? (
                <LearnLecture block={block} />
              ) : block.type === "example" ? (
                <LearnExample block={block} />
              ) : block.type === "exercise" ? (
                <LearnExercise block={block} />
              ) : block.type === "resource" ? (
                <LearnResource block={block} />
              ) : null}
            </CollapsibleBlock>
          );
        }

        return (
          <section
            key={block.id}
            ref={registerSection(block.id)}
            data-block-id={block.id}
            aria-label={block.title ?? meta.label}
          >
            <header className="mb-3 flex items-center gap-3">
              {chip}
              <div className="min-w-0">
                <span
                  className={cn(
                    "block font-mono text-[11px] uppercase tracking-[0.18em]",
                    meta.interactive ? "text-learn-700" : "text-stone-500"
                  )}
                >
                  {meta.label}
                </span>
                {block.title ? (
                  <h2 className="text-lg leading-snug [font-family:var(--font-display)] font-light text-stone-900">
                    {block.title}
                  </h2>
                ) : null}
              </div>
            </header>

            {block.type === "slide_deck" ? (
              <LearnSlideDeck
                block={block}
                feedbackEnabled={isStudent}
                initialFeedback={slideFeedback}
                navRequest={deckNav[block.id] ?? null}
                onSlideChange={(slideId) =>
                  setAmbient({ blockId: block.id, slideId, positionPct: null, quizActive: null })
                }
                onSlidesViewed={
                  isStudent
                    ? (slideIds) => {
                        noteSlidesViewed(block.id, slideIds);
                        void reportProgress(courseId, {
                          action: "slides_viewed",
                          lessonId: lesson.id,
                          blockId: block.id,
                          slideIds,
                        }).then(absorb);
                      }
                    : undefined
                }
              />
            ) : block.type === "imported_deck" ? (
              <LearnImportedDeck
                block={block}
                initialView={deckViews[block.id] ?? null}
                onPageChange={() =>
                  setAmbient({ blockId: block.id, slideId: null, positionPct: null, quizActive: null })
                }
                onDeckViewed={
                  isStudent
                    ? () => {
                        noteBlockViewed(block.id);
                        void reportProgress(courseId, {
                          action: "block_viewed",
                          lessonId: lesson.id,
                          blockId: block.id,
                        }).then(absorb);
                      }
                    : undefined
                }
              />
            ) : block.type === "video" ? (
              <LearnVideo
                block={block}
                data={videoData[block.id] ?? null}
                onPositionChange={(pct) =>
                  setAmbient({ blockId: block.id, slideId: null, positionPct: pct, quizActive: null })
                }
                onVideoProgress={
                  isStudent
                    ? (pct) => {
                        noteVideoPct(block.id, pct);
                        void reportProgress(courseId, {
                          action: "video_progress",
                          lessonId: lesson.id,
                          blockId: block.id,
                          pct,
                        }).then(absorb);
                      }
                    : undefined
                }
              />
            ) : block.type === "quiz" ? (
              <LearnQuiz
                block={block}
                publicationId={publicationId}
                priorAttempts={quizAttemptCounts[block.id] ?? 0}
                onActivityChange={(active) =>
                  setAmbient({ blockId: block.id, slideId: null, positionPct: null, quizActive: active })
                }
                onGraded={(snapshot) => {
                  if (isStudent) noteQuizAttempted(block.id);
                  absorb(snapshot);
                }}
              />
            ) : block.type === "homework" ? (
              <LearnHomework
                block={block}
                courseId={courseId}
                publicationId={publicationId}
                userId={userId}
                priorSubmissions={homeworkSubmissions[block.id] ?? []}
                disabled={!isStudent}
              />
            ) : null}
          </section>
        );
      })}

      {/* ── What's left (students, trackable lessons, until done) ── */}
      {isStudent && trackables.length > 0 && !completedNow ? (
        <CompletionChecklist items={checklistItems} />
      ) : null}

      {/* ── Completion footer ── */}
      {completedNow ? (
        celebrate ? (
          <LessonCelebration nextLesson={nextLesson} courseHref={courseHref} />
        ) : (
          <p className="flex items-center justify-center gap-2 rounded-2xl border border-emerald-100 bg-emerald-50/70 px-6 py-4 text-sm font-medium text-emerald-700">
            <CheckCircle2 className="h-5 w-5" aria-hidden /> Lesson complete
          </p>
        )
      ) : showMarkComplete ? (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={markBusy}
            data-ai-tool="learn-mark-complete"
            onClick={() => {
              setMarkBusy(true);
              void reportProgress(courseId, {
                action: "mark_complete",
                lessonId: lesson.id,
              })
                .then(absorb)
                .finally(() => setMarkBusy(false));
            }}
            className="brand-gradient rounded-full px-6 py-2.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95 disabled:pointer-events-none disabled:opacity-60"
          >
            {markBusy ? "Saving…" : "Mark lesson complete"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
