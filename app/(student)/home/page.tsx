/**
 * /home — the student dashboard: continue-hero, stats band (streak / lessons /
 * quiz accuracy / in-progress), "Jump back in" course grid, "Worth a review"
 * quiz queue, and the AI-tutor preview rail.
 *
 * Server component (like the /learn pages): my_learning() + my_activity_days()
 * RPCs plus own quiz_attempts / homework_submissions rows, then publication
 * snapshots (RLS-readable, strict Zod parse) resolve the continue lesson and
 * quiz titles. Everything degrades gracefully — the roles migration may not be
 * applied yet (is_live ?? true, activity RPC error → streak hidden).
 */

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Compass,
  Flame,
  GraduationCap,
  PlayCircle,
  Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import {
  computeStreak,
  latestAttemptsPerBlock,
  masteryReviewItems,
  pickReviewSource,
  quizAccuracyPct,
  reviewQueue,
  summarizeLearning,
  type HomeReviewItem,
  type MasteryLevelRow,
  type MasteryReviewRow,
} from "@/lib/learn/studentHome";
import { getLivePublicationByCourse, parsePublicationSnapshot } from "@/lib/learn/resolve";
import {
  buildCourseProgressSummary,
  type CourseProgressSummary,
} from "@/lib/learn/summary";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/supabase/sessionProfile";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { MyLearningCard } from "@/components/learn/CourseCards";
import { TutorPanel } from "@/components/student/TutorPanel";

export const dynamic = "force-dynamic";

/* ── Snapshot lookups ───────────────────────────────────────────────────── */

interface QuizInfo {
  lessonId: string;
  lessonTitle: string;
  quizTitle: string;
}

function indexQuizzes(snapshot: PublicationSnapshot): Map<string, QuizInfo> {
  const map = new Map<string, QuizInfo>();
  for (const courseModule of snapshot.modules) {
    for (const lesson of courseModule.lessons) {
      for (const block of lesson.blocks) {
        if (block.type === "quiz") {
          map.set(block.id, {
            lessonId: lesson.id,
            lessonTitle: lesson.title,
            quizTitle: block.title?.trim() || "Knowledge check",
          });
        }
      }
    }
  }
  return map;
}

function findLesson(
  snapshot: PublicationSnapshot,
  lessonId: string
): { lessonTitle: string; moduleTitle: string } | null {
  for (const courseModule of snapshot.modules) {
    for (const lesson of courseModule.lessons) {
      if (lesson.id === lessonId) {
        return { lessonTitle: lesson.title, moduleTitle: courseModule.title };
      }
    }
  }
  return null;
}

/* ── Compact stat tile ──────────────────────────────────────────────────── */

type TileTone = "amber" | "rose" | "learn" | "emerald";

const TILE_CHIP: Record<TileTone, string> = {
  amber: "bg-amber-50 text-amber-500",
  rose: "bg-rose-50 text-rose-500",
  learn: "bg-learn-50 text-learn-600",
  emerald: "bg-emerald-50 text-emerald-600",
};

function StatTile({
  icon: Icon,
  tone,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  tone: TileTone;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-stone-500">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg",
            TILE_CHIP[tone]
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-stone-900">
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-stone-400">{sub}</p> : null}
    </Card>
  );
}

/* ── Two-tier section header (accent eyebrow + serif title) ─────────────── */

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="eyebrow text-learn-700">{eyebrow}</p>
      <h2 className="mt-1 text-xl font-light text-stone-900 [font-family:var(--font-display)] sm:text-2xl">
        {title}
      </h2>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default async function StudentHomePage() {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) redirect("/login?redirectTo=/home");

  const todayIso = new Date().toISOString().slice(0, 10);

  const [learningRes, activityRes, attemptsRes, homeworkRes, profile] =
    await Promise.all([
      supabase.rpc("my_learning"),
      supabase.rpc("my_activity_days", { p_days: 30 }),
      supabase
        .from("quiz_attempts")
        .select("block_id, course_id, score, max_score, attempt_number, submitted_at")
        .eq("user_id", user.id)
        .order("submitted_at", { ascending: false })
        .limit(30),
      supabase.from("homework_submissions").select("status").eq("user_id", user.id),
      // Request-deduped with the (student) layout's fetch — free on full loads.
      getSessionProfile(),
    ]);

  const learning = learningRes.data ?? [];
  const learningError = Boolean(learningRes.error);
  const attempts = attemptsRes.data ?? [];
  const homework = homeworkRes.data ?? [];
  // The activity RPC ships with the roles migration — tolerate its absence.
  const activityUnavailable = Boolean(activityRes.error);
  const activityDays = activityUnavailable
    ? []
    : (activityRes.data ?? []).map((row) => row.activity_date);

  const displayName =
    profile?.displayName || user.email?.split("@")[0] || "there";
  const firstName = displayName.split(/\s+/)[0];

  /* ── Hero: the most recent live, unfinished course ── */
  const liveRows = learning.filter((row) => row.is_live ?? true);
  const heroRow =
    liveRows.find((row) => row.enrollment_status !== "completed") ??
    liveRows[0] ??
    null;

  const snapshotByCourse = new Map<string, PublicationSnapshot>();
  let heroSummary: CourseProgressSummary | null = null;
  if (heroRow) {
    try {
      const [publication, progressRes] = await Promise.all([
        getLivePublicationByCourse(supabase, heroRow.course_id),
        supabase
          .from("learn_progress")
          .select("lesson_id, status, pct, last_activity_at")
          .eq("user_id", user.id)
          .eq("course_id", heroRow.course_id),
      ]);
      if (publication) {
        const snapshot = parsePublicationSnapshot(publication);
        snapshotByCourse.set(heroRow.course_id, snapshot);
        heroSummary = buildCourseProgressSummary(snapshot, progressRes.data ?? []);
      }
    } catch (err) {
      console.error("[home] hero snapshot resolution failed", err);
    }
  }

  const heroSnapshot = heroRow ? snapshotByCourse.get(heroRow.course_id) : undefined;
  // null continueLessonId from the summary = course DONE (never lesson 1).
  const heroComplete = heroSummary !== null && heroSummary.continueLessonId === null;
  const continueTarget =
    heroSummary?.continueLessonId && heroSnapshot
      ? findLesson(heroSnapshot, heroSummary.continueLessonId)
      : null;
  const heroPct = heroSummary
    ? heroSummary.pct
    : heroRow && heroRow.total_lessons > 0
      ? Math.round((heroRow.completed_lessons / heroRow.total_lessons) * 100)
      : 0;

  /* ── Worth a review: latest attempt per quiz below 70%, worst first ── */
  const latest = latestAttemptsPerBlock(attempts);
  const queue = reviewQueue(latest);
  const learningByCourse = new Map(learning.map((row) => [row.course_id, row]));
  const reviewCandidates = queue.filter((item) => {
    const row = learningByCourse.get(item.course_id);
    return Boolean(row) && (row?.is_live ?? true);
  });

  // Cap snapshot fetches at 3 distinct courses (the hero's is already loaded).
  const reviewCourseIds: string[] = [];
  for (const item of reviewCandidates) {
    if (!reviewCourseIds.includes(item.course_id)) reviewCourseIds.push(item.course_id);
    if (reviewCourseIds.length >= 3) break;
  }
  await Promise.all(
    reviewCourseIds
      .filter((courseId) => !snapshotByCourse.has(courseId))
      .map(async (courseId) => {
        try {
          const publication = await getLivePublicationByCourse(supabase, courseId);
          if (publication) {
            snapshotByCourse.set(courseId, parsePublicationSnapshot(publication));
          }
        } catch (err) {
          console.error("[home] review snapshot resolution failed", err);
        }
      })
  );
  const quizIndexByCourse = new Map(
    [...snapshotByCourse].map(([courseId, snapshot]) => [courseId, indexQuizzes(snapshot)])
  );

  const heuristicItems: HomeReviewItem[] = reviewCandidates.flatMap((item) => {
    const info = quizIndexByCourse.get(item.course_id)?.get(item.block_id);
    const row = learningByCourse.get(item.course_id);
    // Skip anything unresolvable (e.g. the quiz left the current version).
    if (!info || !row) return [];
    return [
      {
        key: item.block_id,
        quizTitle: info.quizTitle,
        lessonTitle: info.lessonTitle,
        courseTitle: row.title,
        scorePct: Math.round(item.scoreRatio * 100),
        href: `/learn/${row.slug}/${info.lessonId}`,
      },
    ];
  });

  // ── Graph-aware mastery review queue (TUTOR-1 W2) ──
  // When the learner has any materialized mastery review rows, they SUPERSEDE the
  // quiz heuristic (the tutor now knows which concepts are fading + high-leverage).
  // Zero rows → the heuristic stays (cold start / day one). Best-effort: any RPC
  // error degrades silently to the heuristic (the queue tables may be unmaterialized).
  const liveCourseRows = learning.filter((row) => row.is_live ?? true);
  const masteryReviewCourseIds = liveCourseRows.map((row) => row.course_id).slice(0, 3);
  const masteryItems: HomeReviewItem[] = (
    await Promise.all(
      masteryReviewCourseIds.map(async (courseId): Promise<HomeReviewItem[]> => {
        const row = learningByCourse.get(courseId);
        if (!row) return [];
        try {
          const [queueRes, levelsRes] = await Promise.all([
            supabase.rpc("my_review_queue", { p_course_id: courseId }),
            supabase
              .from("learner_mastery")
              .select("node_id, decayed_p")
              .eq("user_id", user.id)
              .eq("course_id", courseId),
          ]);
          if (queueRes.error || !queueRes.data) return [];
          // The definer RPC joins concept_nodes.title; `title` may be absent on a
          // DB where the title column hasn't been re-applied — the mapper tolerates it.
          const queueRows = queueRes.data as unknown as MasteryReviewRow[];
          const levels = (levelsRes.data ?? []) as MasteryLevelRow[];
          return masteryReviewItems(queueRows, row.title, `/learn/${row.slug}`, levels);
        } catch (err) {
          console.error("[home] mastery review queue failed", err);
          return [];
        }
      })
    )
  ).flat();

  const reviewSource = pickReviewSource(masteryItems, heuristicItems);
  const shownReviewItems = reviewSource.rows.slice(0, 4);
  const homeworkPending = homework.filter((row) => row.status === "submitted").length;

  /* ── Stats ── */
  const streak = computeStreak(activityDays, todayIso);
  const summary = summarizeLearning(learning);
  const accuracy = quizAccuracyPct(latest);

  const hasEnrollments = learning.length > 0;

  return (
    <div
      className="paper-glow mx-auto w-full max-w-6xl px-6 py-8"
      style={{ "--glow-color": "rgba(125,211,252,0.25)" } as React.CSSProperties}
    >
      {/* ── Greeting ── */}
      <header>
        <p className="eyebrow text-learn-700">Student home</p>
        <h1 className="mt-1 text-3xl [font-family:var(--font-display)] font-light text-stone-900">
          Welcome back, {firstName}
        </h1>
      </header>

      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── Main column ── */}
        <div className="min-w-0 space-y-8">
          {learningError ? (
            <Card className="border-amber-200 bg-amber-50/60 p-5">
              <p className="text-sm font-medium text-amber-800">
                Couldn&apos;t load your courses
              </p>
              <p className="mt-1 text-sm text-amber-700">
                Something went wrong on our side. Refresh the page to try again.
              </p>
            </Card>
          ) : !hasEnrollments ? (
            /* ── Onboarding empty state ── */
            <Card className="flex flex-col items-center gap-4 px-6 py-16 text-center">
              <div className="learn-gradient grid size-12 place-items-center rounded-2xl text-white">
                <Compass className="size-6" aria-hidden />
              </div>
              <h2 className="text-2xl [font-family:var(--font-display)] font-light text-stone-900">
                Start your learning journey
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-stone-500">
                Enroll in a course and this page becomes your home base — pick up
                where you left off, keep a daily streak, and see exactly what to
                review next.
              </p>
              <Link
                href="/explore"
                className="learn-gradient mt-1 rounded-full px-6 py-2.5 text-sm font-medium text-white shadow-sm shadow-learn-600/25 hover:opacity-95"
              >
                Find your first course
              </Link>
            </Card>
          ) : (
            <>
              {/* ── Continue hero ── */}
              {heroRow ? (
                <section aria-label="Continue learning">
                  <Card className="overflow-hidden">
                    <div className="flex items-stretch">
                      {/* cover_image_url ships with a pending migration — tolerate absence */}
                      {heroRow.cover_image_url ? (
                        // Fixed 160px column, height stretches with the card —
                        // fill inside a relative box; neutral bg = the
                        // LQIP-equivalent placeholder (PERF-1 D3).
                        <div className="relative hidden w-40 shrink-0 self-stretch bg-stone-100 sm:block">
                          <Image
                            src={heroRow.cover_image_url}
                            alt=""
                            fill
                            sizes="160px"
                            className="object-cover"
                          />
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          "relative min-w-0 flex-1 overflow-hidden",
                          !heroRow.cover_image_url &&
                            "bg-gradient-to-r from-learn-50/70 via-white to-white"
                        )}
                      >
                        {!heroRow.cover_image_url ? (
                          <PlayCircle
                            aria-hidden
                            className="absolute -bottom-6 -right-6 size-32 text-learn-100"
                          />
                        ) : null}
                        <div className="relative flex flex-col gap-6 p-6 sm:p-7 md:flex-row md:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[11px] uppercase tracking-wider text-learn-700">
                          {heroComplete ? "Latest course" : "Pick up where you left off"}
                        </p>
                        <h2 className="mt-2 text-2xl leading-snug [font-family:var(--font-display)] font-normal text-stone-900">
                          {heroRow.title}
                        </h2>
                        {continueTarget ? (
                          <p className="mt-1.5 text-sm text-stone-500">
                            Next up:{" "}
                            <span className="font-medium text-stone-700">
                              {continueTarget.lessonTitle}
                            </span>
                            <span className="text-stone-400">
                              {" "}
                              · {continueTarget.moduleTitle}
                            </span>
                          </p>
                        ) : heroComplete ? (
                          <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                            <CheckCircle2 className="size-4" aria-hidden />
                            Course complete — nicely done!
                          </p>
                        ) : null}
                        <div className="mt-4 flex items-center gap-3">
                          <ProgressBar
                            pct={heroPct}
                            tone={heroComplete ? "emerald" : "learn"}
                            className="max-w-xs"
                          />
                          <span className="shrink-0 text-xs tabular-nums text-stone-500">
                            {heroPct}%
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0">
                        {heroComplete ? (
                          <Link
                            href={`/learn/${heroRow.slug}`}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-stone-300/80 bg-white px-5 text-sm font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50"
                          >
                            View course
                          </Link>
                        ) : (
                          <Link
                            href={
                              continueTarget && heroSummary?.continueLessonId
                                ? `/learn/${heroRow.slug}/${heroSummary.continueLessonId}`
                                : `/learn/${heroRow.slug}`
                            }
                            className="learn-gradient inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium text-white shadow-sm shadow-learn-600/25 hover:opacity-95"
                          >
                            <PlayCircle className="size-4" aria-hidden />
                            {continueTarget ? "Continue lesson" : "Continue course"}
                          </Link>
                        )}
                      </div>
                        </div>
                      </div>
                    </div>
                  </Card>
                </section>
              ) : null}

              {/* ── Stats band ── */}
              <section aria-label="Your stats">
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatTile
                    icon={Flame}
                    tone="amber"
                    label="Day streak"
                    value={activityUnavailable ? "—" : `${streak}`}
                    sub={
                      activityUnavailable
                        ? "Streaks are warming up"
                        : streak > 0
                          ? "Keep it going"
                          : "Learn today to start one"
                    }
                  />
                  <StatTile
                    icon={BookOpen}
                    tone="learn"
                    label="Lessons completed"
                    value={`${summary.lessonsCompleted}`}
                    sub={`of ${summary.lessonsTotal} enrolled`}
                  />
                  <StatTile
                    icon={Target}
                    tone="rose"
                    label="Quiz accuracy"
                    value={accuracy === null ? "—" : `${accuracy}%`}
                    sub={
                      accuracy === null
                        ? "No quizzes taken yet"
                        : "Latest attempt per quiz"
                    }
                  />
                  <StatTile
                    icon={GraduationCap}
                    tone="learn"
                    label="In progress"
                    value={`${summary.inProgress}`}
                    sub={
                      summary.completed > 0
                        ? `${summary.completed} completed`
                        : "courses underway"
                    }
                  />
                </div>
              </section>

              {/* ── Jump back in ── */}
              <section aria-label="Jump back in">
                <div className="flex items-end justify-between gap-4">
                  <SectionHeading eyebrow="Keep momentum" title="Jump back in" />
                  <Link
                    href="/my-courses"
                    className="text-xs font-medium text-learn-700 hover:text-learn-800"
                  >
                    View all →
                  </Link>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2">
                  {learning.slice(0, 6).map((course) => (
                    <MyLearningCard
                      key={course.enrollment_id}
                      course={course}
                      tone="learn"
                    />
                  ))}
                </div>
              </section>

              {/* ── Worth a review ── */}
              <section aria-label="Worth a review">
                <SectionHeading eyebrow="Sharpen up" title="Worth a review" />
                {shownReviewItems.length === 0 && homeworkPending === 0 ? (
                  <Card className="mt-3 flex items-center gap-3 px-5 py-5">
                    <CheckCircle2 className="size-5 shrink-0 text-emerald-500" aria-hidden />
                    <p className="text-sm text-emerald-700">
                      Nothing to review — you&apos;re on top of it.
                    </p>
                  </Card>
                ) : (
                  <Card className="mt-3 divide-y divide-stone-100 p-0">
                    {shownReviewItems.map((item) => (
                      <Link
                        key={item.key}
                        href={item.href}
                        className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-stone-50"
                      >
                        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-500">
                          <Target className="size-4" aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-stone-800">
                            {item.quizTitle}
                          </p>
                          <p className="truncate text-xs text-stone-500">
                            {item.lessonTitle} · {item.courseTitle}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-rose-600 ring-1 ring-inset ring-rose-100">
                          {item.scorePct}%
                        </span>
                      </Link>
                    ))}
                    {homeworkPending > 0 ? (
                      <div className="flex items-center gap-4 px-5 py-3.5">
                        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-learn-50 text-learn-600">
                          <ClipboardList className="size-4" aria-hidden />
                        </div>
                        <p className="text-sm text-stone-600">
                          {homeworkPending}{" "}
                          {homeworkPending === 1
                            ? "homework submission is"
                            : "homework submissions are"}{" "}
                          awaiting your instructor&apos;s review.
                        </p>
                      </div>
                    ) : null}
                  </Card>
                )}
              </section>
            </>
          )}
        </div>

        {/* ── Right rail: AI tutor preview ── */}
        <aside className="min-w-0">
          <TutorPanel className="xl:sticky xl:top-6" />
        </aside>
      </div>
    </div>
  );
}
