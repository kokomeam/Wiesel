"use client";

/**
 * Instructor card for the course landing — avatar, headline, cross-course
 * stats, and a bio clamped to ~4 lines with a Show more toggle (the ONLY
 * reason this is a client component). Renders name + stats even when the
 * profile has no headline/bio/avatar — never an empty box. Long-bio detection
 * is by character count (deterministic, no DOM measurement).
 */

import { useState } from "react";
import Image from "next/image";
import { BookOpen, Star, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import type { CourseLandingExtras } from "@/lib/learn/landingExtras";

const BIO_CLAMP_CHARS = 280;

function StatChip({
  icon: Icon,
  label,
  tint,
}: {
  icon: typeof Users;
  label: string;
  tint: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-sm tabular-nums text-stone-600">
      <span className={cn("grid size-6 place-items-center rounded-lg", tint)}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      {label}
    </span>
  );
}

export function InstructorCard({ creator }: { creator: CourseLandingExtras["creator"] }) {
  const [expanded, setExpanded] = useState(false);
  const bio = creator.bio?.trim() ?? "";
  const isLong = bio.length > BIO_CLAMP_CHARS;

  const stats: React.ReactNode[] = [];
  if (creator.studentCount > 0) {
    stats.push(
      <StatChip
        key="learners"
        icon={Users}
        tint="bg-brand-50 text-brand-600"
        label={`${creator.studentCount.toLocaleString("en-US")} ${
          creator.studentCount === 1 ? "learner" : "learners"
        }`}
      />
    );
  }
  if (creator.courseCount > 0) {
    stats.push(
      <StatChip
        key="courses"
        icon={BookOpen}
        tint="bg-learn-50 text-learn-600"
        label={`${creator.courseCount} ${creator.courseCount === 1 ? "course" : "courses"}`}
      />
    );
  }
  if (creator.avgRating != null && creator.reviewCount > 0) {
    stats.push(
      <StatChip
        key="rating"
        icon={Star}
        tint="bg-amber-50 text-amber-600"
        label={`${creator.avgRating.toFixed(1)} rating (${creator.reviewCount})`}
      />
    );
  }

  return (
    <Card variant="elevated" className="p-6 sm:p-8">
      <div className="flex flex-col gap-6 sm:flex-row">
        {creator.avatarUrl ? (
          // Avatar sources are ≤512px; the fixed 80px box needs only a tiny
          // variant (PERF-1 D3).
          <Image
            src={creator.avatarUrl}
            alt=""
            width={80}
            height={80}
            className="size-20 shrink-0 rounded-full object-cover shadow-[0_4px_16px_rgba(68,48,28,0.14)] ring-4 ring-white"
          />
        ) : (
          <div
            aria-hidden
            className="brand-gradient grid size-20 shrink-0 place-items-center rounded-full font-display text-3xl font-light text-white shadow-[0_4px_16px_rgba(68,48,28,0.14)] ring-4 ring-white"
          >
            {(creator.name.trim().charAt(0) || "W").toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          {/* No name fallback here: the landing's section heading already
              names the creator, so a headline-less profile would read as the
              name printed twice back-to-back. */}
          {creator.headline ? (
            <p className="text-[15px] font-medium text-stone-900">{creator.headline}</p>
          ) : null}

          {stats.length > 0 ? (
            <div
              className={cn(
                "flex flex-wrap items-center gap-x-5 gap-y-2",
                creator.headline ? "mt-3" : "mt-1"
              )}
            >
              {stats}
            </div>
          ) : null}

          {bio ? (
            <>
              <p
                className={cn(
                  "mt-4 whitespace-pre-line text-[15px] leading-relaxed text-stone-600",
                  isLong && !expanded && "line-clamp-4"
                )}
              >
                {bio}
              </p>
              {isLong ? (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-2 rounded-full px-3 py-1 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-900"
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
