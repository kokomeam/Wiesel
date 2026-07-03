/**
 * Learner-facing media resolution. Video rows and deck-import pages are
 * author-only under RLS (the editor's routes 404 for non-owners), so the
 * learn runtime resolves them with the ADMIN client — ALWAYS after the caller
 * has verified enrollment/authorship (getLearnerAccess). Nothing here checks
 * access itself; treat these as privileged lookups.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ImportedDeckBlock, VideoLessonBlock } from "@/lib/course/types";
import { getDeckImportView } from "@/lib/course/imports/deckImportService";
import type { DeckImportView } from "@/lib/course/imports/deckImportTypes";
import { parseVtt, type CaptionCue } from "@/lib/video/captions";
import { buildVideoAssetView, getVideoAsset } from "@/lib/video/videoService";

type DB = SupabaseClient<Database>;

/** Everything the student video player needs, already public-URL shaped. */
export interface LearnerVideoData {
  mp4Url: string | null;
  /** "preparing" while the MP4 rendition is still rendering; "disabled" when
   *  no rendition will ever exist (the card explains instead of spinning). */
  mp4Status: "ready" | "preparing" | "disabled" | null;
  posterUrl: string | null;
  durationSeconds: number | null;
  captions: CaptionCue[] | null;
}

export async function learnerVideoData(
  admin: DB,
  block: VideoLessonBlock
): Promise<LearnerVideoData | null> {
  const assetId = block.asset.videoAssetId;
  if (!assetId) return null;
  const row = await getVideoAsset(admin, assetId);
  if (!row) return null;
  const view = buildVideoAssetView(row);
  return {
    mp4Url: view.mp4Url,
    mp4Status: view.mp4Status,
    posterUrl: view.thumbnailUrl ?? block.asset.thumbnailUrl ?? null,
    durationSeconds: view.durationSeconds ?? block.asset.durationSeconds ?? null,
    captions: view.transcriptVtt ? parseVtt(view.transcriptVtt) : null,
  };
}

/** Signed page URLs for an imported deck (short-lived; the learner viewer
 *  refreshes them via /api/learn/deck/[id] when they expire). */
export async function learnerDeckView(
  admin: DB,
  block: ImportedDeckBlock
): Promise<DeckImportView | null> {
  return getDeckImportView(admin, block.deckImportId);
}
