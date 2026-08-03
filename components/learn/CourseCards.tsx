/**
 * Shared course cards — the ONE place the "course tile" is drawn, consumed by
 * the creator marketplace (app/(app)/marketplace) and the student portal
 * (/home, /my-courses, /explore).
 *
 *   MyLearningCard — a my_learning() row: progress, Continue/Completed state,
 *                    star rating, and the honest "No longer available" state
 *                    when the publication was unpublished (is_live === false —
 *                    rendered WITHOUT a link; /learn/{slug} would 404).
 *   ListingCard    — a marketplace_listings() row: creator, counts, rating,
 *                    and a caller-supplied CTA label (voice differs per portal).
 *
 * Presentational + server-safe (no hooks in THIS file — the card link is the
 * client-island IntentLink so hover/touch intent warms the /learn route,
 * debounced app-wide; PERF-1 B4); tolerate the pre-migration RPC
 * shape (is_live / avg_rating / review_count / cover_image_url /
 * creator_avatar_url may be missing → is_live defaults true, ratings simply
 * don't render, covers fall back to the deterministic gradient CoverArt).
 */

import Image from "next/image";
import { BookOpen, CheckCircle2, Layers, PlayCircle, Star } from "lucide-react";
import { IntentLink } from "@/components/perf/IntentLink";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CoverArt } from "@/components/learn/CoverArt";

/** Card grids render 1 / 2 / 3-up (sm/xl breakpoints in every consumer) —
 *  the sizes hint matches so next/image serves ~card-width variants
 *  (PERF-1 D3), not the stored 1600w cover. */
const CARD_COVER_SIZES = "(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 33vw";

/** Deterministic accent per course (no Math.random — hydration-safe). */
const CARD_ACCENTS = [
  "from-amber-500 to-orange-600",
  "from-orange-500 to-rose-500",
  "from-yellow-500 to-amber-600",
  "from-rose-400 to-orange-500",
  "from-amber-400 to-orange-500",
  // Cool accents stay on-system: learn ramp + ink (emerald is reserved for
  // success semantics, so no green gradients here).
  "from-learn-400 to-learn-600",
  "from-stone-700 to-stone-900",
];
export function accentFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return CARD_ACCENTS[hash % CARD_ACCENTS.length];
}

/* ────────────────────────────── Cover media ────────────────────────────── */

/** The card's media zone: the uploaded cover when present, else the
 *  deterministic gradient CoverArt fallback. Decorative — the title always
 *  renders as text in the card body. */
function CoverMedia({
  coverImageUrl,
  courseId,
  title,
  className,
}: {
  coverImageUrl?: string | null;
  courseId: string;
  title: string;
  className?: string;
}) {
  if (coverImageUrl) {
    // fill inside the caller's fixed-aspect relative box; the container's
    // neutral bg is the LQIP-equivalent placeholder (no stored blurhashes).
    return (
      <Image
        src={coverImageUrl}
        alt=""
        fill
        sizes={CARD_COVER_SIZES}
        className={cn("object-cover", className)}
      />
    );
  }
  return <CoverArt courseId={courseId} title={title} className={cn("h-full w-full", className)} />;
}

/** Level chip overlaid on the media zone — frosted over a photo, dark-scrim
 *  over the gradient art (white-on-white/20 was unreadable on the light
 *  amber/yellow accents; a stone-900 scrim reads on every accent). */
function LevelBadge({ level, overImage }: { level: string; overImage: boolean }) {
  return (
    <span
      className={cn(
        "absolute right-3 top-3 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize backdrop-blur",
        overImage ? "bg-white/80 text-stone-700" : "bg-stone-900/30 text-white"
      )}
    >
      {level}
    </span>
  );
}

/* ────────────────────────────── Star rating ────────────────────────────── */

/** "★★★★☆ 4.8 (12)" — renders nothing until a course has at least 1 review. */
export function StarRating({
  avgRating,
  reviewCount,
  className,
}: {
  avgRating?: number | null;
  reviewCount?: number | null;
  className?: string;
}) {
  if (avgRating == null || !reviewCount || reviewCount <= 0) return null;
  const filled = Math.round(avgRating);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <span className="flex items-center gap-px" aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            className={cn(
              "size-3",
              i <= filled ? "fill-amber-400 text-amber-400" : "text-stone-300"
            )}
          />
        ))}
      </span>
      <span className="text-xs tabular-nums text-stone-500" aria-hidden>
        {avgRating.toFixed(1)} ({reviewCount})
      </span>
      <span className="sr-only">
        Rated {avgRating.toFixed(1)} out of 5 from {reviewCount}{" "}
        {reviewCount === 1 ? "review" : "reviews"}
      </span>
    </span>
  );
}

/* ─────────────────────────── My-learning card ──────────────────────────── */

/** Structural subset of a my_learning() row (extra RPC fields ride along). */
export interface MyLearningCardData {
  enrollment_id: string;
  enrollment_status: string;
  course_id: string;
  slug: string;
  title: string;
  level: string | null;
  total_lessons: number;
  completed_lessons: number;
  is_live?: boolean | null;
  avg_rating?: number | null;
  review_count?: number | null;
  cover_image_url?: string | null;
}

export function MyLearningCard({
  course,
  tone = "brand",
}: {
  course: MyLearningCardData;
  /** Progress/Continue accent: brand orange (creator surfaces) or learn blue
   *  (student portal). */
  tone?: "brand" | "learn";
}) {
  const live = course.is_live ?? true;
  const completed = course.enrollment_status === "completed";
  const pct = completed
    ? 100
    : course.total_lessons > 0
      ? Math.round((course.completed_lessons / course.total_lessons) * 100)
      : 0;

  const card = (
    <Card
      className={cn(
        "flex h-full flex-col overflow-hidden",
        live ? "transition-all group-hover:shadow-md" : "opacity-90"
      )}
    >
      <div className="relative aspect-[2/1] overflow-hidden bg-stone-100">
        <CoverMedia
          coverImageUrl={course.cover_image_url}
          courseId={course.course_id}
          title={course.title}
          className={cn(!live && "opacity-60 grayscale")}
        />
        {course.level ? (
          <LevelBadge level={course.level} overImage={Boolean(course.cover_image_url)} />
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 min-h-[2.5rem] text-base font-semibold leading-tight text-stone-900">
          {course.title}
        </h3>
        {live ? (
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-stone-500">
              <span>
                {course.completed_lessons}/{course.total_lessons} lessons
              </span>
              {completed ? (
                <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                  <CheckCircle2 className="size-3.5" aria-hidden /> Completed
                </span>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 font-medium",
                    tone === "learn" ? "text-learn-700" : "text-brand-700"
                  )}
                >
                  <PlayCircle className="size-3.5" aria-hidden /> Continue
                </span>
              )}
            </div>
            <ProgressBar
              className="mt-2"
              pct={pct}
              tone={completed ? "emerald" : tone}
            />
            <StarRating
              className="mt-3"
              avgRating={course.avg_rating}
              reviewCount={course.review_count}
            />
          </div>
        ) : (
          <div className="mt-2">
            <span className="inline-flex items-center rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-500 ring-1 ring-inset ring-stone-200">
              No longer available
            </span>
            <p className="mt-2 text-xs leading-relaxed text-stone-500">
              The creator took this course offline. Your progress (
              {course.completed_lessons}/{course.total_lessons} lessons) is saved
              if it returns.
            </p>
          </div>
        )}
      </div>
    </Card>
  );

  if (!live) return <div className="h-full">{card}</div>;
  return (
    <IntentLink href={`/learn/${course.slug}`} className="group block h-full">
      {card}
    </IntentLink>
  );
}

/* ──────────────────────────── Catalog listing ──────────────────────────── */

/** Structural subset of a marketplace_listings() row. */
export interface ListingCardData {
  publication_id: string;
  course_id: string;
  slug: string;
  title: string;
  description: string | null;
  level: string | null;
  creator_name: string;
  module_count: number;
  lesson_count: number;
  avg_rating?: number | null;
  review_count?: number | null;
  cover_image_url?: string | null;
  creator_avatar_url?: string | null;
  creator_headline?: string | null;
}

export function ListingCard({
  listing,
  ctaLabel,
}: {
  listing: ListingCardData;
  /** Footer pill copy — e.g. "View & enroll", "Enrolled — continue",
   *  "Your course". */
  ctaLabel: string;
}) {
  return (
    <IntentLink
      href={`/learn/${listing.slug}`}
      className="group block h-full"
      data-ai-tool="marketplace-course-card"
    >
      <Card className="flex h-full flex-col overflow-hidden transition-all group-hover:shadow-md">
        <div className="relative aspect-[16/9] overflow-hidden bg-stone-100">
          <CoverMedia
            coverImageUrl={listing.cover_image_url}
            courseId={listing.course_id}
            title={listing.title}
          />
          {listing.level ? (
            <LevelBadge level={listing.level} overImage={Boolean(listing.cover_image_url)} />
          ) : null}
        </div>
        <div className="flex flex-1 flex-col p-4">
          <h3 className="line-clamp-2 min-h-[2.5rem] text-base font-semibold leading-tight text-stone-900">
            {listing.title}
          </h3>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              {listing.creator_avatar_url ? (
                <Image
                  src={listing.creator_avatar_url}
                  alt=""
                  width={20}
                  height={20}
                  className="size-5 shrink-0 rounded-full object-cover"
                />
              ) : (
                <span
                  aria-hidden
                  className="grid size-5 shrink-0 place-items-center rounded-full bg-stone-200 text-[10px] font-semibold text-stone-600"
                >
                  {(listing.creator_name.trim()[0] ?? "?").toUpperCase()}
                </span>
              )}
              <span className="min-w-0 truncate text-xs text-stone-500">
                by {listing.creator_name}
              </span>
            </span>
            <StarRating
              avgRating={listing.avg_rating}
              reviewCount={listing.review_count}
            />
          </div>
          {listing.description ? (
            <p className="mt-2 line-clamp-2 text-sm text-stone-600">
              {listing.description}
            </p>
          ) : null}
          <div className="mb-4 mt-3 flex items-center gap-3 text-xs text-stone-500">
            <span className="inline-flex items-center gap-1">
              <Layers className="size-3.5" aria-hidden />
              {listing.module_count} {listing.module_count === 1 ? "module" : "modules"}
            </span>
            <span className="inline-flex items-center gap-1">
              <BookOpen className="size-3.5" aria-hidden />
              {listing.lesson_count} {listing.lesson_count === 1 ? "lesson" : "lessons"}
            </span>
          </div>
          <div className="mt-auto flex items-center justify-between border-t border-stone-100 pt-4">
            <span className="text-sm font-semibold text-emerald-700">Free</span>
            <span className="rounded-full border border-stone-300/80 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-700 transition-all group-hover:border-transparent group-hover:bg-gradient-to-br group-hover:from-amber-500 group-hover:to-orange-600 group-hover:text-white">
              {ctaLabel}
            </span>
          </div>
        </div>
      </Card>
    </IntentLink>
  );
}
