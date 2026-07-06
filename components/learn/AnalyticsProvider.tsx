"use client";

/**
 * Client half of the Milestone 3 hybrid event model: owns the batching queue
 * (lib/analytics/client.ts) and the DOM wiring — 10s interval flush,
 * visibilitychange→hidden flush, pagehide flush (keepalive fetch survives the
 * teardown), and the visible-only session heartbeat. Learner components call
 * `useAnalytics().track(...)` for ENGAGEMENT events; the authoritative events
 * (quiz_submitted / homework_submitted / lesson_completed) are server-emitted
 * and never pass through here.
 *
 * `enabled` is false for author previews — track() becomes a no-op, so a
 * creator walking their own course never pollutes learner analytics (the same
 * rule the progress pipeline applies).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { buildEvent, type AnalyticsEventInput } from "@/lib/analytics/events";
import { createAnalyticsQueue } from "@/lib/analytics/client";

const FLUSH_INTERVAL_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

interface AnalyticsApi {
  track: (input: AnalyticsEventInput) => void;
}

const NOOP: AnalyticsApi = { track: () => {} };

const AnalyticsContext = createContext<AnalyticsApi>(NOOP);

/** No-op outside a provider (e.g. a component rendered in the editor). */
export function useAnalytics(): AnalyticsApi {
  return useContext(AnalyticsContext);
}

export function AnalyticsProvider({
  publicationId,
  version,
  courseId,
  lessonId,
  enabled,
  children,
}: {
  publicationId: string;
  version: number;
  courseId: string;
  lessonId: string;
  /** false = author preview → every track() is a no-op. */
  enabled: boolean;
  children: ReactNode;
}) {
  const [queue] = useState(() => (enabled ? createAnalyticsQueue() : null));

  const track = useCallback(
    (input: AnalyticsEventInput) => {
      if (!queue) return;
      try {
        queue.enqueue(
          buildEvent({ publicationId, version, courseId, lessonId }, input)
        );
      } catch (err) {
        // A malformed event must never break the lesson — drop it loudly.
        console.warn("[analytics] dropped invalid event", err);
      }
    },
    [queue, publicationId, version, courseId, lessonId]
  );

  // Flush triggers: interval + hidden + pagehide; final flush on unmount.
  useEffect(() => {
    if (!queue) return;
    const interval = setInterval(() => void queue.flush("interval"), FLUSH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void queue.flush("hidden");
    };
    const onPageHide = () => void queue.flush("unload");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      void queue.flush("unmount");
      queue.dispose();
    };
  }, [queue]);

  // Heartbeat — only while the tab is actually visible.
  useEffect(() => {
    if (!queue) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        track({ eventType: "session_heartbeat" });
      }
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [queue, track]);

  const api = useMemo<AnalyticsApi>(() => ({ track }), [track]);

  return <AnalyticsContext.Provider value={api}>{children}</AnalyticsContext.Provider>;
}
