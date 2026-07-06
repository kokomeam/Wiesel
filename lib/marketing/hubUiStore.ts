"use client";

/**
 * Marketing-hub disclosure state — which collapsible sections are open.
 * Mirrors the studio's `lib/editor/uiStore.ts` pattern: zustand persist with
 * `skipHydration` (the server render uses each section's default; the stored
 * state applies after an explicit rehydrate in the hub), so SSR markup never
 * mismatches localStorage.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type HubSectionKey = "activity" | "autonomy";

interface HubUiState {
  /** Only sections the user explicitly toggled — absent = use the default. */
  open: Partial<Record<HubSectionKey, boolean>>;
  setOpen: (key: HubSectionKey, value: boolean) => void;
}

export const useHubUi = create<HubUiState>()(
  persist(
    (set) => ({
      open: {},
      setOpen: (key, value) => set((s) => ({ open: { ...s.open, [key]: value } })),
    }),
    { name: "wisesel-marketing-hub-ui", skipHydration: true }
  )
);
