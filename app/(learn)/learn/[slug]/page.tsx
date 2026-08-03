/**
 * /learn/[slug] — the public course landing for a LIVE publication.
 *
 * Visibility rides on RLS through the request-scoped client: anonymous
 * visitors resolve public courses; signed-in visitors also resolve unlisted
 * ones (link possession). Renamed slugs redirect via previous_slugs. Enrolled
 * learners see their progress and a "Continue" target; everyone else sees the
 * outline with lessons locked behind enrollment.
 *
 * 2026-07-11 redesign: cover-art conversion card (uploaded cover or
 * deterministic CoverArt fallback), plan.outcomes as the real "What you'll
 * learn", a derived "This course includes" list, per-lesson type icons in the
 * curriculum, and the instructor section — all landing-extra data flows
 * through the anon-safe course_landing_extras RPC and degrades to hidden
 * sections when the RPC/columns aren't there yet (pending migration).
 */

import { cache } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  BookOpen,
  Check,
  Clock,
  FileText,
  HelpCircle,
  Layers,
  PenLine,
  PlayCircle,
  Presentation,
  Star,
} from "lucide-react";
import type { PublishedLesson } from "@/lib/course/publish/schemas";
import { getLearnerAccess } from "@/lib/learn/access";
import {
  courseIncludesItems,
  summarizeCourseContents,
  type CourseIncludeItem,
} from "@/lib/learn/courseIncludes";
import { fetchCourseLandingExtras } from "@/lib/learn/landingExtras";
import { getCachedSnapshot, resolveLivePublicationMeta } from "@/lib/learn/publicationCache";
import { parseReviewPromptState, type ReviewPromptState } from "@/lib/learn/reviews";
import {
  buildCourseProgressSummary,
  type CourseProgressSummary,
} from "@/lib/learn/summary";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CourseOutline, type OutlineModule } from "@/components/learn/CourseOutline";
import { CourseReviewSection, StarRow } from "@/components/learn/CourseReview";
import { CoverArt } from "@/components/learn/CoverArt";
import { EnrollButton } from "@/components/learn/EnrollButton";
import { InstructorCard } from "@/components/learn/InstructorCard";

export const dynamic = "force-dynamic";

/* Request-deduped fetchers: generateMetadata and the page share one render
   pass, so cache() keeps the OG lookup from doubling the DB round-trips.
   PERF-1 C1: the resolve is now the NARROW meta query (no snapshot bytes,
   no strict parse per view) — the immutable body rides the publication
   cache keyed by id. */
const resolveCached = cache(async (slug: string) => {
  const supabase = await createClient();
  return resolveLivePublicationMeta(supabase, slug);
});
const extrasCached = cache(async (courseId: string) => {
  const supabase = await createClient();
  return fetchCourseLandingExtras(supabase, courseId);
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  try {
    const { slug } = await params;
    const resolution = await resolveCached(slug);
    if (resolution.kind !== "found") return { title: "Course — WiseSel" };
    const [{ snapshot }, extras] = await Promise.all([
      getCachedSnapshot(resolution.meta.id),
      extrasCached(resolution.meta.course_id),
    ]);
    return {
      title: `${snapshot.course.title} — WiseSel`,
      description: snapshot.course.description ?? undefined,
      openGraph: {
        title: snapshot.course.title,
        description: snapshot.course.description ?? undefined,
        images: extras?.coverImageUrl ? [extras.coverImageUrl] : undefined,
      },
    };
  } catch {
    return { title: "Course — WiseSel" };
  }
}

function lessonMinutes(lessons: PublishedLesson[]): number {
  return lessons.reduce((sum, l) => sum + (l.estimatedMinutes ?? 0), 0);
}

/** "45 min" under an hour, "6.5 h" (trailing .0 trimmed) above. */
function formatTotalMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} h`;
}

/** Dominant content type for the curriculum row icon. */
function lessonPrimaryType(lesson: PublishedLesson): string {
  const types = new Set(lesson.blocks.map((b) => b.type));
  if (types.has("video")) return "video";
  if (types.has("slide_deck") || types.has("imported_deck")) return "slides";
  if (types.has("quiz")) return "quiz";
  if (types.has("homework")) return "homework";
  return "text";
}

const INCLUDE_ICONS: Record<CourseIncludeItem["icon"], typeof Layers> = {
  slides: Presentation,
  video: PlayCircle,
  quiz: HelpCircle,
  homework: PenLine,
  reading: FileText,
  time: Clock,
  modules: Layers,
};

export default async function CourseLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await createClient();

  // The slug resolution and the session read are independent — one wave.
  const [resolution, user] = await Promise.all([
    resolveCached(slug),
    getSessionUser(),
  ]);
  if (resolution.kind === "redirect") redirect(`/learn/${resolution.slug}`);
  if (resolution.kind === "not_found") notFound();
  const publication = resolution.meta;
  const { snapshot } = await getCachedSnapshot(publication.id);

  // Second wave: viewer access ∥ the landing extras (cover art, instructor
  // card, aggregate stats — null pre-migration, sections hide).
  const [access, extras] = await Promise.all([
    user ? getLearnerAccess(supabase, user.id, publication.course_id) : Promise.resolve(null),
    extrasCached(publication.course_id),
  ]);
  const enrolled = access?.role === "student";
  const isAuthor = access?.role === "author";
  const canOpenLessons = enrolled || isAuthor;

  let summary: CourseProgressSummary | null = null;
  let reviewState: ReviewPromptState | null = null;
  if (enrolled && user) {
    const [rows, promptState] = await Promise.all([
      supabase
        .from("learn_progress")
        .select("lesson_id, status, pct, last_activity_at")
        .eq("user_id", user.id)
        .eq("course_id", publication.course_id),
      // M9: the learner's review + eligibility (one definer RPC — the same
      // SQL gate the write policies enforce, so UI and gate can't drift).
      supabase.rpc("review_prompt_state", { p_course_id: publication.course_id }),
    ]);
    summary = buildCourseProgressSummary(snapshot, rows.data ?? []);
    if (!promptState.error) {
      try {
        reviewState = parseReviewPromptState(promptState.data);
      } catch (err) {
        console.error("[learn] review prompt state parse failed", err);
      }
    }
  }

  const allLessons = snapshot.modules.flatMap((m) => m.lessons);
  const totalMinutes = lessonMinutes(allLessons);
  const contents = summarizeCourseContents(snapshot);
  // Modules/lessons and total time already live in the hero chips + the
  // curriculum summary on the same screen — the card lists only the
  // CONTENT-type lines (slides/videos/quizzes/homework/reading).
  const includes = courseIncludesItems(contents).filter(
    (item) => item.icon !== "modules" && item.icon !== "time"
  );
  const outcomes = snapshot.course.plan.outcomes;
  const prerequisites = snapshot.course.plan.prerequisites;
  // For enrolled learners the summary decides (null = everything done); for
  // everyone else the target is simply the first lesson.
  const continueLessonId = summary
    ? summary.continueLessonId
    : (allLessons[0]?.id ?? null);

  const publishedDate = publication.published_at
    ? new Date(publication.published_at).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      })
    : null;

  // Serializable outline for the client accordion — same row semantics as
  // before (href only when the caller may open lessons; locked rows unlinked).
  const outlineModules: OutlineModule[] = snapshot.modules.map((courseModule) => ({
    id: courseModule.id,
    title: courseModule.title,
    description: courseModule.description ?? null,
    lessons: courseModule.lessons.map((lesson) => {
      const progress = summary?.byLesson.get(lesson.id);
      return {
        id: lesson.id,
        title: lesson.title,
        estimatedMinutes: lesson.estimatedMinutes ?? null,
        status: progress?.status ?? "not_started",
        pct: progress?.pct ?? 0,
        href: canOpenLessons ? `/learn/${publication.slug}/${lesson.id}` : null,
        primaryType: lessonPrimaryType(lesson),
      };
    }),
  }));

  const heroChips = (
    <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-stone-600">
      <span className="inline-flex items-center gap-1.5">
        <Layers className="h-4 w-4 text-stone-400" aria-hidden />
        {snapshot.modules.length} {snapshot.modules.length === 1 ? "module" : "modules"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <BookOpen className="h-4 w-4 text-stone-400" aria-hidden />
        {allLessons.length} {allLessons.length === 1 ? "lesson" : "lessons"}
      </span>
      {totalMinutes > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-4 w-4 text-stone-400" aria-hidden />≈
          {formatTotalMinutes(totalMinutes)}
        </span>
      ) : null}
      {extras && extras.course.studentCount > 0 ? (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span aria-hidden className="text-stone-300">
            ·
          </span>
          {extras.course.studentCount.toLocaleString("en-US")}{" "}
          {extras.course.studentCount === 1 ? "learner" : "learners"}
        </span>
      ) : null}
      {extras && extras.course.avgRating != null && extras.course.reviewCount > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <Star className="h-4 w-4 fill-amber-400 text-amber-400" aria-hidden />
          <span className="font-medium text-stone-900">
            {extras.course.avgRating.toFixed(1)}
          </span>
          <span className="text-stone-500">
            ({extras.course.reviewCount}{" "}
            {extras.course.reviewCount === 1 ? "review" : "reviews"})
          </span>
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="relative isolate overflow-x-clip">
      {/* Warm hero atmosphere — light fields only, per the gradient-rationing
          rule. -z keeps them behind everything; overflow-x-clip stops the
          blobs from widening the page. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 -top-28 -z-10 h-80 w-[38rem] rounded-full bg-brand-100/60 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 right-[-12rem] -z-10 h-72 w-[32rem] rounded-full bg-amber-100/50 blur-3xl"
      />

      <div className="mx-auto max-w-6xl px-6 py-10 sm:py-14">
        {/* ── Hero ── */}
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
          <div>
            <p className="eyebrow text-brand-700">
              {snapshot.course.level ? `${snapshot.course.level} course` : "Course"}
              {snapshot.course.plan.category ? ` · ${snapshot.course.plan.category}` : ""}
            </p>
            <h1 className="font-display mt-3 text-4xl font-light leading-[1.08] text-stone-900 sm:text-5xl">
              {snapshot.course.title}
            </h1>
            {snapshot.course.description ? (
              <p className="mt-5 max-w-2xl text-lg leading-relaxed text-stone-600">
                {snapshot.course.description}
              </p>
            ) : null}
            {heroChips}
            {extras ? (
              <a
                href="#instructor"
                className="group mt-5 inline-flex items-center gap-2.5 text-sm text-stone-600 transition-colors hover:text-stone-900"
              >
                {extras.creator.avatarUrl ? (
                  <Image
                    src={extras.creator.avatarUrl}
                    alt=""
                    width={28}
                    height={28}
                    className="size-7 rounded-full object-cover ring-2 ring-white"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="brand-gradient grid size-7 place-items-center rounded-full text-xs font-medium text-white ring-2 ring-white"
                  >
                    {(extras.creator.name.trim().charAt(0) || "W").toUpperCase()}
                  </span>
                )}
                <span>
                  Created by{" "}
                  <span className="font-medium text-stone-900 underline-offset-4 group-hover:underline">
                    {extras.creator.name}
                  </span>
                </span>
              </a>
            ) : null}
            {/* The learner's own rating — already on the page via the review
                prompt state (no extra fetch). */}
            {reviewState?.review ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-stone-500">
                <StarRow rating={reviewState.review.rating} />
                <span>Your rating</span>
              </div>
            ) : null}
          </div>

          {/* ── Conversion card ── */}
          <Card
            variant="elevated"
            className="w-full overflow-hidden p-0 lg:sticky lg:top-20"
          >
            {/* Sized directly (no absolute wrapper): CoverArt carries its own
                `relative`, and absolute-vs-relative on one element resolves by
                stylesheet order — passing `absolute` here collapsed it to 0h. */}
            {extras?.coverImageUrl ? (
              // The route's LCP element — priority preloads it AND stamps
              // fetchpriority=high (kept explicit too); fill inside a fixed
              // aspect-video box, neutral bg as the LQIP-equivalent
              // placeholder (PERF-1 D3). Sticky card is 400px on lg.
              <div className="relative aspect-video w-full bg-stone-100">
                <Image
                  src={extras.coverImageUrl}
                  alt=""
                  fill
                  priority
                  fetchPriority="high"
                  sizes="(max-width: 1023px) 100vw, 400px"
                  className="object-cover"
                />
              </div>
            ) : (
              <CoverArt
                courseId={publication.course_id}
                title={snapshot.course.title}
                className="aspect-video w-full"
              />
            )}
            <div className="p-6">
              {enrolled && summary ? (
                <>
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-medium text-stone-700">Your progress</p>
                    <p className="text-sm tabular-nums text-stone-500">
                      {summary.completedLessons}/{summary.totalLessons} lessons
                    </p>
                  </div>
                  <div className="mt-3">
                    <ProgressBar
                      pct={summary.pct}
                      tone={
                        summary.totalLessons > 0 &&
                        summary.completedLessons === summary.totalLessons
                          ? "emerald"
                          : "learn"
                      }
                    />
                  </div>
                  {continueLessonId ? (
                    <Link
                      href={`/learn/${publication.slug}/${continueLessonId}`}
                      className="brand-gradient mt-5 flex h-11 items-center justify-center gap-2 rounded-full text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-all hover:-translate-y-px hover:shadow-md hover:shadow-brand-600/30 active:scale-[0.98]"
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
                  <p className="text-sm font-medium text-stone-700">
                    You created this course
                  </p>
                  <p className="mt-2 text-sm text-stone-500">
                    This is the live version learners see (v{publication.version}).
                  </p>
                  {continueLessonId ? (
                    <Link
                      href={`/learn/${publication.slug}/${continueLessonId}`}
                      className="mt-5 flex h-11 items-center justify-center rounded-full border border-stone-300/80 bg-white text-sm font-medium text-stone-700 transition-all hover:-translate-y-px hover:bg-stone-50 hover:shadow-sm active:scale-[0.98]"
                    >
                      Preview as a learner
                    </Link>
                  ) : null}
                </>
              ) : user ? (
                <>
                  <p className="text-base font-semibold text-stone-900">
                    Free while in beta
                  </p>
                  <p className="mt-1.5 text-sm text-stone-500">
                    Enroll to unlock every lesson and track your progress.
                  </p>
                  <EnrollButton courseId={publication.course_id} className="mt-5 w-full" />
                </>
              ) : (
                <>
                  <p className="text-base font-semibold text-stone-900">Ready to start?</p>
                  <p className="mt-1.5 text-sm text-stone-500">
                    Sign in to enroll and track your progress.
                  </p>
                  <Link
                    href={`/login?redirectTo=/learn/${publication.slug}`}
                    className="brand-gradient mt-5 flex h-11 items-center justify-center rounded-full text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-all hover:-translate-y-px hover:shadow-md hover:shadow-brand-600/30 active:scale-[0.98]"
                  >
                    Sign in to enroll
                  </Link>
                </>
              )}

              {includes.length > 0 ? (
                <div className="mt-6 border-t border-stone-100 pt-5">
                  <p className="eyebrow text-stone-400">This course includes</p>
                  <ul className="mt-3 space-y-2.5">
                    {includes.map((item) => {
                      const Icon = INCLUDE_ICONS[item.icon] ?? FileText;
                      return (
                        <li
                          key={`${item.icon}-${item.label}`}
                          className="flex items-center gap-2.5 text-sm text-stone-600"
                        >
                          <Icon className="size-4 shrink-0 text-stone-400" aria-hidden />
                          {item.label}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {publishedDate ? (
                <p className="mt-5 text-xs text-stone-400">
                  v{publication.version} · updated {publishedDate}
                </p>
              ) : null}
            </div>
          </Card>
        </div>

        {/* ── What you'll learn (the plan's real outcomes) ── */}
        {outcomes.length > 0 ? (
          <section className="mt-16 sm:mt-20">
            <p className="eyebrow text-brand-700">Outcomes</p>
            <h2 className="font-display mt-2 text-2xl font-light text-stone-900 sm:text-3xl">
              What you&apos;ll learn
            </h2>
            <Card variant="tinted" className="mt-6 p-6 sm:p-8">
              <ul className="grid gap-x-8 gap-y-3.5 sm:grid-cols-2">
                {outcomes.map((outcome) => (
                  <li key={outcome} className="flex items-start gap-3">
                    <Check
                      className="mt-0.5 size-5 shrink-0 text-emerald-500"
                      aria-hidden
                    />
                    <span className="text-[15px] leading-relaxed text-stone-700">
                      {outcome}
                    </span>
                  </li>
                ))}
              </ul>
              {prerequisites.length > 0 ? (
                <div className="mt-6 border-t border-stone-200/60 pt-5">
                  <p className="eyebrow text-stone-400">Before you start</p>
                  <ul className="mt-2 space-y-1.5">
                    {prerequisites.map((prereq) => (
                      <li key={prereq} className="text-sm leading-relaxed text-stone-600">
                        {prereq}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          </section>
        ) : null}

        {/* ── Curriculum ── */}
        <section className="mt-16 sm:mt-20">
          <p className="eyebrow text-brand-700">Curriculum</p>
          <h2 className="font-display mt-2 text-2xl font-light text-stone-900 sm:text-3xl">
            Course content
          </h2>
          <p className="mt-2 text-sm text-stone-500">
            {snapshot.modules.length} {snapshot.modules.length === 1 ? "module" : "modules"} ·{" "}
            {allLessons.length} {allLessons.length === 1 ? "lesson" : "lessons"}
            {totalMinutes > 0 ? <> · ≈{formatTotalMinutes(totalMinutes)} total</> : null}
          </p>
          <div className="mt-6">
            <CourseOutline
              modules={outlineModules}
              enrolled={enrolled}
              continueLessonId={continueLessonId}
            />
          </div>
        </section>

        {/* ── Instructor ── */}
        {extras ? (
          <section id="instructor" className="mt-16 scroll-mt-24 sm:mt-20">
            <p className="eyebrow text-brand-700">Meet your instructor</p>
            <h2 className="font-display mt-2 text-2xl font-light text-stone-900 sm:text-3xl">
              {extras.creator.name}
            </h2>
            <div className="mt-6">
              <InstructorCard creator={extras.creator} />
            </div>
          </section>
        ) : null}

        {/* ── Your review (M9) — persistent home: view/edit, or the quiet
               inline ask while eligible-and-unreviewed ── */}
        {reviewState ? (
          <CourseReviewSection
            courseId={publication.course_id}
            creatorName={reviewState.creatorName}
            review={reviewState.review}
            eligible={reviewState.eligible}
          />
        ) : null}
      </div>
    </div>
  );
}
