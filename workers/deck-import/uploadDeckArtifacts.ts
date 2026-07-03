/**
 * Step 3 of the pipeline: upload the rendered page + thumbnail PNGs (and the
 * normalized PDF, for converted decks) to the private bucket, and return the
 * `deck_import_pages` insert rows for the caller to persist.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  pageObjectPath,
  previewPdfObjectPath,
  thumbObjectPath,
  uploadObject,
} from "@/lib/course/imports/deckImportStorage";
import type { DeckImportPageInsert } from "@/lib/course/imports/deckImportTypes";
import type { RenderedPage } from "./renderPdfPages";

type DB = SupabaseClient<Database>;

export async function uploadDeckArtifacts(
  admin: DB,
  args: {
    ownerId: string;
    courseId: string;
    deckImportId: string;
    pages: RenderedPage[];
    /** Normalized PDF bytes to store as the preview (null for pass-through PDFs). */
    previewPdfBytes?: Uint8Array | null;
  }
): Promise<Omit<DeckImportPageInsert, "deck_import_id">[]> {
  const { ownerId, courseId, deckImportId, pages, previewPdfBytes } = args;

  if (previewPdfBytes) {
    const up = await uploadObject(admin, {
      path: previewPdfObjectPath(ownerId, courseId, deckImportId),
      bytes: previewPdfBytes,
      contentType: "application/pdf",
      upsert: true,
    });
    if (!up.ok) throw new Error(`preview pdf upload failed: ${up.error}`);
  }

  const inserts: Omit<DeckImportPageInsert, "deck_import_id">[] = [];
  for (const p of pages) {
    const imagePath = pageObjectPath(ownerId, courseId, deckImportId, p.pageNumber);
    const imgUp = await uploadObject(admin, {
      path: imagePath,
      bytes: p.imageBytes,
      contentType: "image/png",
      upsert: true,
    });
    if (!imgUp.ok) throw new Error(`page ${p.pageNumber} upload failed: ${imgUp.error}`);

    let thumbnailPath: string | null = null;
    if (p.thumbBytes) {
      thumbnailPath = thumbObjectPath(ownerId, courseId, deckImportId, p.pageNumber);
      const thUp = await uploadObject(admin, {
        path: thumbnailPath,
        bytes: p.thumbBytes,
        contentType: "image/png",
        upsert: true,
      });
      if (!thUp.ok) thumbnailPath = null; // thumbnail is optional; fall back to full image
    }

    inserts.push({
      page_number: p.pageNumber,
      image_path: imagePath,
      thumbnail_path: thumbnailPath,
      width: p.width,
      height: p.height,
    });
  }
  return inserts;
}
