"use client";

/**
 * A tiny refcount of open modal overlays (Drawers, sheets). The agent FAB
 * subscribes so it can vacate while any overlay is open — a drawer's sticky
 * action bar is exclusion territory for the FAB (UI-1 W2.5).
 */

import { create } from "zustand";

interface OverlayState {
  count: number;
  acquire: () => void;
  release: () => void;
}

export const useOverlayStore = create<OverlayState>((set) => ({
  count: 0,
  acquire: () => set((s) => ({ count: s.count + 1 })),
  release: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}));

export const useOverlayOpen = () => useOverlayStore((s) => s.count > 0);
