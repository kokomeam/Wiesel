"use client";

/**
 * The agent dock's transient UI state — open/closed + a one-shot "seed"
 * message (typed into the hub's ask-bar) the docked panel auto-sends on
 * arrival. Deliberately NOT persisted (a chat dock reopening itself across
 * sessions would be noise); the conversation itself lives server-side.
 */

import { create } from "zustand";

interface AgentDockState {
  open: boolean;
  /** A message queued for the panel to send as soon as it's visible. */
  seed: string | null;
  openDock: (seed?: string) => void;
  closeDock: () => void;
  clearSeed: () => void;
}

export const useAgentDockStore = create<AgentDockState>((set) => ({
  open: false,
  seed: null,
  openDock: (seed) => set({ open: true, ...(seed?.trim() ? { seed: seed.trim() } : {}) }),
  closeDock: () => set({ open: false }),
  clearSeed: () => set({ seed: null }),
}));
