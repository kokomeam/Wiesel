/**
 * Build a SlideShortSpec from a slide_short render job (FR-6): the lesson's
 * REAL slide deck JSON + the M-R slide-sync entries clipped to the span
 * (`slidesForSpan` — the routing helpers are the one sync consumer surface)
 * + clip-relative word-level captions from the lesson transcript + the
 * candidate's hook/CTA + packaging.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { loadLessonSlideSync, slidesForSpan } from "../../routing";
import { getLessonTranscript } from "../../transcripts";
import type { ClipMomentCandidate } from "../../schemas";
import type { ClipRenderJob } from "../jobs";
import type { ClipPackagingPreset } from "../../presets";
import { CLIP_PACKAGING_PRESETS } from "../../presets";
import type { SlideShortSpec, SlideShortSlide } from "./spec";

type DB = SupabaseClient<Database>;

export class SlideShortSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlideShortSpecError";
  }
}

export async function buildSlideShortSpec(
  supabase: DB,
  job: ClipRenderJob,
  candidate: ClipMomentCandidate,
  mediaUrl: string
): Promise<SlideShortSpec> {
  const span = { startMs: job.source.startMs, endMs: job.source.endMs };
  const durationMs = span.endMs - span.startMs;

  // 1) sync windows clipped to the span (LESSON-relative → CLIP-relative)
  const sync = await loadLessonSlideSync(supabase, job.lessonId);
  if (!sync || sync.length === 0) {
    throw new SlideShortSpecError("this lesson has no slide-sync data (record it in the studio with the presenting pill)");
  }
  const windows = slidesForSpan(sync, span);
  if (windows.length === 0) {
    throw new SlideShortSpecError("no slide is on screen during this span");
  }

  // 2) the REAL slide JSON from the lesson's slide_deck blocks
  const { data: deckBlocks, error } = await supabase
    .from("blocks")
    .select("content")
    .eq("lesson_id", job.lessonId)
    .eq("type", "slide_deck");
  if (error) throw new Error(`blocks read (slide decks): ${error.message}`);
  const slideById = new Map<string, Record<string, unknown>>();
  for (const b of deckBlocks ?? []) {
    for (const s of ((b.content as { slides?: Record<string, unknown>[] } | null)?.slides ?? [])) {
      if (typeof s.id === "string") slideById.set(s.id, s);
    }
  }
  const slides: SlideShortSlide[] = [];
  for (const w of windows) {
    const slide = slideById.get(w.slideId);
    if (!slide) continue; // a deleted slide's window is skipped, not fatal
    slides.push({ fromMs: w.atMs - span.startMs, toMs: w.endMs - span.startMs, slide });
  }
  if (slides.length === 0) {
    throw new SlideShortSpecError("the synced slides no longer exist in this lesson's deck");
  }

  // 3) clip-relative caption words
  const transcript = await getLessonTranscript(supabase, job.lessonId);
  const captionWords = (transcript?.words ?? [])
    .filter((w) => w.startMs < span.endMs && w.endMs > span.startMs)
    .map((w) => ({
      w: w.w,
      startMs: Math.max(0, w.startMs - span.startMs),
      endMs: Math.min(durationMs, w.endMs - span.startMs),
    }));

  // 4) course title + creator handle (the watermark)
  const { data: course } = job.courseId
    ? await supabase.from("courses").select("title").eq("id", job.courseId).maybeSingle()
    : { data: null };
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", job.creatorId)
    .maybeSingle();

  const preset: ClipPackagingPreset = (CLIP_PACKAGING_PRESETS as readonly string[]).includes(job.preset)
    ? (job.preset as ClipPackagingPreset)
    : "tofu_hook";

  return {
    mediaUrl,
    durationMs,
    slides,
    captionWords,
    hookText: candidate.hookText,
    preset,
    endCardCta: candidate.endCardCta,
    creatorHandle: profile?.display_name ?? null,
    courseTitle: course?.title ?? "my course",
  };
}
