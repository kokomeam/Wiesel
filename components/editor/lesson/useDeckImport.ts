"use client";

/**
 * Client hook for one imported deck. Fetches the server view (status + pages
 * with short-lived SIGNED URLs), POLLS while the worker is processing, exposes
 * the retry / replace / download / remove actions, and re-signs URLs on demand
 * (a stale 1h URL that 403s just triggers a refetch).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckImportStatus, DeckImportView } from "@/lib/course/imports/deckImportTypes";

interface DeckImportState {
  view: DeckImportView | null;
  loading: boolean;
  error: string | null;
}

export interface UseDeckImport extends DeckImportState {
  /** Re-fetch the view (re-signs every page URL). */
  refetch: () => Promise<DeckImportView | null>;
  /** Re-run conversion (failed → processing). Returns true on success. */
  retry: () => Promise<boolean>;
  /** Replace the source file. Returns the refreshed view (or null on failure). */
  replace: (file: File) => Promise<DeckImportView | null>;
  /** Get a signed download URL for the original and open it. */
  downloadOriginal: () => Promise<void>;
  /** Delete the deck import (storage + row). Returns true on success. */
  remove: () => Promise<boolean>;
}

const ACTIVE_STATUSES: DeckImportStatus[] = ["uploaded", "processing"];

export function useDeckImport(
  deckImportId: string,
  opts?: { initialStatus?: DeckImportStatus; pollMs?: number }
): UseDeckImport {
  const pollMs = opts?.pollMs ?? 2500;
  const [state, setState] = useState<DeckImportState>({ view: null, loading: true, error: null });
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const fetchOnce = useCallback(async (): Promise<DeckImportView | null> => {
    if (inFlight.current) return null;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/deck-imports/${deckImportId}`, { cache: "no-store" });
      if (!mounted.current) return null;
      if (!res.ok) {
        setState((s) => ({
          view: s.view,
          loading: false,
          error: res.status === 404 ? "This deck is no longer available." : "Couldn't load this deck.",
        }));
        return null;
      }
      const view = (await res.json()) as DeckImportView;
      if (!mounted.current) return view;
      setState({ view, loading: false, error: null });
      return view;
    } catch {
      if (mounted.current) setState((s) => ({ ...s, loading: false, error: "Couldn't load this deck." }));
      return null;
    } finally {
      inFlight.current = false;
    }
  }, [deckImportId]);

  // initial load (deferred a tick so it's a side-effect, not a synchronous
  // setState inside the effect body)
  useEffect(() => {
    mounted.current = true;
    const t = setTimeout(() => void fetchOnce(), 0);
    return () => {
      mounted.current = false;
      clearTimeout(t);
    };
  }, [fetchOnce]);

  // poll only while the worker is (or might be) running
  const liveStatus = state.view?.status ?? opts?.initialStatus ?? "processing";
  const isActive = ACTIVE_STATUSES.includes(liveStatus);
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => void fetchOnce(), pollMs);
    return () => clearInterval(interval);
  }, [isActive, fetchOnce, pollMs]);

  const refetch = useCallback(() => fetchOnce(), [fetchOnce]);

  const retry = useCallback(async () => {
    const res = await fetch(`/api/deck-imports/${deckImportId}/retry`, { method: "POST" });
    if (!res.ok) return false;
    const { deckImport } = (await res.json()) as { deckImport: DeckImportView };
    if (mounted.current) setState({ view: deckImport, loading: false, error: null });
    return true;
  }, [deckImportId]);

  const replace = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/deck-imports/${deckImportId}/replace`, { method: "POST", body: form });
      if (!res.ok) return null;
      const { deckImport } = (await res.json()) as { deckImport: DeckImportView };
      if (mounted.current) setState({ view: deckImport, loading: false, error: null });
      return deckImport;
    },
    [deckImportId]
  );

  const downloadOriginal = useCallback(async () => {
    const res = await fetch(`/api/deck-imports/${deckImportId}/original`);
    if (!res.ok) return;
    const { url } = (await res.json()) as { url: string };
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [deckImportId]);

  const remove = useCallback(async () => {
    const res = await fetch(`/api/deck-imports/${deckImportId}`, { method: "DELETE" });
    return res.ok;
  }, [deckImportId]);

  return { ...state, refetch, retry, replace, downloadOriginal, remove };
}
