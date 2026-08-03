/**
 * PERF-1 E1 — RUM web-vitals helpers. PURE: no DOM, no web-vitals import —
 * everything decision-shaped lives here so verify-vitals.ts drives it
 * headless; components/perf/WebVitalsReporter.tsx owns the browser wiring.
 *
 * perf_vital rides the EXISTING analytics contract (lib/analytics/events.ts)
 * and ingest RPC — never a parallel path. It is app-scoped: a vital belongs
 * to a normalized ROUTE PATTERN (never a raw URL — no slugs/uuids leave the
 * browser), with a NULL course envelope in the DB.
 */

// Zod-free imports only — this module rides in EVERY route's client bundle
// via the root-layout WebVitalsReporter (PERF-1 D1). The builder validates
// with explicit guards below; the ingest RPC re-validates authoritatively.
import {
  PERF_ROUTE_MAX_CHARS,
  PERF_VITAL_METRICS,
  PERF_VITAL_RATINGS,
} from "./eventConstants";
import type { PerfVitalEvent } from "./events";

export type PerfVitalMetric = PerfVitalEvent["metric"];
export type PerfVitalRating = PerfVitalEvent["rating"];
export type PerfDeviceClass = PerfVitalEvent["deviceClass"];

/* ─────────────────────── Route normalization ───────────────────────────── */

/** The KNOWN dynamic route shapes (first match wins — statics like
 *  /marketing/email/new precede their dynamic siblings). Keep this list in
 *  step with the app/ tree; unknown paths fall through to the generic
 *  uuid-scrub below so a new route degrades to a readable pattern, never a
 *  raw id. */
const KNOWN_ROUTES: ReadonlyArray<[RegExp, string]> = [
  [/^\/learn\/[^/]+\/[^/]+$/, "/learn/[slug]/[lessonId]"],
  [/^\/learn\/[^/]+$/, "/learn/[slug]"],
  [/^\/p\/[^/]+$/, "/p/[slug]"],
  [
    /^\/studio\/[^/]+\/analytics\/learners\/[^/]+$/,
    "/studio/[courseId]/analytics/learners/[learnerId]",
  ],
  [/^\/studio\/[^/]+\/analytics$/, "/studio/[courseId]/analytics"],
  [/^\/studio\/[^/]+$/, "/studio/[courseId]"],
  [/^\/marketing\/email\/new$/, "/marketing/email/new"],
  [/^\/marketing\/email\/[^/]+$/, "/marketing/email/[id]"],
  [/^\/marketing\/landing\/[^/]+$/, "/marketing/landing/[id]"],
  [/^\/marketing\/leads\/[^/]+$/, "/marketing/leads/[id]"],
  [/^\/marketing\/preview\/[^/]+$/, "/marketing/preview/[id]"],
  [/^\/marketing\/sequences\/[^/]+$/, "/marketing/sequences/[id]"],
];

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pathname → route pattern. Strips query/hash and trailing slashes, maps
 *  the known dynamic shapes, scrubs uuid segments from anything unknown,
 *  and caps at PERF_ROUTE_MAX_CHARS (the DB CHECK). */
export function normalizeRoute(pathname: string): string {
  let path = pathname.split(/[?#]/)[0] ?? "/";
  if (!path.startsWith("/")) path = `/${path}`;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  for (const [pattern, route] of KNOWN_ROUTES) {
    if (pattern.test(path)) return route;
  }
  const scrubbed = path
    .split("/")
    .map((segment) => (UUID_SEGMENT.test(segment) ? "[id]" : segment))
    .join("/");
  return scrubbed.slice(0, PERF_ROUTE_MAX_CHARS);
}

/* ───────────────────────── Device class ────────────────────────────────── */

/** The reporter evaluates this once per page load; the helper stays a pure
 *  boolean→label map so the split is testable. Tablets ≥768px read as
 *  desktop — device_class is a coarse segmentation dimension, not UA parsing. */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export function deviceClassFromMedia(matches: boolean): PerfDeviceClass {
  return matches ? "mobile" : "desktop";
}

/* ─────────────────────────── Sampling ──────────────────────────────────── */

/** NEXT_PUBLIC_PERF_VITALS_SAMPLE (0..1). Default 1 (report everything);
 *  garbage parses to the default, out-of-range clamps. */
export function parseSampleRate(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

/** One decision per page load (the reporter passes Math.random). */
export function shouldSample(rate: number, rng: () => number): boolean {
  if (!Number.isFinite(rate)) return true;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return rng() < rate;
}

/* ─────────────────────────── Builder ───────────────────────────────────── */

export type PerfVitalInput = Omit<PerfVitalEvent, "eventType" | "clientEventId" | "clientTs">;

/** Assemble + validate one perf_vital event (the app-scoped sibling of
 *  events.ts buildEvent — no learner context to stamp). Validation is
 *  explicit guards, not zod — the schema would drag the zod core into every
 *  route's bundle via the root-layout reporter; the ingest RPC re-validates
 *  server-side either way. Guard semantics mirror PerfVitalEventSchema. */
export function buildPerfVitalEvent(
  input: PerfVitalInput,
  opts?: { clientEventId?: string; clientTs?: string }
): PerfVitalEvent {
  if (!(PERF_VITAL_METRICS as readonly string[]).includes(input.metric)) {
    throw new Error(`perf_vital: unknown metric ${String(input.metric)}`);
  }
  if (!(PERF_VITAL_RATINGS as readonly string[]).includes(input.rating)) {
    throw new Error(`perf_vital: unknown rating ${String(input.rating)}`);
  }
  if (!Number.isFinite(input.value) || input.value < 0) {
    throw new Error(`perf_vital: value must be a non-negative finite number`);
  }
  if (
    typeof input.route !== "string" ||
    input.route.length === 0 ||
    input.route.length > PERF_ROUTE_MAX_CHARS
  ) {
    throw new Error(`perf_vital: route must be 1–${PERF_ROUTE_MAX_CHARS} chars`);
  }
  if (input.deviceClass !== "mobile" && input.deviceClass !== "desktop") {
    throw new Error(`perf_vital: unknown deviceClass ${String(input.deviceClass)}`);
  }
  return {
    eventType: "perf_vital",
    ...input,
    clientEventId: opts?.clientEventId ?? crypto.randomUUID(),
    clientTs: opts?.clientTs ?? new Date().toISOString(),
  };
}
