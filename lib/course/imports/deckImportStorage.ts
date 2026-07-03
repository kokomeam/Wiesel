/**
 * Storage for imported decks — the PRIVATE `deck-imports` bucket.
 *
 * Nothing here ever produces a permanent public URL (there is intentionally no
 * `getPublicUrl` call anywhere in this module — the verify suite asserts it).
 * Reads happen only through short-lived SIGNED URLs minted server-side after an
 * ownership check. Paths are owner-first so the bucket's folder-ownership RLS
 * (`foldername[1] = auth.uid()`) passes for the author and blocks everyone else:
 *
 *   {ownerId}/{courseId}/{deckImportId}/original/{safeFileName}
 *   {ownerId}/{courseId}/{deckImportId}/preview/deck.pdf
 *   {ownerId}/{courseId}/{deckImportId}/pages/page-001.png
 *   {ownerId}/{courseId}/{deckImportId}/thumbs/page-001.png
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export const DECK_IMPORT_BUCKET = "deck-imports";

/** Default signed-URL lifetime (seconds). Long enough to browse a deck, short
 *  enough that a leaked URL expires quickly; the viewer re-signs on demand. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

type DB = SupabaseClient<Database>;

/* ───────────────────────────── pure path builders ─────────────────────── */

export function deckImportRoot(ownerId: string, courseId: string, deckImportId: string): string {
  return `${ownerId}/${courseId}/${deckImportId}`;
}

export function originalObjectPath(
  ownerId: string,
  courseId: string,
  deckImportId: string,
  safeFileName: string
): string {
  return `${deckImportRoot(ownerId, courseId, deckImportId)}/original/${safeFileName}`;
}

export function previewPdfObjectPath(ownerId: string, courseId: string, deckImportId: string): string {
  return `${deckImportRoot(ownerId, courseId, deckImportId)}/preview/deck.pdf`;
}

/** Zero-padded page label, e.g. page 1 → "page-001". Stable sort + tidy paths. */
export function pageLabel(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(3, "0")}`;
}

export function pageObjectPath(
  ownerId: string,
  courseId: string,
  deckImportId: string,
  pageNumber: number
): string {
  return `${deckImportRoot(ownerId, courseId, deckImportId)}/pages/${pageLabel(pageNumber)}.png`;
}

export function thumbObjectPath(
  ownerId: string,
  courseId: string,
  deckImportId: string,
  pageNumber: number
): string {
  return `${deckImportRoot(ownerId, courseId, deckImportId)}/thumbs/${pageLabel(pageNumber)}.png`;
}

/* ──────────────────────────────── storage ops ─────────────────────────── */

export interface UploadResult {
  ok: boolean;
  error?: string;
}

/** Upload bytes to the private bucket. `upsert` lets replace/retry overwrite. */
export async function uploadObject(
  supabase: DB,
  args: { path: string; bytes: Uint8Array | ArrayBuffer | Blob; contentType: string; upsert?: boolean }
): Promise<UploadResult> {
  const { error } = await supabase.storage.from(DECK_IMPORT_BUCKET).upload(args.path, args.bytes, {
    contentType: args.contentType,
    upsert: args.upsert ?? true,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Mint ONE signed URL, or null if the object is missing / signing fails (the
 *  viewer renders a graceful "page unavailable" placeholder for null). Pass
 *  `download` to force a Content-Disposition attachment (download-original). */
export async function signObject(
  supabase: DB,
  path: string,
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
  opts?: { download?: string | boolean }
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(DECK_IMPORT_BUCKET)
    .createSignedUrl(path, ttlSeconds, opts?.download ? { download: opts.download } : undefined);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/**
 * Batch-sign many paths in ONE round-trip, preserving order. Missing/failed
 * entries come back as null. Empty input short-circuits.
 */
export async function signObjects(
  supabase: DB,
  paths: string[],
  ttlSeconds = SIGNED_URL_TTL_SECONDS
): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const { data, error } = await supabase.storage
    .from(DECK_IMPORT_BUCKET)
    .createSignedUrls(paths, ttlSeconds);
  if (error || !data) return paths.map(() => null);
  // createSignedUrls preserves input order and reports a per-item error.
  return data.map((d) => (d.error || !d.signedUrl ? null : d.signedUrl));
}

/** List every object under a deck import's root (paths relative to the bucket). */
export async function listDeckImportObjects(
  supabase: DB,
  ownerId: string,
  courseId: string,
  deckImportId: string
): Promise<string[]> {
  const root = deckImportRoot(ownerId, courseId, deckImportId);
  const subdirs = ["original", "preview", "pages", "thumbs"];
  const out: string[] = [];
  for (const sub of subdirs) {
    const { data } = await supabase.storage
      .from(DECK_IMPORT_BUCKET)
      .list(`${root}/${sub}`, { limit: 1000 });
    for (const obj of data ?? []) {
      if (obj.name) out.push(`${root}/${sub}/${obj.name}`);
    }
  }
  return out;
}

/** Remove every stored object for a deck import (used by delete + replace). */
export async function removeDeckImportObjects(
  supabase: DB,
  ownerId: string,
  courseId: string,
  deckImportId: string
): Promise<string | null> {
  const paths = await listDeckImportObjects(supabase, ownerId, courseId, deckImportId);
  if (paths.length === 0) return null;
  const { error } = await supabase.storage.from(DECK_IMPORT_BUCKET).remove(paths);
  return error?.message ?? null;
}

/** Remove only the rendered page + thumb artifacts (replace/retry re-renders). */
export async function removeRenderedArtifacts(
  supabase: DB,
  ownerId: string,
  courseId: string,
  deckImportId: string
): Promise<string | null> {
  const root = deckImportRoot(ownerId, courseId, deckImportId);
  const out: string[] = [];
  for (const sub of ["pages", "thumbs", "preview"]) {
    const { data } = await supabase.storage
      .from(DECK_IMPORT_BUCKET)
      .list(`${root}/${sub}`, { limit: 1000 });
    for (const obj of data ?? []) if (obj.name) out.push(`${root}/${sub}/${obj.name}`);
  }
  if (out.length === 0) return null;
  const { error } = await supabase.storage.from(DECK_IMPORT_BUCKET).remove(out);
  return error?.message ?? null;
}

/** Download an object's bytes (worker side: fetch the original to convert). */
export async function downloadObject(supabase: DB, path: string): Promise<Uint8Array | null> {
  const { data, error } = await supabase.storage.from(DECK_IMPORT_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}
