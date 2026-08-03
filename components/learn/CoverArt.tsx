/**
 * Deterministic fallback cover art for courses without an uploaded cover
 * image: warm gradient keyed off the course id (accentFor — no Math.random,
 * hydration-safe), an oversized Fraunces initial at low opacity, and the
 * grain texture. Server-safe; the course title is NOT rendered as text here
 * (consumers place it beside/below the art). The initial is drawn in an SVG
 * viewBox so it scales with the container at any size.
 *
 * Callers must SIZE it via className (h-full/aspect-*) and must NOT pass
 * `absolute` — the base `relative` would conflict (equal specificity,
 * stylesheet order decides) and can collapse the box to zero height.
 */

import { cn } from "@/lib/cn";
import { accentFor } from "@/components/learn/CourseCards";

export function CoverArt({
  courseId,
  title,
  className,
}: {
  courseId: string;
  title: string;
  className?: string;
}) {
  const initial = (title.trim().charAt(0) || "W").toUpperCase();
  return (
    <div
      aria-hidden
      className={cn(
        "grain relative overflow-hidden bg-gradient-to-br",
        accentFor(courseId),
        className
      )}
    >
      <svg
        viewBox="0 0 160 90"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
      >
        <text
          x="128"
          y="96"
          textAnchor="middle"
          fontSize="104"
          fontWeight={300}
          fill="rgba(255,255,255,0.22)"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {initial}
        </text>
      </svg>
    </div>
  );
}
