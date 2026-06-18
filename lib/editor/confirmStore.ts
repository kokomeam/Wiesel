"use client";

/**
 * An imperative confirmation gate: `if (await confirm({...})) doDangerousThing()`.
 *
 * One <ConfirmHost/> (mounted in the app layout) renders the dialog from this
 * store; any handler can `await confirm(...)` and get back the user's decision.
 * This is the manual counterpart to the agent's pause-to-confirm flow — both
 * funnel destructive deletes through the same ConfirmDialog.
 */

import type { ReactNode } from "react";
import { create } from "zustand";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
}

interface ConfirmState {
  open: boolean;
  options: ConfirmOptions | null;
  resolve: ((ok: boolean) => void) | null;
  request: (options: ConfirmOptions) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  open: false,
  options: null,
  resolve: null,
  request: (options) =>
    new Promise<boolean>((resolve) => {
      // Supersede any already-open request (resolve it as cancelled).
      get().resolve?.(false);
      set({ open: true, options, resolve });
    }),
  settle: (ok) => {
    const r = get().resolve;
    set({ open: false, resolve: null });
    r?.(ok);
  },
}));

/** Open the confirmation dialog and resolve to the user's choice. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().request(options);
}
