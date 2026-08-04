/**
 * /learn/[slug]/[lessonId] — the lesson player. Auth required; content is
 * gated on enrollment (or authorship, as a preview). Everything renders from
 * the LIVE snapshot via read-only renderers — no editor chrome reaches a
 * student.
 *
 * PERF-1 C1 transport shape (behavior unchanged):
 *   1. getSessionUser ∥ resolveLivePublicationMeta — one parallel wave (the
 *      session read and the slug resolve are independent; redirect/404
 *      semantics incl. previous_slugs + unlisted-vs-unknown parity preserved).
 *   2. getCachedSnapshot(meta.id) — the immutable body, cached per process /
 *      Next data cache (zero round trips warm).
 *   3. ONE SECURITY DEFINER RPC (loadLessonState) returns the access verdict
 *      + progress + attempts + homework + review/feedback + the video-asset
 *      fields — authorization happens INSIDE the RPC. Imported-deck signed
 *      pages moved OFF the critical path: LearnImportedDeck lazy-fetches
 *      /api/learn/deck/[id] on mount.
 */

import Link from "next/link";
import nextDynamic from "next/dynamic";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronLeft } from "lucide-react";
import type { PublishedLesson } from "@/lib/course/publish/schemas";
import {
  lessonVideoAssetIds,
  loadLessonState,
  videoDataFromState,
} from "@/lib/learn/lessonState";
import { getCachedSnapshot, resolveLivePublicationMeta } from "@/lib/learn/publicationCache";
import { parseReviewPromptState, type ReviewPromptState } from "@/lib/learn/reviews";
import { ProgressStateSchema, type ProgressState } from "@/lib/learn/schemas";
import { buildCourseProgressSummary } from "@/lib/learn/summary";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { AnalyticsProvider } from "@/components/learn/AnalyticsProvider";
import { CourseNavSidebar, type NavModule } from "@/components/learn/CourseNavSidebar";
import type { SlideFeedbackMap } from "@/components/learn/LearnSlideDeck";
import {
  LearnLessonView,
  type LessonProgressView,
} from "@/components/learn/LearnLessonView";
import type { PriorSubmission } from "@/components/learn/LearnHomework";

// The review ask only appears near completion — lazy-load it so framer-motion
// stays out of the critical lesson bundle.
const ReviewSlideIn = nextDynamic(() =>
  import("@/components/learn/CourseReview").then((m) => m.ReviewSlideIn)
);

export const dynamic = "force-dynamic";

export default async function LessonPlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; lessonId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, lessonId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  // The session read and the narrow slug resolve are independent — one wave.
  const [user, resolution] = await Promise.all([
    getSessionUser(),
    resolveLivePublicationMeta(supabase, slug),
  ]);
  if (!user) redirect(`/login?redirectTo=/learn/${slug}/${lessonId}`);
  if (resolution.kind === "redirect") redirect(`/learn/${resolution.slug}/${lessonId}`);
  if (resolution.kind === "not_found") notFound();
  const meta = resolution.meta;

  // Immutable body — cached forever by publication id (no round trip warm).
  const { snapshot } = await getCachedSnapshot(meta.id);

  // Locate the lesson + its ordered neighbors (pure — needed to derive the
  // RPC's video-asset ids; the access-vs-404 ORDER below matches the old
  // flow: a denied caller bounces to the landing even for a bogus lessonId).
  const orderedLessons: PublishedLesson[] = snapshot.modules.flatMap((m) => m.lessons);
  const lessonIndex = orderedLessons.findIndex((l) => l.id === lessonId);
  const lesson = lessonIndex === -1 ? null : orderedLessons[lessonIndex];

  // ONE bundle RPC: access verdict + everything user-scoped.
  const stateResult = await loadLessonState(supabase, {
    publicationId: meta.id,
    lessonId,
    videoAssetIds: lesson ? lessonVideoAssetIds(lesson) : [],
  });
  if (stateResult.kind !== "ok") redirect(`/learn/${slug}`);
  const state = stateResult.state;

  if (!lesson) notFound();
  const prev = lessonIndex > 0 ? orderedLessons[lessonIndex - 1] : null;
  const next =
    lessonIndex < orderedLessons.length - 1 ? orderedLessons[lessonIndex + 1] : null;

  const authorPreview = state.access.is_author;
  const role: "student" | "author" = authorPreview ? "author" : "student";
  const isStudent = role === "student";

  const quizAttemptCounts: Record<string, number> = state.quiz_attempt_counts;

  const homeworkBlockIds = new Set(
    lesson.blocks.filter((b) => b.type === "homework").map((b) => b.id)
  );
  const homeworkSubmissions: Record<string, PriorSubmission[]> = {};
  for (const row of state.homework_submissions) {
    if (!homeworkBlockIds.has(row.block_id)) continue;
    (homeworkSubmissions[row.block_id] ??= []).push({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      fileCount: row.file_paths.length,
    });
  }

  // Full-course progress → the contents sidebar + this lesson's initial progress.
  const summary = buildCourseProgressSummary(snapshot, state.progress);
  const current = summary.byLesson.get(lessonId);
  const initialProgress: LessonProgressView | null =
    current && current.status !== "not_started"
      ? { status: current.status, pct: current.pct }
      : null;

  // The stored per-unit state (graceful: a missing/legacy row parses to null
  // and the checklist simply starts empty — the server verdict still rules).
  let initialProgressState: ProgressState | null = null;
  if (state.lesson_progress_state != null) {
    const parsed = ProgressStateSchema.safeParse(state.lesson_progress_state);
    if (parsed.success) initialProgressState = parsed.data;
  }

  let reviewState: ReviewPromptState | null = null;
  let slideFeedback: SlideFeedbackMap = {};
  if (state.review_prompt != null) {
    try {
      reviewState = parseReviewPromptState(state.review_prompt);
    } catch (err) {
      console.error("[learn] review prompt state parse failed", err);
    }
  }
  if (state.slide_feedback && typeof state.slide_feedback === "object") {
    slideFeedback = state.slide_feedback as SlideFeedbackMap;
  }

  const videoData = videoDataFromState(lesson, state.video_assets);

  // TUTOR-1 W4: a ?block=&slide= deep link scrolls the player to that block on
  // mount (validated against THIS lesson's blocks — a bogus id is ignored).
  const focusBlockId = typeof sp.block === "string" ? sp.block : null;
  const focusSlideId = typeof sp.slide === "string" ? sp.slide : null;
  const initialFocus =
    focusBlockId && lesson.blocks.some((b) => b.id === focusBlockId)
      ? { blockId: focusBlockId, slideId: focusSlideId }
      : undefined;

  const navModules: NavModule[] = snapshot.modules.map((m) => ({
    id: m.id,
    title: m.title,
    lessons: m.lessons.map((l) => {
      const p = summary.byLesson.get(l.id);
      return {
        id: l.id,
        title: l.title,
        estimatedMinutes: l.estimatedMinutes ?? null,
        status: p?.status ?? "not_started",
        pct: p?.pct ?? 0,
      };
    }),
  }));
  const currentModuleIndex = snapshot.modules.findIndex((m) =>
    m.lessons.some((l) => l.id === lessonId)
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row lg:gap-10 lg:py-10">
      <CourseNavSidebar
        slug={meta.slug}
        courseTitle={snapshot.course.title}
        modules={navModules}
        currentLessonId={lessonId}
        completedCount={summary.completedLessons}
        totalCount={summary.totalLessons}
        pct={summary.pct}
        authorPreview={authorPreview}
      />

      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-3xl">
          {/* ── Lesson header ── */}
          <div className="mb-8">
            <Link
              href={`/learn/${meta.slug}`}
              className="inline-flex items-center gap-1 text-sm text-stone-600 transition-colors hover:text-stone-800"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {snapshot.course.title}
            </Link>
            <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.18em] text-learn-700">
              {currentModuleIndex >= 0 ? (
                <>
                  <span>Module {currentModuleIndex + 1}</span>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <span>
                Lesson {lessonIndex + 1} of {orderedLessons.length}
              </span>
              {initialProgress?.status === "completed" ? (
                <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 font-sans text-xs font-medium normal-case tracking-normal text-emerald-700">
                  Completed
                </span>
              ) : null}
            </p>
            <div className="mt-2 flex items-start justify-between gap-4">
              <h1 className="text-3xl leading-tight [font-family:var(--font-display)] font-light">
                {lesson.title}
              </h1>
              {authorPreview ? (
                <span className="mt-1 shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-500">
                  Author preview
                </span>
              ) : null}
            </div>
          </div>

          <AnalyticsProvider
            publicationId={meta.id}
            version={meta.version}
            courseId={meta.course_id}
            lessonId={lesson.id}
            enabled={isStudent}
          >
            <LearnLessonView
              courseId={meta.course_id}
              publicationId={meta.id}
              lesson={lesson}
              role={role}
              userId={user.id}
              videoData={videoData}
              deckViews={{}}
              quizAttemptCounts={quizAttemptCounts}
              homeworkSubmissions={homeworkSubmissions}
              initialProgress={initialProgress}
              initialProgressState={initialProgressState}
              slideFeedback={slideFeedback}
              courseTitle={snapshot.course.title}
              lessonNumber={lessonIndex + 1}
              lessonCount={orderedLessons.length}
              nextLesson={
                next
                  ? { title: next.title, href: `/learn/${meta.slug}/${next.id}` }
                  : null
              }
              courseHref={`/learn/${meta.slug}`}
              tutorEnvelope={{
                courseId: meta.course_id,
                publicationId: meta.id,
                version: meta.version,
              }}
              initialFocus={initialFocus}
            />
          </AnalyticsProvider>

          {/* ── Prev / next ── */}
          <nav className="mt-12 flex items-stretch justify-between gap-4 border-t border-stone-200/70 pt-6">
            {prev ? (
              <Link
                href={`/learn/${meta.slug}/${prev.id}`}
                className="group flex min-w-0 items-center gap-2 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-sm text-stone-600 transition hover:-translate-y-0.5 hover:border-stone-300 hover:text-stone-900"
              >
                <ArrowLeft
                  className="h-4 w-4 shrink-0 text-stone-400 transition group-hover:-translate-x-0.5 group-hover:text-learn-600"
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block text-[11px] uppercase tracking-wide text-stone-600">
                    Previous
                  </span>
                  <span className="block truncate">{prev.title}</span>
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={`/learn/${meta.slug}/${next.id}`}
                className="group flex min-w-0 items-center gap-2 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-right text-sm text-stone-600 transition hover:-translate-y-0.5 hover:border-learn-200 hover:text-stone-900"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] uppercase tracking-wide text-stone-600">
                    Next
                  </span>
                  <span className="block truncate">{next.title}</span>
                </span>
                <ArrowRight
                  className="h-4 w-4 shrink-0 text-stone-400 transition group-hover:translate-x-0.5 group-hover:text-learn-600"
                  aria-hidden
                />
              </Link>
            ) : (
              <Link
                href={`/learn/${meta.slug}`}
                className="group flex items-center gap-2 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-sm text-stone-600 transition hover:-translate-y-0.5 hover:border-stone-300 hover:text-stone-900"
              >
                Back to course overview
              </Link>
            )}
          </nav>
        </div>
      </div>

      {reviewState ? (
        <ReviewSlideIn
          courseId={meta.course_id}
          courseTitle={snapshot.course.title}
          state={reviewState}
        />
      ) : null}
    </div>
  );
}
