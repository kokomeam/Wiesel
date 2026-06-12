"use client";

/**
 * Rehydrates the persisted UI store after mount. The store is created with
 * skipHydration, so SSR and the first client paint always agree on the
 * defaults — panel states pop in one effect later, never as a hydration
 * mismatch.
 */

import { useEffect } from "react";
import { useUIStore } from "@/lib/editor/uiStore";

export function UIHydrator() {
  useEffect(() => {
    useUIStore.persist.rehydrate();
  }, []);
  return null;
}
