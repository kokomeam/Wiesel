"use client";

/**
 * Drop-in next/link wrapper with intent prefetch (PERF-1 B4). Keeps Next's
 * default viewport CODE prefetch untouched, and additionally warms the FULL
 * route payload on hover/focus/touch via router.prefetch with
 * `kind: "full"` — with staleTimes.dynamic=30 the warmed Router Cache entry
 * is reused by the click that follows. Same props surface as Link; user
 * event handlers compose (ours run first, then theirs).
 *
 * ⚠ The explicit kind is LOAD-BEARING on Next 16: since the segment-cache
 * rewrite, bare `router.prefetch(href)` defaults to PrefetchKind.AUTO (the
 * PPR/partial strategy — the SAME thing the viewport prefetch already did),
 * so it dedupes to a no-op and the click still pays the full dynamic RSC
 * fetch (measured: 2246ms warm ≈ 1784ms cold). With `kind: "full"` the hover
 * fires a real full prefetch and the click paints from cache (measured:
 * 32ms). Verified by scripts/verify-perf-browser.ts (AC-PERF-06).
 */

import Link from "next/link";
import { useEffect, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { createIntentPrefetcher } from "@/lib/perf/intentPrefetch";

type LinkProps = ComponentProps<typeof Link>;
type Router = ReturnType<typeof useRouter>;
type PrefetchOptions = NonNullable<Parameters<Router["prefetch"]>[1]>;

/** PrefetchKind.FULL — the enum lives on an internal next path
 *  (router-reducer-types); its runtime value is the string "full". */
const FULL_PREFETCH: PrefetchOptions = { kind: "full" } as PrefetchOptions;

// The App Router instance is a stable singleton per app; any mounted
// IntentLink keeps this current so the module-level prefetcher can reach it.
let activeRouter: Router | null = null;

// ONE app-wide prefetcher so the TTL dedupe + concurrency cap span every
// IntentLink instance — sweeping the pointer across a card grid must not
// storm the server with a prefetch per row (the 80ms hover debounce).
const prefetcher = createIntentPrefetcher({
  prefetch: (href) => activeRouter?.prefetch(href, FULL_PREFETCH),
});

export function IntentLink({
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onTouchStart,
  ...rest
}: LinkProps) {
  const router = useRouter();

  useEffect(() => {
    activeRouter = router;
  }, [router]);

  // Intent prefetch only makes sense for internal string hrefs; UrlObject or
  // external hrefs keep Link's own behavior untouched.
  const intentHref =
    typeof rest.href === "string" && rest.href.startsWith("/") ? rest.href : null;

  return (
    <Link
      {...rest}
      onMouseEnter={(event) => {
        if (intentHref) prefetcher.hoverStart(intentHref);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        if (intentHref) prefetcher.hoverEnd(intentHref);
        onMouseLeave?.(event);
      }}
      onFocus={(event) => {
        if (intentHref) prefetcher.touchOrFocus(intentHref);
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        if (intentHref) prefetcher.touchOrFocus(intentHref);
        onTouchStart?.(event);
      }}
    />
  );
}
