/**
 * /learn/[slug]/[lessonId] — the lesson player. Auth required; content is
 * gated on enrollment (or authorship, as a preview). Everything renders from
 * the LIVE snapshot via read-only renderers — no editor chrome reaches a
 * student. Learner-only media (video MP4s, imported-deck signed pages) is
 * resolved server-side with the admin client AFTER the access check, because
 * their source rows are author-only under RLS.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronLeft } from "lucide-react";
import type { DeckImportView } from "@/lib/course/imports/deckImportTypes";
import type { PublishedLesson } from "@/lib/course/publish/schemas";
import { getLearnerAccess } from "@/lib/learn/access";
import { learnerDeckView, learnerVideoData, type LearnerVideoData } from "@/lib/learn/media";
import { parsePublicationSnapshot, resolveLivePublicationBySlug } from "@/lib/learn/resolve";
import { buildCourseProgressSummary } from "@/lib/learn/summary";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { AnalyticsProvider } from "@/components/learn/AnalyticsProvider";
import { CourseNavSidebar, type NavModule } from "@/components/learn/CourseNavSidebar";
import {
  LearnLessonView,
  type LessonProgressView,
} from "@/components/learn/LearnLessonView";
import type { PriorSubmission } from "@/components/learn/LearnHomework";

export const dynamic = "force-dynamic";

export default async function LessonPlayerPage({
  params,
}: {
  params: Promise<{ slug: string; lessonId: string }>;
}) {
  const { slug, lessonId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirectTo=/learn/${slug}/${lessonId}`);

  const resolution = await resolveLivePublicationBySlug(supabase, slug);
  if (resolution.kind === "redirect") redirect(`/learn/${resolution.slug}/${lessonId}`);
  if (resolution.kind === "not_found") notFound();
  const publication = resolution.publication;
  const snapshot = parsePublicationSnapshot(publication);

  const access = await getLearnerAccess(supabase, user.id, publication.course_id);
  if (!access) redirect(`/learn/${slug}`);

  // Locate the lesson + its ordered neighbors.
  const orderedLessons: PublishedLesson[] = snapshot.modules.flatMap((m) => m.lessons);
  const lessonIndex = orderedLessons.findIndex((l) => l.id === lessonId);
  if (lessonIndex === -1) notFound();
  const lesson = orderedLessons[lessonIndex];
  const prev = lessonIndex > 0 ? orderedLessons[lessonIndex - 1] : null;
  const next = lessonIndex < orderedLessons.length - 1 ? orderedLessons[lessonIndex + 1] : null;

  // Learner media (admin client — the access check above is the gate).
  const admin = createAdminClient();
  const videoData: Record<string, LearnerVideoData | null> = {};
  const deckViews: Record<string, DeckImportView | null> = {};
  await Promise.all(
    lesson.blocks.map(async (block) => {
      if (block.type === "video") {
        videoData[block.id] = await learnerVideoData(admin, block);
      } else if (block.type === "imported_deck") {
        deckViews[block.id] = await learnerDeckView(admin, block);
      }
    })
  );

  // The learner's own context (user-scoped client — RLS).
  const quizBlockIds = lesson.blocks.filter((b) => b.type === "quiz").map((b) => b.id);
  const homeworkBlockIds = lesson.blocks
    .filter((b) => b.type === "homework")
    .map((b) => b.id);

  const [attemptRows, submissionRows, progressRows] = await Promise.all([
    quizBlockIds.length > 0
      ? supabase
          .from("quiz_attempts")
          .select("block_id")
          .eq("user_id", user.id)
          .in("block_id", quizBlockIds)
      : Promise.resolve({ data: [] as { block_id: string }[] }),
    homeworkBlockIds.length > 0
      ? supabase
          .from("homework_submissions")
          .select("id, block_id, status, created_at, file_paths")
          .eq("user_id", user.id)
          .in("block_id", homeworkBlockIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({
          data: [] as {
            id: string;
            block_id: string;
            status: string;
            created_at: string;
            file_paths: string[];
          }[],
        }),
    // All-course progress (drives the contents sidebar + the current lesson's
    // initial progress) — one query instead of a per-lesson fetch.
    supabase
      .from("learn_progress")
      .select("lesson_id, status, pct, last_activity_at")
      .eq("user_id", user.id)
      .eq("course_id", publication.course_id),
  ]);

  const quizAttemptCounts: Record<string, number> = {};
  for (const row of attemptRows.data ?? []) {
    quizAttemptCounts[row.block_id] = (quizAttemptCounts[row.block_id] ?? 0) + 1;
  }
  const homeworkSubmissions: Record<string, PriorSubmission[]> = {};
  for (const row of submissionRows.data ?? []) {
    (homeworkSubmissions[row.block_id] ??= []).push({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      fileCount: row.file_paths.length,
    });
  }
  // Full-course progress → the contents sidebar + this lesson's initial progress.
  const summary = buildCourseProgressSummary(snapshot, progressRows.data ?? []);
  const current = summary.byLesson.get(lessonId);
  const initialProgress: LessonProgressView | null =
    current && current.status !== "not_started"
      ? { status: current.status, pct: current.pct }
      : null;
  const authorPreview = access.role === "author";

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
        slug={publication.slug}
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
              href={`/learn/${publication.slug}`}
              className="inline-flex items-center gap-1 text-sm text-stone-500 transition-colors hover:text-stone-800"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {snapshot.course.title}
            </Link>
            <div className="mt-3 flex items-start justify-between gap-4">
              <h1 className="text-3xl leading-tight [font-family:var(--font-display)] font-light">
                {lesson.title}
              </h1>
              {authorPreview ? (
                <span className="mt-1 shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-500">
                  Author preview
                </span>
              ) : null}
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-400">
              {currentModuleIndex >= 0 ? (
                <>
                  <span className="font-medium text-stone-500">
                    Module {currentModuleIndex + 1}
                  </span>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <span>
                Lesson {lessonIndex + 1} of {orderedLessons.length}
              </span>
              {initialProgress?.status === "completed" ? (
                <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  Completed
                </span>
              ) : null}
            </p>
          </div>

          <AnalyticsProvider
            publicationId={publication.id}
            version={publication.version}
            courseId={publication.course_id}
            lessonId={lesson.id}
            enabled={access.role === "student"}
          >
            <LearnLessonView
              courseId={publication.course_id}
              publicationId={publication.id}
              lesson={lesson}
              role={access.role}
              userId={user.id}
              videoData={videoData}
              deckViews={deckViews}
              quizAttemptCounts={quizAttemptCounts}
              homeworkSubmissions={homeworkSubmissions}
              initialProgress={initialProgress}
            />
          </AnalyticsProvider>

          {/* ── Prev / next ── */}
          <nav className="mt-12 flex items-stretch justify-between gap-4 border-t border-stone-200/70 pt-6">
            {prev ? (
              <Link
                href={`/learn/${publication.slug}/${prev.id}`}
                className="group flex min-w-0 items-center gap-2 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-sm text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-900"
              >
                <ArrowLeft className="h-4 w-4 shrink-0 text-stone-400 group-hover:text-stone-600" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[11px] uppercase tracking-wide text-stone-400">
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
                href={`/learn/${publication.slug}/${next.id}`}
                className="group flex min-w-0 items-center gap-2 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-right text-sm text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-900"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] uppercase tracking-wide text-stone-400">
                    Next
                  </span>
                  <span className="block truncate">{next.title}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-stone-400 group-hover:text-stone-600" aria-hidden />
              </Link>
            ) : (
              <Link
                href={`/learn/${publication.slug}`}
                className="flex items-center gap-2 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-sm text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-900"
              >
                Back to course overview
              </Link>
            )}
          </nav>
        </div>
      </div>
    </div>
  );
}
