"use client";

/**
 * Measures the stage container and derives the CSS scale that maps the
 * 1280×720 logical canvas onto it. Scale stays null until the first
 * ResizeObserver notification (which the spec guarantees fires on observe),
 * so SSR and the first client paint render an invisible stage — no
 * hydration mismatch, no setState directly in the effect body.
 */

import { useEffect, useRef, useState } from "react";
import { SLIDE_W } from "@/lib/course/slide/geometry";

export function useStageScale() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setScale(width / SLIDE_W);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { containerRef, scale };
}
