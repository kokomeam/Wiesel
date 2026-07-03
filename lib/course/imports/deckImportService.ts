/**
 * Imported-deck service: CRUD over `deck_imports` + `deck_import_pages` and the
 * row → client-`View` mapping (which is where signed URLs are minted).
 *
 * Works with EITHER a request-scoped client (RLS enforces ownership for the
 * editor) or a service-role client (the worker, which writes across users). The
 * functions don't assume which — RLS does its job for the former, and the
 * worker's admin client bypasses it by design.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { DeckImportSourceType, DeckImportStatus } from "@/lib/course/types";
import { canTransition } from "./deckImportValidation";
import {
  removeDeckImportObjects,
  signObjects,
} from "./deckImportStorage";
import {
  rowSourceType,
  rowStatus,
  type DeckImportPageInsert,
  type DeckImportPageRow,
  type DeckImportPageView,
  type DeckImportRow,
  type DeckImportUpdate,
  type DeckImportView,
} from "./deckImportTypes";

type DB = SupabaseClient<Database>;

/* ─────────────────────────────── create ───────────────────────────────── */

export interface CreateDeckImportArgs {
  ownerId: string;
  courseId: string;
  lessonId?: string | null;
  blockId?: string | null;
  sourceType?: DeckImportSourceType;
  sourceExternalId?: string | null;
  sourceUrl?: string | null;
  title: string;
  originalFileName: string;
  originalMimeType: string;
  originalFileSize: number;
  originalFilePath: string;
  status?: DeckImportStatus;
}

export async function createDeckImport(
  supabase: DB,
  args: CreateDeckImportArgs
): Promise<{ row: DeckImportRow } | { error: string }> {
  const { data, error } = await supabase
    .from("deck_imports")
    .insert({
      owner_id: args.ownerId,
      course_id: args.courseId,
      lesson_id: args.lessonId ?? null,
      block_id: args.blockId ?? null,
      source_type: args.sourceType ?? "upload",
      source_external_id: args.sourceExternalId ?? null,
      source_url: args.sourceUrl ?? null,
      title: args.title,
      original_file_name: args.originalFileName,
      original_mime_type: args.originalMimeType,
      original_file_size: args.originalFileSize,
      original_file_path: args.originalFilePath,
      status: args.status ?? "uploaded",
    })
    .select("*")
    .single();
  if (error || !data) return { error: error?.message ?? "Failed to create deck import" };
  return { row: data };
}

/* ─────────────────────────────── read ─────────────────────────────────── */

export async function getDeckImport(supabase: DB, deckImportId: string): Promise<DeckImportRow | null> {
  const { data, error } = await supabase
    .from("deck_imports")
    .select("*")
    .eq("id", deckImportId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/** Pages for a deck, ALWAYS sorted ascending by page_number. */
export async function listDeckImportPages(
  supabase: DB,
  deckImportId: string
): Promise<DeckImportPageRow[]> {
  const { data, error } = await supabase
    .from("deck_import_pages")
    .select("*")
    .eq("deck_import_id", deckImportId)
    .order("page_number", { ascending: true });
  if (error || !data) return [];
  // Defensive: never trust the DB ordering alone for the contract.
  return [...data].sort((a, b) => a.page_number - b.page_number);
}

/* ─────────────────────────────── update ───────────────────────────────── */

export interface UpdateDeckImportOptions {
  /** When provided, reject a status change that isn't a legal transition. */
  fromStatus?: DeckImportStatus;
}

/** Patch a deck import. With `opts.fromStatus`, the status change is guarded by
 *  the lifecycle state machine (returns an error string on an illegal move). */
export async function updateDeckImport(
  supabase: DB,
  deckImportId: string,
  patch: DeckImportUpdate,
  opts: UpdateDeckImportOptions = {}
): Promise<{ row: DeckImportRow } | { error: string }> {
  if (patch.status && opts.fromStatus && !canTransition(opts.fromStatus, patch.status as DeckImportStatus)) {
    return { error: `Illegal status transition ${opts.fromStatus} → ${patch.status}` };
  }
  const { data, error } = await supabase
    .from("deck_imports")
    .update(patch)
    .eq("id", deckImportId)
    .select("*")
    .single();
  if (error || !data) return { error: error?.message ?? "Failed to update deck import" };
  return { row: data };
}

export async function markProcessing(supabase: DB, row: DeckImportRow) {
  return updateDeckImport(
    supabase,
    row.id,
    { status: "processing", error: null },
    { fromStatus: rowStatus(row) }
  );
}

export async function markFailed(supabase: DB, deckImportId: string, error: string) {
  return updateDeckImport(supabase, deckImportId, { status: "failed", error });
}

export async function markReady(
  supabase: DB,
  deckImportId: string,
  args: { pageCount: number; previewPdfPath?: string | null }
) {
  return updateDeckImport(supabase, deckImportId, {
    status: "ready",
    error: null,
    page_count: args.pageCount,
    preview_pdf_path: args.previewPdfPath ?? null,
  });
}

/* ─────────────────────────────── pages write ──────────────────────────── */

/** Replace all page rows for a deck (worker writes the freshly rendered set). */
export async function replaceDeckImportPages(
  supabase: DB,
  deckImportId: string,
  pages: Omit<DeckImportPageInsert, "deck_import_id">[]
): Promise<string | null> {
  const del = await supabase.from("deck_import_pages").delete().eq("deck_import_id", deckImportId);
  if (del.error) return del.error.message;
  if (pages.length === 0) return null;
  const rows: DeckImportPageInsert[] = pages.map((p) => ({ ...p, deck_import_id: deckImportId }));
  const { error } = await supabase.from("deck_import_pages").insert(rows);
  return error?.message ?? null;
}

/* ─────────────────────────────── delete ───────────────────────────────── */

/** Remove a deck import entirely: storage objects first, then the row (pages
 *  cascade). Best-effort on storage so a row never lingers after objects clear. */
export async function deleteDeckImport(supabase: DB, row: DeckImportRow): Promise<string | null> {
  await removeDeckImportObjects(supabase, row.owner_id, row.course_id, row.id);
  const { error } = await supabase.from("deck_imports").delete().eq("id", row.id);
  return error?.message ?? null;
}

/* ───────────────────────── row → client View (signs) ──────────────────── */

/** Build the client-safe view, minting signed URLs for every page asset in one
 *  round-trip. Storage paths never cross this boundary. */
export async function buildDeckImportView(
  supabase: DB,
  row: DeckImportRow,
  pages: DeckImportPageRow[]
): Promise<DeckImportView> {
  const sorted = [...pages].sort((a, b) => a.page_number - b.page_number);

  // Sign image + thumbnail paths together; map results back positionally.
  const pathIndex: { path: string; into: { page: number; field: "image" | "thumb" } }[] = [];
  for (const p of sorted) {
    if (p.image_path) pathIndex.push({ path: p.image_path, into: { page: p.page_number, field: "image" } });
    if (p.thumbnail_path)
      pathIndex.push({ path: p.thumbnail_path, into: { page: p.page_number, field: "thumb" } });
  }
  const signed = await signObjects(supabase, pathIndex.map((x) => x.path));
  const urlByKey = new Map<string, string | null>();
  pathIndex.forEach((x, i) => urlByKey.set(`${x.into.page}:${x.into.field}`, signed[i]));

  const pageViews: DeckImportPageView[] = sorted.map((p) => ({
    pageNumber: p.page_number,
    imageUrl: urlByKey.get(`${p.page_number}:image`) ?? null,
    thumbnailUrl: urlByKey.get(`${p.page_number}:thumb`) ?? urlByKey.get(`${p.page_number}:image`) ?? null,
    width: p.width,
    height: p.height,
  }));

  return {
    id: row.id,
    courseId: row.course_id,
    lessonId: row.lesson_id,
    blockId: row.block_id,
    title: row.title,
    sourceType: rowSourceType(row),
    sourceExternalId: row.source_external_id,
    status: rowStatus(row),
    originalFileName: row.original_file_name,
    originalMimeType: row.original_mime_type,
    originalFileSize: row.original_file_size,
    pageCount: row.page_count,
    error: row.error,
    pages: pageViews,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convenience: load row + pages and build the view in one call. */
export async function getDeckImportView(supabase: DB, deckImportId: string): Promise<DeckImportView | null> {
  const row = await getDeckImport(supabase, deckImportId);
  if (!row) return null;
  const pages = await listDeckImportPages(supabase, deckImportId);
  return buildDeckImportView(supabase, row, pages);
}
