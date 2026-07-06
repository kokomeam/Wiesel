"use client";

/**
 * The lesson player body: renders the published blocks IN ORDER with zero
 * editing chrome, wires each trackable block's signals into
 * /api/learn/progress, and surfaces live completion state. The completion
 * rule itself is pure + shared (lib/learn/completion.ts) — this component
 * only decides WHICH control to show (e.g. "Mark complete" appears exactly
 * when the lesson has no trackable units); the server remains the judge.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { PublishedLesson } from "@/lib/course/publish/schemas";
import type { DeckImportView } from "@/lib/course/imports/deckImportTypes";
import { lessonTrackables } from "@/lib/learn/completion";
import type { LearnerVideoData } from "@/lib/learn/media";
import type { LessonProgressSnapshot } from "@/lib/learn/schemas";
import { useAnalytics } from "./AnalyticsProvider";
import { LearnHomework, type PriorSubmission } from "./LearnHomework";
import { LearnImportedDeck } from "./LearnImportedDeck";
import { LearnQuiz } from "./LearnQuiz";
import { LearnSlideDeck } from "./LearnSlideDeck";
import { LearnVideo } from "./LearnVideo";
import { LearnExample, LearnExercise, LearnLecture, LearnResource } from "./readOnlyBlocks";
import { reportProgress } from "./progressClient";

const BLOCK_LABEL: Record<string, string> = {
  slide_deck: "Slides",
  imported_deck: "Slides",
  video: "Video",
  lecture_text: "Reading",
  quiz: "Knowledge check",
  homework: "Homework",
  exercise: "Practice",
  example: "Worked example",
  resource: "Resources",
};

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
  onProgressChange,
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
  onProgressChange?: (progress: LessonProgressView) => void;
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

  const trackables = lessonTrackables(lesson);
  const showMarkComplete = isStudent && trackables.length === 0;

  return (
    <div className="space-y-8">
      {lesson.objective ? (
        <p className="rounded-xl border border-stone-200/80 bg-white px-5 py-4 text-sm leading-relaxed text-stone-600">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400">
            Objective
          </span>
          <span className="mt-1 block text-[15px] text-stone-700">{lesson.objective}</span>
        </p>
      ) : null}

      {lesson.blocks.map((block) => (
        <section key={block.id} aria-label={block.title ?? BLOCK_LABEL[block.type]}>
          <header className="mb-3 flex items-baseline gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-brand-700/80">
              {BLOCK_LABEL[block.type] ?? "Content"}
            </span>
            {block.title ? (
              <h2 className="text-lg [font-family:var(--font-display)] font-light text-stone-900">
                {block.title}
              </h2>
            ) : null}
          </header>

          {block.type === "slide_deck" ? (
            <LearnSlideDeck
              block={block}
              lessonId={lesson.id}
              onSlidesViewed={
                isStudent
                  ? (slideIds) =>
                      void reportProgress(courseId, {
                        action: "slides_viewed",
                        lessonId: lesson.id,
                        blockId: block.id,
                        slideIds,
                      }).then(absorb)
                  : undefined
              }
            />
          ) : block.type === "imported_deck" ? (
            <LearnImportedDeck
              block={block}
              initialView={deckViews[block.id] ?? null}
              onDeckViewed={
                isStudent
                  ? () =>
                      void reportProgress(courseId, {
                        action: "block_viewed",
                        lessonId: lesson.id,
                        blockId: block.id,
                      }).then(absorb)
                  : undefined
              }
            />
          ) : block.type === "video" ? (
            <LearnVideo
              block={block}
              data={videoData[block.id] ?? null}
              onVideoProgress={
                isStudent
                  ? (pct) =>
                      void reportProgress(courseId, {
                        action: "video_progress",
                        lessonId: lesson.id,
                        blockId: block.id,
                        pct,
                      }).then(absorb)
                  : undefined
              }
            />
          ) : block.type === "quiz" ? (
            <LearnQuiz
              block={block}
              publicationId={publicationId}
              priorAttempts={quizAttemptCounts[block.id] ?? 0}
              onGraded={absorb}
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
          ) : block.type === "lecture_text" ? (
            <LearnLecture block={block} />
          ) : block.type === "example" ? (
            <LearnExample block={block} />
          ) : block.type === "exercise" ? (
            <LearnExercise block={block} />
          ) : block.type === "resource" ? (
            <LearnResource block={block} />
          ) : null}
        </section>
      ))}

      {/* ── Completion footer ── */}
      {progress.status === "completed" ? (
        <p className="flex items-center justify-center gap-2 rounded-2xl border border-emerald-100 bg-emerald-50/70 px-6 py-4 text-sm font-medium text-emerald-700">
          <CheckCircle2 className="h-5 w-5" aria-hidden /> Lesson complete
        </p>
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
