"use client";

/**
 * Fires a single `page_view` into the event stream when a published landing page
 * loads. Guarded per-tab-session per-slug so React strict-mode double-invoke and
 * client navigations don't double-count (Phase 2 adds server-side dedup).
 */

import { useEffect } from "react";
import { getAnonymousId } from "./anon";

export function PageViewBeacon({ slug }: { slug: string }) {
  useEffect(() => {
    const key = `cg_pv_${slug}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // storage blocked — fall through and fire once per mount
    }
    void fetch("/api/marketing/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        type: "page_view",
        slug,
        anonymousId: getAnonymousId(),
        referrer: typeof document !== "undefined" ? document.referrer || null : null,
      }),
    }).catch(() => {
      /* best-effort beacon */
    });
  }, [slug]);

  return null;
}
