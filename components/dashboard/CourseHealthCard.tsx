import Image from "next/image";
import Link from "next/link";
import { AlertTriangle, BarChart3, GraduationCap, PencilLine, Users } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { CoverArt } from "@/components/learn/CoverArt";
import { timeAgo } from "@/components/studio/analytics/format";
import type { CourseHealth } from "@/lib/analytics/creatorHome";
import { RatingStars } from "./RatingStars";

const ACTION_LINK =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40";

/**
 * One course's health card on the creator dashboard: live/draft state,
 * learners, rating, open-findings chip, and the two real actions — Edit
 * (deep-links /studio?course={id}; the old dashboard hardlinked bare /studio,
 * which opened whatever course was most recent) and Analytics.
 */
export function CourseHealthCard({ course }: { course: CourseHealth }) {
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="block size-14 shrink-0 overflow-hidden rounded-xl bg-stone-100">
            {course.coverImageUrl ? (
              // Fixed 56px box — width/height picks a ~56/112w variant
              // instead of the stored 1600w cover (PERF-1 D3).
              <Image
                src={course.coverImageUrl}
                alt=""
                width={56}
                height={56}
                className="h-full w-full object-cover"
              />
            ) : (
              <CoverArt
                courseId={course.id}
                title={course.title}
                className="h-full w-full"
              />
            )}
          </span>
          <h3 className="min-w-0 truncate text-[15px] font-medium text-stone-900 [font-family:var(--font-display)]">
            {course.title}
          </h3>
        </div>
        {course.isLive ? (
          <Badge tone="green" dot className="shrink-0">
            Live v{course.version}
          </Badge>
        ) : (
          <Badge tone="amber" dot className="shrink-0">
            Draft
          </Badge>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-stone-500">
        <span className="inline-flex items-center gap-1">
          <Users className="size-3.5 text-stone-400" aria-hidden />
          {course.learners.toLocaleString("en-US")} learner
          {course.learners === 1 ? "" : "s"}
        </span>
        {course.avgRating !== null ? (
          <span className="inline-flex items-center gap-1.5">
            <RatingStars rating={course.avgRating} />
            <span className="text-stone-400">({course.reviewCount})</span>
          </span>
        ) : (
          <span className="text-stone-400">No reviews yet</span>
        )}
      </div>

      {course.openFindings > 0 && (
        <span className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-100">
          <AlertTriangle className="size-3.5" aria-hidden />
          {course.openFindings} open finding{course.openFindings === 1 ? "" : "s"}
        </span>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <span className="text-[11px] text-stone-400">
          Updated {timeAgo(course.updatedAt)}
        </span>
        <div className="flex items-center gap-1.5">
          <Link
            href={`/studio?course=${course.id}`}
            className={`${ACTION_LINK} border border-stone-300/80 bg-white text-stone-700 hover:border-stone-400 hover:bg-stone-50`}
          >
            <PencilLine className="size-3.5" aria-hidden />
            Edit
          </Link>
          <Link
            href={`/studio/${course.id}/tutor`}
            data-ai-tool="course-open-tutor"
            className={`${ACTION_LINK} text-stone-600 hover:bg-stone-900/[0.06] hover:text-stone-900`}
          >
            <GraduationCap className="size-3.5" aria-hidden />
            Tutor
          </Link>
          <Link
            href={`/studio/${course.id}/analytics`}
            className={`${ACTION_LINK} text-stone-600 hover:bg-stone-900/[0.06] hover:text-stone-900`}
          >
            <BarChart3 className="size-3.5" aria-hidden />
            Analytics
          </Link>
        </div>
      </div>
    </Card>
  );
}
