/**
 * POST /api/deck-imports/upload — accept a PPT/PPTX/PDF, store the original in
 * the PRIVATE deck-imports bucket, create a `deck_imports` row, and enqueue the
 * conversion job. Heavy rendering happens in the worker, never here.
 *
 * Multipart body: file (the deck), courseId, blockId (client-generated, so the
 * row's block_id matches the block the client inserts), lessonId (optional).
 *
 * Returns { deckImport } (a client-safe view — no storage paths) so the caller
 * can build the imported-deck block. Auth + course-ownership are enforced
 * server-side; client MIME is validated but not trusted alone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, userOwnsCourse } from "@/lib/course/imports/deckImportAccess";
import {
  buildDeckImportView,
  createDeckImport,
} from "@/lib/course/imports/deckImportService";
import { enqueueDeckImportJob } from "@/lib/course/imports/deckImportJobs";
import {
  deriveDeckTitle,
  sanitizeFileName,
  validateUpload,
} from "@/lib/course/imports/deckImportValidation";
import {
  DECK_IMPORT_BUCKET,
  originalObjectPath,
  uploadObject,
} from "@/lib/course/imports/deckImportStorage";

function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();

  const user = await getAuthedUser(supabase);
  if (!user) return new Response("Sign in to continue.", { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Expected multipart/form-data.", { status: 400 });
  }

  const file = form.get("file");
  const courseId = form.get("courseId");
  const lessonId = form.get("lessonId");
  const blockId = form.get("blockId");

  if (!(file instanceof File)) return new Response("No file provided.", { status: 400 });
  if (!isUuid(courseId)) return new Response("Missing or invalid courseId.", { status: 400 });
  if (!isUuid(blockId)) return new Response("Missing or invalid blockId.", { status: 400 });
  if (lessonId !== null && lessonId !== "" && !isUuid(lessonId)) {
    return new Response("Invalid lessonId.", { status: 400 });
  }

  if (!(await userOwnsCourse(supabase, user.id, courseId))) {
    return new Response("You don't have access to this course.", { status: 403 });
  }

  // Authoritative server-side validation (size + extension/MIME agreement).
  const validation = validateUpload({ fileName: file.name, mimeType: file.type, size: file.size });
  if (!validation.ok) return new Response(validation.error, { status: 400 });

  const safeName = sanitizeFileName(file.name);
  const title = deriveDeckTitle(file.name);
  const deckImportId = crypto.randomUUID();
  const storagePath = originalObjectPath(user.id, courseId, deckImportId, safeName);

  // 1) upload the original to private storage
  const bytes = new Uint8Array(await file.arrayBuffer());
  const up = await uploadObject(supabase, {
    path: storagePath,
    bytes,
    contentType: validation.format.mimeTypes[0],
    upsert: true,
  });
  if (!up.ok) {
    console.log(JSON.stringify({ tag: "deck_import_upload_error", message: up.error }));
    return new Response("We couldn't store that file. Please try again.", { status: 502 });
  }

  // 2) create the row (status=uploaded)
  const created = await createDeckImport(supabase, {
    ownerId: user.id,
    courseId,
    lessonId: typeof lessonId === "string" && lessonId ? lessonId : null,
    blockId,
    sourceType: "upload",
    title,
    originalFileName: safeName,
    originalMimeType: validation.format.mimeTypes[0],
    originalFileSize: file.size,
    originalFilePath: storagePath,
    status: "uploaded",
  });
  if ("error" in created) {
    // best-effort cleanup so a failed insert doesn't orphan the upload
    await supabase.storage.from(DECK_IMPORT_BUCKET).remove([storagePath]);
    console.log(JSON.stringify({ tag: "deck_import_create_error", message: created.error }));
    return new Response("We couldn't register that deck. Please try again.", { status: 500 });
  }

  // 3) enqueue processing (transitions uploaded → processing; worker renders it)
  const enqErr = await enqueueDeckImportJob(supabase, created.row);
  if (enqErr) {
    console.log(JSON.stringify({ tag: "deck_import_enqueue_error", message: enqErr }));
    // The row exists and is recoverable via retry; surface success with the row.
  }

  const view = await buildDeckImportView(
    supabase,
    enqErr ? created.row : { ...created.row, status: "processing" },
    []
  );
  return Response.json({ deckImport: view });
}
