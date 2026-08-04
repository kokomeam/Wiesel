"use client";

/**
 * TUTOR-1 Wave 4 — the reflow frame. Wraps the lesson content and, when the
 * docked tutor panel is open on a wide viewport, pads the right side by the
 * panel's width so the two never overlap. Narrow viewports use the overlay
 * panel (which floats above content), so no reflow there.
 *
 * The padding is applied as an INLINE style off the store width, gated by the
 * house hydration-safe media-query hook (never setState-in-effect, never an
 * SSR mismatch). Harmless with an empty userId — the slice defaults to closed.
 */

import { useTutorStore } from "@/lib/learn/tutorStore";
import { useMediaQuery } from "@/lib/ui/useMediaQuery";

export function TutorFrame({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const slice = useTutorStore((s) => s.byUser[userId]);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const padRight = isDesktop && slice?.open ? (slice.width ?? 0) : 0;

  return (
    <div style={{ paddingRight: padRight }} className="transition-[padding] duration-200">
      {children}
    </div>
  );
}
