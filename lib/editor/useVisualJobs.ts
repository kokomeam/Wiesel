"use client";

/**
 * Client-driven image generation (Option 1): `add_image` stages image slides with
 * `imageUrl:""` + a `pendingGen` spec (off the agent's critical path). This hook is
 * the "worker": when the editor is idle (NOT mid-agent-run — so it never races the
 * agent's per-turn reconciles), it finds pending image slides and POSTs the
 * generation endpoint ONE AT A TIME (sequential = safe against the full-snapshot
 * reconcile, and respects the single-proxy rate limit), re-syncing the doc after each
 * so the image fills in. The endpoint is idempotent, so double-fires are harmless.
 */

import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { loadCourseDoc } from "@/lib/course/persistenceSync";
import { useEditorStore } from "@/lib/course/store";
import type { CourseDocument } from "@/lib/course/types";

interface PendingSlide {
  blockId: string;
  slideId: string;
}

function collectPending(doc: CourseDocument): PendingSlide[] {
  const out: PendingSlide[] = [];
  for (const m of doc.modules) {
    for (const l of m.lessons) {
      for (const b of l.blocks) {
        if (b.type !== "slide_deck") continue;
        for (const s of b.slides) {
          const t = s.template;
          if (!t || (t.layoutId !== "image_reference" && t.layoutId !== "image_supporting")) continue;
          if (!t.content.imageUrl && t.content.pendingGen?.status === "pending") {
            out.push({ blockId: b.id, slideId: s.id });
          }
        }
      }
    }
  }
  return out;
}

export function useVisualJobs(): void {
  const courseId = useEditorStore((s) => s.courseId);
  const doc = useEditorStore((s) => s.doc);
  const agentRunActive = useEditorStore((s) => s.agentRunActive);
  const inFlight = useRef<Set<string>>(new Set());

  const pending = collectPending(doc);
  // Stable signature → the effect only re-fires when the pending SET changes.
  const sig = pending.map((p) => `${p.blockId}:${p.slideId}`).join(",");

  useEffect(() => {
    // Only drive generation when the run is IDLE (the agent already returned; images
    // fill in during review) — generating mid-run would race the agent's reconciles.
    if (!courseId || agentRunActive || pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const client = createClient();
      for (const job of pending) {
        if (cancelled) return;
        const key = `${job.blockId}:${job.slideId}`;
        if (inFlight.current.has(key)) continue;
        inFlight.current.add(key);
        try {
          const res = await fetch("/api/ai/visual/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ courseId, blockId: job.blockId, slideId: job.slideId }),
          });
          if (res.ok && !cancelled) {
            const fresh = await loadCourseDoc(client, courseId);
            const st = useEditorStore.getState();
            if (fresh && st.courseId === courseId) st.syncLiveDoc(fresh);
          }
        } catch {
          /* transient — a later doc change re-triggers */
        } finally {
          inFlight.current.delete(key);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, agentRunActive, sig]);
}
