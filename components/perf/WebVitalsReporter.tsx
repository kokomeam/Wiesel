"use client";

/**
 * PERF-1 E1 — RUM reporter, mounted ONCE in the root layout. Emits perf_vital
 * events through the EXISTING analytics contract + /api/analytics/ingest
 * (never a parallel path). Final values only (reportAllChanges: false);
 * everything is attributed to the hard-loaded route — App Router soft
 * navigations are not separately attributed (web-vitals measures the page
 * load lifecycle; its soft-nav support is still experimental).
 *
 * Sampling: NEXT_PUBLIC_PERF_VITALS_SAMPLE (0..1, default 1), decided once
 * per page load. Delivery: buffer → flush on visibilitychange-hidden /
 * pagehide via navigator.sendBeacon (fallback keepalive fetch).
 *
 * Auth: the ingest route requires a session (requireUser → 401). A beacon
 * can't observe its response, so the FIRST flush of a browser session goes
 * via keepalive fetch — a 401 marks the session denied in sessionStorage and
 * every later flush no-ops silently. Vitals for signed-out visitors on
 * public pages are a documented gap until a public ingest path is
 * sanctioned (recorded in docs/analytics-events.md).
 */

import { useEffect } from "react";
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import type { PerfVitalEvent } from "@/lib/analytics/events";
import {
  buildPerfVitalEvent,
  deviceClassFromMedia,
  MOBILE_MEDIA_QUERY,
  normalizeRoute,
  parseSampleRate,
  shouldSample,
} from "@/lib/analytics/vitals";

const ENDPOINT = "/api/analytics/ingest";
const AUTH_STATE_KEY = "wisesel.perf-vitals.auth"; // "ok" | "denied"

// Module-level (not state/refs): web-vitals observers can't be unregistered,
// so registration must survive strict-mode effect double-invocation without
// double-reporting; the buffer is page-load-scoped by construction.
let started = false;
const buffer: PerfVitalEvent[] = [];

function readAuthState(): string | null {
  try {
    return window.sessionStorage.getItem(AUTH_STATE_KEY);
  } catch {
    return null; // storage unavailable (privacy mode) → probe every flush
  }
}

function writeAuthState(state: "ok" | "denied"): void {
  try {
    window.sessionStorage.setItem(AUTH_STATE_KEY, state);
  } catch {
    // Best-effort only.
  }
}

function flush(): void {
  if (buffer.length === 0) return;
  const authState = readAuthState();
  if (authState === "denied") {
    buffer.length = 0;
    return;
  }
  const body = JSON.stringify({ events: buffer.splice(0, buffer.length) });
  if (authState === "ok" && typeof navigator.sendBeacon === "function") {
    if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  }
  // First flush of the session (auth unknown) or beacon unavailable/full:
  // keepalive fetch survives teardown AND lets a 401 be observed once.
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  })
    .then((res) => {
      if (res.status === 401) writeAuthState("denied");
      else if (res.ok) writeAuthState("ok");
    })
    .catch(() => {
      // Vitals are best-effort telemetry — never retried, never surfaced.
    });
}

export function WebVitalsReporter() {
  useEffect(() => {
    if (started) return;
    started = true;
    const rate = parseSampleRate(process.env.NEXT_PUBLIC_PERF_VITALS_SAMPLE);
    if (!shouldSample(rate, Math.random)) return;

    const route = normalizeRoute(window.location.pathname);
    const deviceClass = deviceClassFromMedia(window.matchMedia(MOBILE_MEDIA_QUERY).matches);
    const report = (metric: Metric) => {
      try {
        buffer.push(
          buildPerfVitalEvent({
            metric: metric.name,
            value: metric.value,
            rating: metric.rating,
            route,
            deviceClass,
            navigationType: metric.navigationType ?? null,
          })
        );
      } catch {
        // A malformed metric must never break the page.
      }
    };
    const opts = { reportAllChanges: false };
    onLCP(report, opts);
    onINP(report, opts);
    onCLS(report, opts);
    onFCP(report, opts);
    onTTFB(report, opts);

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flush);
    // No cleanup by design: the listeners are page-lifetime companions of the
    // unregisterable web-vitals observers (see the `started` guard above).
  }, []);

  return null;
}
