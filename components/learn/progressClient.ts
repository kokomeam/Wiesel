"use client";

/**
 * Thin client for /api/learn/progress. Fire-and-mostly-forget: the runtime
 * never blocks the learner on a progress write, but the response's recomputed
 * snapshot is surfaced so the UI can flip completion states live.
 */

import type { LessonProgressSnapshot, ProgressAction } from "@/lib/learn/schemas";

// Reports are SERIALIZED per tab: each waits for the previous one to settle.
// The server also guards with optimistic locking (cross-tab safety); this
// queue just keeps the common single-tab case conflict-free and ordered.
let queue: Promise<unknown> = Promise.resolve();

async function post(
  courseId: string,
  action: ProgressAction
): Promise<LessonProgressSnapshot | null> {
  try {
    const res = await fetch("/api/learn/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId, action }),
      keepalive: true,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { progress?: LessonProgressSnapshot };
    return body.progress ?? null;
  } catch {
    return null;
  }
}

export function reportProgress(
  courseId: string,
  action: ProgressAction
): Promise<LessonProgressSnapshot | null> {
  const next = queue.then(() => post(courseId, action));
  queue = next.catch(() => null);
  return next;
}
