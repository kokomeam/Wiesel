"use client";

/**
 * HONEST top navigation progress bar (PERF-1 B1). Starts only on real
 * navigation intent (same-origin link click / popstate) and completes only
 * when the App Router actually commits a new URL (pathname/searchParams
 * change). It never runs a fake timer to 100%: the trickle below is position
 * easing toward an unknown-duration completion event — each tick advances a
 * bounded fraction of the remaining distance toward a sub-100% ceiling, so
 * only a real route commit can fill the bar. A navigation that never commits
 * fades out via the safety timeout WITHOUT completing.
 *
 * Fully imperative (refs + direct style writes): no setState in effects, no
 * re-render per animation step. prefers-reduced-motion jumps between states
 * instead of animating.
 */

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const RAMP_TARGET = 0.3;
const TRICKLE_CEILING = 0.9;
const TRICKLE_RATE = 0.12;
const TRICKLE_INTERVAL_MS = 450;
const SAFETY_TIMEOUT_MS = 15_000;
const FADE_MS = 150;

export function NavProgress() {
  const barRef = useRef<HTMLDivElement | null>(null);
  const finishRef = useRef<() => void>(() => {});
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = `${pathname}?${searchParams.toString()}`;
  const urlKeyRef = useRef(urlKey);

  // All machinery (listeners + animation state) lives in one mount effect.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    let active = false;
    let progress = 0;
    let rampTimer: ReturnType<typeof setTimeout> | null = null;
    let trickleTimer: ReturnType<typeof setInterval> | null = null;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    let fadeTimer: ReturnType<typeof setTimeout> | null = null;

    const reducedMotion = () =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const clearTimers = () => {
      if (rampTimer !== null) clearTimeout(rampTimer);
      if (trickleTimer !== null) clearInterval(trickleTimer);
      if (safetyTimer !== null) clearTimeout(safetyTimer);
      if (fadeTimer !== null) clearTimeout(fadeTimer);
      rampTimer = safetyTimer = fadeTimer = null;
      trickleTimer = null;
    };

    const setBar = (value: number, transition: string) => {
      progress = value;
      bar.style.transition = reducedMotion() ? "none" : transition;
      bar.style.transform = `scaleX(${value})`;
    };

    const reset = () => {
      bar.style.transition = "none";
      bar.style.opacity = "0";
      bar.style.transform = "scaleX(0)";
      progress = 0;
    };

    // Cancelled/failed navigation: disappear WITHOUT filling — the bar never
    // claims a completion that didn't happen.
    const fadeOut = () => {
      clearTimers();
      active = false;
      if (reducedMotion()) {
        reset();
        return;
      }
      bar.style.transition = `opacity ${FADE_MS}ms ease`;
      bar.style.opacity = "0";
      fadeTimer = setTimeout(reset, FADE_MS + 50);
    };

    const finish = () => {
      if (!active) return;
      active = false;
      clearTimers();
      if (reducedMotion()) {
        setBar(1, "none");
        fadeTimer = setTimeout(reset, 60);
        return;
      }
      setBar(1, "transform 120ms ease-out");
      fadeTimer = setTimeout(() => {
        bar.style.transition = `opacity ${FADE_MS}ms ease`;
        bar.style.opacity = "0";
        fadeTimer = setTimeout(reset, FADE_MS + 50);
      }, 130);
    };
    finishRef.current = finish;

    const start = () => {
      clearTimers();
      active = true;
      // Immediately visible (well under the 100ms feedback budget).
      bar.style.transition = "none";
      bar.style.opacity = "1";
      bar.style.transform = "scaleX(0.08)";
      progress = 0.08;
      rampTimer = setTimeout(() => setBar(RAMP_TARGET, "transform 250ms ease-out"), 30);
      // Trickle = easing toward an unknown-duration event: a bounded fraction
      // of the remaining distance per slow tick, asymptotic to the ceiling.
      trickleTimer = setInterval(() => {
        setBar(
          Math.min(TRICKLE_CEILING, progress + (TRICKLE_CEILING - progress) * TRICKLE_RATE),
          "transform 300ms linear"
        );
      }, TRICKLE_INTERVAL_MS);
      safetyTimer = setTimeout(fadeOut, SAFETY_TIMEOUT_MS);
    };

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor || !(anchor instanceof HTMLAnchorElement)) return;
      if (!anchor.getAttribute("href")) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      if (anchor.origin !== window.location.origin) return;
      // API endpoints are same-origin but never commit an App Router route —
      // the bar would strand until the safety timeout.
      if (anchor.pathname.startsWith("/api/")) return;
      // Hash-only and identical-URL clicks never commit a route change either.
      if (
        anchor.pathname === window.location.pathname &&
        anchor.search === window.location.search
      ) {
        return;
      }
      // Start SYNCHRONOUSLY (capture phase → well under the 100ms feedback
      // budget). Deliberately no `defaultPrevented` veto: next/link calls
      // preventDefault() before pushing the route, so the flag CANNOT
      // distinguish "client nav underway" (the primary case) from "app code
      // blocked the nav" — gating on it suppressed the bar for every <Link>
      // click. A click that truly never commits a route (an anchor
      // preventDefault'd into a button) is covered by the safety-timeout
      // fade, which disappears without ever claiming completion.
      start();
    };

    const onPopState = () => {
      // location already reflects the destination here. A hash-only history
      // move commits no route change — compare against the last committed
      // route key (normalized the same way as searchParams.toString()).
      const key = `${window.location.pathname}?${new URLSearchParams(window.location.search).toString()}`;
      if (key === urlKeyRef.current) return;
      start();
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      clearTimers();
    };
  }, []);

  // Completion: the router committed a new URL → fill to 100% and fade.
  useEffect(() => {
    if (urlKeyRef.current === urlKey) return;
    urlKeyRef.current = urlKey;
    finishRef.current();
  }, [urlKey]);

  return (
    <div
      ref={barRef}
      aria-hidden="true"
      className="brand-gradient pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 origin-left"
      style={{ transform: "scaleX(0)", opacity: 0 }}
    />
  );
}
