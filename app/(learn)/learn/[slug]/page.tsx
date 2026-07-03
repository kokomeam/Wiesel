/**
 * /learn/[slug] — the public course landing for a LIVE publication.
 *
 * Visibility rides on RLS through the request-scoped client: anonymous
 * visitors resolve public courses; signed-in visitors also resolve unlisted
 * ones (link possession). Renamed slugs redirect via previous_slugs. Enrolled
 * learners see their progress and a "Continue" target; everyone else sees the
 * outline with lessons locked behind enrollment.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BookOpen, CheckCircle2, Circle, Clock, Layers, Lock, PlayCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PublishedLesson } from "@/lib/course/publish/schemas";
import { getLearnerAccess } from "@/lib/learn/access";
import { parsePublicationSnapshot, resolveLivePublicationBySlug } from "@/lib/learn/resolve";
import {
  buildCourseProgressSummary,
  type CourseProgressSummary,
} from "@/lib/learn/summary";
import { createClient } from "@/lib/supabase/server";
import { EnrollButton } from "@/components/learn/EnrollButton";

export const dynamic = "force-dynamic";

function lessonMinutes(lessons: PublishedLesson[]): number {
  return lessons.reduce((sum, l) => sum + (l.estimatedMinutes ?? 0), 0);
}

export default async function CourseLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await createClient();

  const resolution = await resolveLivePublicationBySlug(supabase, slug);
  if (resolution.kind === "redirect") redirect(`/learn/${resolution.slug}`);
  if (resolution.kind === "not_found") notFound();
  const publication = resolution.publication;
  const snapshot = parsePublicationSnapshot(publication);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const access = user ? await getLearnerAccess(supabase, user.id, publication.course_id) : null;
  const enrolled = access?.role === "student";
  const isAuthor = access?.role === "author";
  const canOpenLessons = enrolled || isAuthor;

  let summary: CourseProgressSummary | null = null;
  if (enrolled && user) {
    const rows = await supabase
      .from("learn_progress")
      .select("lesson_id, status, pct, last_activity_at")
      .eq("user_id", user.id)
      .eq("course_id", publication.course_id);
    summary = buildCourseProgressSummary(snapshot, rows.data ?? []);
  }

  const allLessons = snapshot.modules.flatMap((m) => m.lessons);
  const totalMinutes = lessonMinutes(allLessons);
  // For enrolled learners the summary decides (null = everything done); for
  // everyone else the target is simply the first lesson.
  const continueLessonId = summary
    ? summary.continueLessonId
    : (allLessons[0]?.id ?? null);

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      {/* ── Hero ── */}
      <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
        <div className="max-w-2xl">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-700">
            {snapshot.course.level ? `${snapshot.course.level} course` : "Course"}
          </p>
          <h1 className="mt-3 text-4xl leading-tight [font-family:var(--font-display)] font-light">
            {snapshot.course.title}
          </h1>
          {snapshot.course.description ? (
            <p className="mt-4 text-base leading-relaxed text-stone-600">
              {snapshot.course.description}
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-stone-500">
            <span className="inline-flex items-center gap-1.5">
              <Layers className="h-4 w-4" aria-hidden />
              {snapshot.modules.length} {snapshot.modules.length === 1 ? "module" : "modules"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <BookOpen className="h-4 w-4" aria-hidden />
              {allLessons.length} {allLessons.length === 1 ? "lesson" : "lessons"}
            </span>
            {totalMinutes > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-4 w-4" aria-hidden />~{totalMinutes} min
              </span>
            ) : null}
          </div>
        </div>

        {/* ── CTA card ── */}
        <div className="w-full shrink-0 rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)] md:w-80">
          {enrolled && summary ? (
            <>
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-medium text-stone-700">Your progress</p>
                <p className="text-sm tabular-nums text-stone-500">
                  {summary.completedLessons}/{summary.totalLessons} lessons
                </p>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-100">
                <div
                  className="brand-gradient h-full rounded-full"
                  style={{ width: `${summary.pct}%` }}
                />
              </div>
              {continueLessonId ? (
                <Link
                  href={`/learn/${publication.slug}/${continueLessonId}`}
                  className="brand-gradient mt-5 flex h-10 items-center justify-center gap-2 rounded-full text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
                >
                  <PlayCircle className="h-4 w-4" aria-hidden />
                  {summary.completedLessons > 0 ? "Continue learning" : "Start learning"}
                </Link>
              ) : (
                <p className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-center text-sm font-medium text-emerald-700">
                  Course complete — nicely done!
                </p>
              )}
            </>
          ) : isAuthor ? (
            <>
              <p className="text-sm font-medium text-stone-700">You created this course</p>
              <p className="mt-2 text-sm text-stone-500">
                This is the live version learners see (v{publication.version}).
              </p>
              {continueLessonId ? (
                <Link
                  href={`/learn/${publication.slug}/${continueLessonId}`}
                  className="mt-5 flex h-10 items-center justify-center rounded-full border border-stone-300/80 bg-white text-sm font-medium text-stone-700 hover:bg-stone-50"
                >
                  Preview as a learner
                </Link>
              ) : null}
            </>
          ) : user ? (
            <>
              <p className="text-sm font-medium text-stone-700">Free while in beta</p>
              <p className="mt-2 text-sm text-stone-500">
                Enroll to unlock every lesson and track your progress.
              </p>
              <EnrollButton
                courseId={publication.course_id}
                className="mt-5 w-full"
              />
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-stone-700">Ready to start?</p>
              <p className="mt-2 text-sm text-stone-500">
                Sign in to enroll and track your progress.
              </p>
              <Link
                href={`/login?redirectTo=/learn/${publication.slug}`}
                className="brand-gradient mt-5 flex h-10 items-center justify-center rounded-full text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
              >
                Sign in to enroll
              </Link>
            </>
          )}
        </div>
      </div>

      {/* ── Outline ── */}
      <div className="mt-14">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-stone-400">
          What you&apos;ll learn
        </p>
        <div className="mt-4 space-y-6">
          {snapshot.modules.map((courseModule, mi) => (
            <section
              key={courseModule.id}
              className="rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
            >
              <header className="border-b border-stone-100 px-6 py-4">
                <h2 className="text-lg [font-family:var(--font-display)] font-light">
                  <span className="text-stone-400">Module {mi + 1}:</span> {courseModule.title}
                </h2>
                {courseModule.description ? (
                  <p className="mt-1 text-sm text-stone-500">{courseModule.description}</p>
                ) : null}
              </header>
              <ul className="divide-y divide-stone-100">
                {courseModule.lessons.map((lesson) => {
                  const progress = summary?.byLesson.get(lesson.id);
                  const row = (
                    <div className="flex items-center gap-3 px-6 py-3.5">
                      {progress?.status === "completed" ? (
                        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-hidden />
                      ) : canOpenLessons ? (
                        <Circle
                          className={cn(
                            "h-5 w-5 shrink-0",
                            progress?.status === "in_progress"
                              ? "text-brand-500"
                              : "text-stone-300"
                          )}
                          aria-hidden
                        />
                      ) : (
                        <Lock className="h-4 w-4 shrink-0 text-stone-300" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm text-stone-700">
                        {lesson.title}
                      </span>
                      {lesson.estimatedMinutes ? (
                        <span className="shrink-0 text-xs tabular-nums text-stone-400">
                          {lesson.estimatedMinutes} min
                        </span>
                      ) : null}
                      {progress?.status === "in_progress" ? (
                        <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                          {progress.pct}%
                        </span>
                      ) : null}
                    </div>
                  );
                  return (
                    <li key={lesson.id}>
                      {canOpenLessons ? (
                        <Link
                          href={`/learn/${publication.slug}/${lesson.id}`}
                          className="block transition-colors hover:bg-stone-50"
                        >
                          {row}
                        </Link>
                      ) : (
                        row
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
