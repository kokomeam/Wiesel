import { Star } from "lucide-react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { timeAgo } from "./format";

/** One review row for the recent-text list (author-read via RLS). */
export interface ReviewRow {
  id: string;
  user_id: string;
  rating: number;
  review_text: string | null;
  updated_at: string;
}

export interface ReviewsRollup {
  review_count: number;
  avg_rating: number;
  /** {"1": n, …, "5": n} */
  rating_distribution: Record<string, number>;
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} of 5 stars`} role="img">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden
          className={cn(
            "size-3.5",
            n <= rating ? "fill-amber-400 text-amber-400" : "fill-transparent text-stone-300"
          )}
        />
      ))}
    </span>
  );
}

/**
 * Reviews card on the analytics Overview (Milestone 9): average + 1–5
 * distribution from rollup_course_reviews (nightly + manual refresh — the
 * raw-stats-in-SQL rule), recent review text read live under author RLS,
 * paginated via ?reviewsPage=.
 */
export function ReviewsCard({
  courseId,
  rollup,
  recent,
  learnerNames,
  page,
  hasMore,
}: {
  courseId: string;
  rollup: ReviewsRollup | null;
  recent: ReviewRow[];
  learnerNames: Record<string, string>;
  page: number;
  hasMore: boolean;
}) {
  if (!rollup && recent.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Reviews"
          subtitle="Learners are asked for a 1–5 rating as they finish the course"
        />
        <p className="px-5 pb-5 text-sm text-stone-500">
          No reviews yet — they appear here once learners near completion.
        </p>
      </Card>
    );
  }

  const distribution = rollup?.rating_distribution ?? {};
  const maxBucket = Math.max(1, ...Object.values(distribution).map((n) => Number(n) || 0));

  return (
    <Card>
      <CardHeader
        title="Reviews"
        subtitle={
          rollup
            ? `${rollup.review_count} review${rollup.review_count === 1 ? "" : "s"} — private to you`
            : "Awaiting the next analytics refresh"
        }
      />
      <div className="grid grid-cols-1 gap-6 px-5 pb-5 md:grid-cols-[14rem_1fr]">
        {/* ── Average + distribution (rollup) ── */}
        {rollup ? (
          <div>
            <p className="flex items-baseline gap-2">
              <span className="text-4xl font-light tabular-nums text-stone-900 [font-family:var(--font-display)]">
                {Number(rollup.avg_rating).toFixed(1)}
              </span>
              <Stars rating={Math.round(Number(rollup.avg_rating))} />
            </p>
            <ul className="mt-4 space-y-1.5">
              {[5, 4, 3, 2, 1].map((star) => {
                const count = Number(distribution[String(star)] ?? 0);
                return (
                  <li key={star} className="flex items-center gap-2 text-xs text-stone-500">
                    <span className="w-3 shrink-0 text-right tabular-nums">{star}</span>
                    <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" aria-hidden />
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                      <span
                        className="block h-full rounded-full bg-amber-400"
                        style={{ width: `${(100 * count) / maxBucket}%` }}
                      />
                    </span>
                    <span className="w-6 shrink-0 text-right tabular-nums">{count}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-stone-500">
            Stats appear after the next refresh (nightly, or “Refresh data”).
          </p>
        )}

        {/* ── Recent review text (live, author RLS, paginated) ── */}
        <div>
          {recent.length === 0 ? (
            <p className="text-sm text-stone-500">
              {page > 1 ? "No more reviews." : "No written reviews yet — ratings only so far."}
            </p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {recent.map((r) => (
                <li key={r.id} className="py-2.5 first:pt-0">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Stars rating={r.rating} />
                    <span className="text-xs font-medium text-stone-600">
                      {learnerNames[r.user_id] ?? "Learner"}
                    </span>
                    <span className="text-xs text-stone-400">{timeAgo(r.updated_at)}</span>
                  </p>
                  {r.review_text ? (
                    <p className="mt-1 text-sm leading-relaxed text-stone-600">{r.review_text}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {page > 1 || hasMore ? (
            <div className="mt-3 flex items-center justify-between border-t border-stone-100 pt-3 text-sm">
              {page > 1 ? (
                <Link
                  href={`/studio/${courseId}/analytics?reviewsPage=${page - 1}`}
                  className="font-medium text-stone-600 hover:text-stone-900"
                >
                  Newer
                </Link>
              ) : (
                <span />
              )}
              <span className="text-xs text-stone-400">Page {page}</span>
              {hasMore ? (
                <Link
                  href={`/studio/${courseId}/analytics?reviewsPage=${page + 1}`}
                  className="font-medium text-stone-600 hover:text-stone-900"
                >
                  Older
                </Link>
              ) : (
                <span />
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
