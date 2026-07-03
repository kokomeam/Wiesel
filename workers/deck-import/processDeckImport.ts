/**
 * The worker-compatible processing entry point:
 *
 *   processDeckImport(deckImportId): Promise<void>
 *
 * Pipeline: load row → download original → normalize to PDF → render pages →
 * upload artifacts → write page rows → mark ready. Any failure marks the row
 * `failed` with a friendly message (technical detail stays in the logs) and the
 * temp dir is always cleaned up. Designed to run in a separate process/container
 * (it does heavy LibreOffice/Poppler work) — never inside a request handler.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { downloadObject, previewPdfObjectPath } from "@/lib/course/imports/deckImportStorage";
import {
  getDeckImport,
  markFailed,
  markReady,
  replaceDeckImportPages,
} from "@/lib/course/imports/deckImportService";
import { extensionOf } from "@/lib/course/imports/deckImportValidation";
import { convertToPdf } from "./convertToPdf";
import { renderPdfPages } from "./renderPdfPages";
import { uploadDeckArtifacts } from "./uploadDeckArtifacts";
import { WorkerError } from "./shell";

type DB = SupabaseClient<Database>;

function log(tag: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ tag, ...fields }));
}

export async function processDeckImport(
  deckImportId: string,
  deps: { admin?: DB } = {}
): Promise<void> {
  const admin = deps.admin ?? createAdminClient();

  const row = await getDeckImport(admin, deckImportId);
  if (!row) {
    log("deck_import_process_missing", { deckImportId });
    return;
  }

  const started = Date.now();
  const workDir = await mkdtemp(path.join(os.tmpdir(), `deck-${deckImportId}-`));
  try {
    log("deck_import_process_start", { deckImportId, file: row.original_file_name });

    const bytes = await downloadObject(admin, row.original_file_path);
    if (!bytes || bytes.length === 0) {
      throw new WorkerError("original object missing/empty", "The uploaded file could not be read.");
    }

    const rawExt = extensionOf(row.original_file_name);
    const ext: "pdf" | "ppt" | "pptx" =
      rawExt === "pdf" || rawExt === "ppt" || rawExt === "pptx" ? rawExt : "pdf";
    const inputPath = path.join(workDir, `original.${ext}`);
    await writeFile(inputPath, bytes);

    const { pdfPath, convertedPdfBytes } = await convertToPdf({ inputPath, ext, workDir });
    const pages = await renderPdfPages({ pdfPath, workDir });

    const inserts = await uploadDeckArtifacts(admin, {
      ownerId: row.owner_id,
      courseId: row.course_id,
      deckImportId,
      pages,
      previewPdfBytes: convertedPdfBytes,
    });

    const pageErr = await replaceDeckImportPages(admin, deckImportId, inserts);
    if (pageErr) throw new Error(`page rows: ${pageErr}`);

    const previewPath = convertedPdfBytes
      ? previewPdfObjectPath(row.owner_id, row.course_id, deckImportId)
      : null;
    const ready = await markReady(admin, deckImportId, {
      pageCount: pages.length,
      previewPdfPath: previewPath,
    });
    if ("error" in ready) throw new Error(`mark ready: ${ready.error}`);

    log("deck_import_ready", { deckImportId, pages: pages.length, ms: Date.now() - started });
  } catch (err) {
    const userMessage =
      err instanceof WorkerError ? err.userMessage : "We couldn't prepare a preview for this deck.";
    log("deck_import_failed", {
      deckImportId,
      message: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    });
    await markFailed(admin, deckImportId, userMessage);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
