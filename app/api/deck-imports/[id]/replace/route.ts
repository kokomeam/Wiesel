/**
 * POST /api/deck-imports/[id]/replace — swap the deck's source file for a new
 * one, keeping the same deck import id (and block). Uploads the new original,
 * clears the previously rendered artifacts + page rows, resets metadata, and
 * re-enqueues conversion. Returns the refreshed view so the client can patch the
 * block snapshot.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { requireDeckImportAccess } from "@/lib/course/imports/deckImportAccess";
import { enqueueDeckImportJob } from "@/lib/course/imports/deckImportJobs";
import {
  buildDeckImportView,
  replaceDeckImportPages,
  updateDeckImport,
} from "@/lib/course/imports/deckImportService";
import { rowStatus } from "@/lib/course/imports/deckImportTypes";
import {
  deriveDeckTitle,
  sanitizeFileName,
  validateUpload,
} from "@/lib/course/imports/deckImportValidation";
import {
  originalObjectPath,
  removeRenderedArtifacts,
  uploadObject,
} from "@/lib/course/imports/deckImportStorage";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const supabase = await createClient();
  const { id } = await params;

  const access = await requireDeckImportAccess(supabase, id);
  if (!access.ok) return new Response(access.message, { status: access.status });
  const { user, row } = access;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Expected multipart/form-data.", { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return new Response("No file provided.", { status: 400 });

  const validation = validateUpload({ fileName: file.name, mimeType: file.type, size: file.size });
  if (!validation.ok) return new Response(validation.error, { status: 400 });

  const safeName = sanitizeFileName(file.name);
  const storagePath = originalObjectPath(user.id, row.course_id, row.id, safeName);

  // 1) upload the replacement original
  const bytes = new Uint8Array(await file.arrayBuffer());
  const up = await uploadObject(supabase, {
    path: storagePath,
    bytes,
    contentType: validation.format.mimeTypes[0],
    upsert: true,
  });
  if (!up.ok) {
    console.log(JSON.stringify({ tag: "deck_import_replace_upload_error", message: up.error }));
    return new Response("We couldn't store that file. Please try again.", { status: 502 });
  }

  // 2) clear stale rendered artifacts + page rows
  await removeRenderedArtifacts(supabase, user.id, row.course_id, row.id);
  await replaceDeckImportPages(supabase, row.id, []);

  // 3) reset metadata + status (guarded transition → processing)
  const updated = await updateDeckImport(
    supabase,
    row.id,
    {
      original_file_name: safeName,
      original_mime_type: validation.format.mimeTypes[0],
      original_file_size: file.size,
      original_file_path: storagePath,
      title: deriveDeckTitle(file.name),
      status: "processing",
      page_count: null,
      preview_pdf_path: null,
      error: null,
    },
    { fromStatus: rowStatus(row) }
  );
  if ("error" in updated) {
    console.log(JSON.stringify({ tag: "deck_import_replace_update_error", message: updated.error }));
    return new Response("We couldn't update that deck.", { status: 500 });
  }

  // 4) enqueue conversion of the new file
  const enqErr = await enqueueDeckImportJob(supabase, updated.row);
  if (enqErr) console.log(JSON.stringify({ tag: "deck_import_replace_enqueue_error", message: enqErr }));

  const view = await buildDeckImportView(supabase, updated.row, []);
  return Response.json({ deckImport: view });
}
