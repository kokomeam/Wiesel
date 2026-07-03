/**
 * POST /api/deck-imports/[id]/retry — re-run conversion for a failed (or stale
 * ready) deck without re-uploading. Transitions the row back to `processing` and
 * re-enqueues; the worker re-renders and replaces the pages. Idempotent.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { requireDeckImportAccess } from "@/lib/course/imports/deckImportAccess";
import { enqueueDeckImportJob } from "@/lib/course/imports/deckImportJobs";
import { buildDeckImportView } from "@/lib/course/imports/deckImportService";
import { rowStatus } from "@/lib/course/imports/deckImportTypes";
import { canTransition } from "@/lib/course/imports/deckImportValidation";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const supabase = await createClient();
  const { id } = await params;

  const access = await requireDeckImportAccess(supabase, id);
  if (!access.ok) return new Response(access.message, { status: access.status });

  const from = rowStatus(access.row);
  if (!canTransition(from, "processing")) {
    return new Response(`Can't retry from "${from}".`, { status: 409 });
  }

  const err = await enqueueDeckImportJob(supabase, access.row);
  if (err) {
    console.log(JSON.stringify({ tag: "deck_import_retry_error", message: err }));
    return new Response("We couldn't start processing again.", { status: 500 });
  }

  const view = await buildDeckImportView(supabase, { ...access.row, status: "processing", error: null }, []);
  return Response.json({ deckImport: view });
}
