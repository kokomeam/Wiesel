import { Star } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { RatingStars } from "./RatingStars";

/**
 * The "Average rating" stat tile — mirrors components/ui/Stat.tsx's layout but
 * renders stars beside the value (Stat's value/sub props are string-only).
 * Honest empty state: an em-dash + "No reviews yet", never 0.0 stars.
 */
export function RatingStat({
  avgRating,
  reviewCount,
}: {
  avgRating: number | null;
  reviewCount: number;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-xl bg-amber-50 text-amber-600">
          <Star className="size-4.5" aria-hidden />
        </span>
        <p className="text-sm font-medium text-stone-500">Average rating</p>
      </div>
      <div className="mt-2 flex items-end gap-2.5">
        <span className="text-3xl font-semibold tracking-tight text-stone-900">
          {avgRating !== null ? avgRating.toFixed(1) : "—"}
        </span>
        {avgRating !== null && (
          <RatingStars rating={avgRating} size="md" className="mb-1.5" />
        )}
      </div>
      <p className="mt-1 text-xs text-stone-400">
        {reviewCount > 0
          ? `From ${reviewCount} review${reviewCount === 1 ? "" : "s"} across your courses`
          : "No reviews yet — they arrive as learners finish"}
      </p>
    </Card>
  );
}
