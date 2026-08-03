import { cn } from "@/lib/cn";

/**
 * The house progress bar — a rounded track with a gradient fill. Fill width
 * is set via inline style (values are dynamic percentages); do NOT convert to
 * an animated width (the animation conventions require transform-only motion,
 * and route transitions re-render this fresh anyway).
 *
 * tone: "brand" (creator surfaces) | "learn" (student portal) | "emerald"
 * (completed states).
 */
export function ProgressBar({
  pct,
  tone = "brand",
  className,
  trackClassName,
}: {
  pct: number;
  tone?: "brand" | "learn" | "emerald";
  className?: string;
  trackClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const fill =
    tone === "learn"
      ? "learn-gradient"
      : tone === "emerald"
        ? "bg-emerald-500"
        : "brand-gradient";
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-stone-200/70", trackClassName, className)}
    >
      <div className={cn("h-full rounded-full", fill)} style={{ width: `${clamped}%` }} />
    </div>
  );
}
