"use client";

import { useSyncExternalStore } from "react";

/**
 * Hydration-safe media query (the HeroPreview matchMedia pattern): the server
 * snapshot renders `serverDefault`, the client corrects after hydration —
 * never a setState-in-effect, never a mismatch.
 */
export function useMediaQuery(query: string, serverDefault = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => serverDefault
  );
}
