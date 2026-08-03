import { Star } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Small warm-amber star row for course ratings. Whole-star fill on
 * Math.round (deliberately simple — the numeric value always renders beside
 * it, the stars are the glanceable shape). Server-safe, no state.
 */
export function RatingStars({
  rating,
  size = "sm",
  className,
}: {
  rating: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const filled = Math.round(Math.max(0, Math.min(5, rating)));
  const starSize = size === "md" ? "size-4" : "size-3.5";
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      role="img"
      aria-label={`Rated ${rating.toFixed(1)} out of 5`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <Star
          key={i}
          aria-hidden
          className={cn(
            starSize,
            i < filled ? "fill-amber-400 text-amber-400" : "fill-stone-200 text-stone-200"
          )}
        />
      ))}
    </span>
  );
}
