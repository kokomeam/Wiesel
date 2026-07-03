/**
 * Canonical types for the imported-deck service layer. Row/Insert/Update aliases
 * come from the generated DB types; the *View types are the CLIENT-SAFE shapes
 * the API returns — they carry signed URLs and never raw storage paths.
 */

import type { Database } from "@/lib/database.types";
import type { DeckImportSourceType, DeckImportStatus } from "@/lib/course/types";

export type { DeckImportSourceType, DeckImportStatus };

export type DeckImportRow = Database["public"]["Tables"]["deck_imports"]["Row"];
export type DeckImportInsert = Database["public"]["Tables"]["deck_imports"]["Insert"];
export type DeckImportUpdate = Database["public"]["Tables"]["deck_imports"]["Update"];

export type DeckImportPageRow = Database["public"]["Tables"]["deck_import_pages"]["Row"];
export type DeckImportPageInsert = Database["public"]["Tables"]["deck_import_pages"]["Insert"];

/** A page as the viewer consumes it: signed URLs (or null when unavailable). */
export interface DeckImportPageView {
  pageNumber: number;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

/** The whole imported deck for the client. No storage paths, no owner id leak
 *  beyond what the author already owns. */
export interface DeckImportView {
  id: string;
  courseId: string;
  lessonId: string | null;
  blockId: string | null;
  title: string;
  sourceType: DeckImportSourceType;
  sourceExternalId: string | null;
  status: DeckImportStatus;
  originalFileName: string;
  originalMimeType: string;
  originalFileSize: number;
  pageCount: number | null;
  error: string | null;
  pages: DeckImportPageView[];
  createdAt: string;
  updatedAt: string;
}

/** Narrowing helpers so callers don't sprinkle string literals. */
export function isDeckImportStatus(value: unknown): value is DeckImportStatus {
  return value === "uploaded" || value === "processing" || value === "ready" || value === "failed";
}

export function isDeckImportSourceType(value: unknown): value is DeckImportSourceType {
  return value === "upload" || value === "google_drive" || value === "onedrive";
}

/** Coerce a DB row's free-text `status`/`source_type` into the typed unions. */
export function rowStatus(row: Pick<DeckImportRow, "status">): DeckImportStatus {
  return isDeckImportStatus(row.status) ? row.status : "uploaded";
}

export function rowSourceType(row: Pick<DeckImportRow, "source_type">): DeckImportSourceType {
  return isDeckImportSourceType(row.source_type) ? row.source_type : "upload";
}
