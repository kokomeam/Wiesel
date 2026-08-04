/**
 * TUTOR-1 — the client emitter for the TUTOR_TTFT app-scoped RUM vital.
 *
 * The tutor's time-to-first-frame (the ms from the outgoing fetch to the FIRST
 * SSE frame arriving) rides the EXACT SAME perf_vital contract, batching, and
 * ingest RPC as the web-vitals five — never a parallel path. It mirrors the
 * construction in components/perf/WebVitalsReporter.tsx: build a perf_vital via
 * the zod-free `buildPerfVitalEvent` (its guards, not zod — importing the zod
 * contract here would drag the zod core into the learn client bundle) and POST
 * a single-event batch to /api/analytics/ingest with `keepalive:true`.
 *
 * App-scoped, so the DB envelope lands NULL (course/publication/lesson) exactly
 * like the web-vitals path; route is the pinned learner-lesson pattern (no raw
 * URL leaves the browser). Fire-and-forget: NEVER throws, never retries.
 *
 * ZOD-FREE by house rule (this file rides in the learn route bundle): imports
 * only the pure `buildPerfVitalEvent` builder + `eventConstants` reach it via
 * lib/analytics/vitals.ts, which itself imports zod-free from ./eventConstants.
 */

import { buildPerfVitalEvent } from "@/lib/analytics/vitals";
import {
  deviceClassFromMedia,
  MOBILE_MEDIA_QUERY,
} from "@/lib/analytics/vitals";
import { ttftRating } from "@/lib/learn/tutorClientTypes";

const ENDPOINT = "/api/analytics/ingest";
/** The pinned route PATTERN — the tutor sidebar only ever lives on the learner
 *  lesson page. A normalized pattern (never a raw URL) is the perf_vital rule. */
const TUTOR_ROUTE = "/learn/[slug]/[lessonId]";

/**
 * Emit ONE TUTOR_TTFT vital for a completed send's first-frame latency (ms).
 *
 * Best-effort telemetry — swallows every failure (bad env, offline, teardown).
 * Rating is bucketed by `ttftRating` (good <1500 / needs-improvement <3000 /
 * poor). Delivered as a keepalive single-event batch so a navigation away
 * mid-flight can't drop it.
 */
export function emitTutorTtft(ms: number): void {
  try {
    if (typeof window === "undefined") return;
    if (!Number.isFinite(ms) || ms < 0) return;

    const deviceClass = deviceClassFromMedia(
      window.matchMedia(MOBILE_MEDIA_QUERY).matches
    );
    const event = buildPerfVitalEvent({
      metric: "TUTOR_TTFT",
      value: ms,
      rating: ttftRating(ms),
      route: TUTOR_ROUTE,
      deviceClass,
      navigationType: null,
    });

    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event] }),
      keepalive: true,
    }).catch(() => {
      // Vitals are best-effort — never retried, never surfaced.
    });
  } catch {
    // A malformed metric or an unavailable API must never break a tutor turn.
  }
}
