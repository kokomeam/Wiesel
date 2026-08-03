"use client";

/**
 * Open/close state for the autonomy settings Drawer, shared so surfaces
 * beyond the rail pill (e.g. an activity entry's "Change autonomy settings"
 * link — UI-1 W3.7) can open it. Not persisted.
 */

import { create } from "zustand";

interface AutonomyDrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useAutonomyDrawer = create<AutonomyDrawerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
