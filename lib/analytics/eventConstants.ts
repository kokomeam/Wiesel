/**
 * Zod-free analytics contract pieces for CLIENT bundles (PERF-1 D1).
 *
 * The full contract (lib/analytics/events.ts) is Zod-first and stays the
 * single source of truth for SERVER validation — but importing it from any
 * 'use client' module drags the zod core (~63 KB gz) into that route's
 * bundle, and the root-layout WebVitalsReporter was doing exactly that for
 * EVERY route. Client code needs only these constants + a plain assembler;
 * the ingest route re-validates every event server-side, so client-side
 * schema parsing bought nothing but bytes.
 *
 * events.ts imports and re-exports everything here — server code and the
 * verify suites keep their existing import paths.
 */

import type {
  AnalyticsEventInput,
  ClientBatchEvent,
  EventContext,
} from "./events";

export const FEEDBACK_COMMENT_MAX_CHARS = 500;

export const PERF_ROUTE_MAX_CHARS = 200;
export const PERF_VITAL_METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export const PERF_VITAL_RATINGS = ["good", "needs-improvement", "poor"] as const;

export const MAX_BATCH_EVENTS = 100;

/**
 * Assemble one learner event WITHOUT schema validation — the client-bundle
 * sibling of events.ts `buildEvent` (which zod-parses and is what SERVER
 * emitters use). Shape safety comes from the types; authoritative validation
 * happens in /api/analytics/ingest.
 */
export function assembleClientEvent(
  ctx: EventContext,
  input: AnalyticsEventInput,
  opts?: { clientEventId?: string; clientTs?: string }
): ClientBatchEvent {
  return {
    ...ctx,
    ...input,
    clientEventId: opts?.clientEventId ?? crypto.randomUUID(),
    clientTs: opts?.clientTs ?? new Date().toISOString(),
  } as ClientBatchEvent;
}
