/**
 * GET    /api/deck-imports/[id] — the deck import as a client-safe view: live
 *   status + page list with short-lived SIGNED image/thumbnail URLs (never
 *   storage paths, never a public URL). The editor polls this while processing.
 * DELETE /api/deck-imports/[id] — remove the import's storage objects + row
 *   (pages cascade). The block itself is removed separately via a DELETE_BLOCK
 *   patch; this clears the backing asset.
 *
 * RLS + an explicit owner check gate both. A missing/foreign id is a flat 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { requireDeckImportAccess } from "@/lib/course/imports/deckImportAccess";
import {
  buildDeckImportView,
  deleteDeckImport,
  listDeckImportPages,
} from "@/lib/course/imports/deckImportService";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const supabase = await createClient();
  const { id } = await params;

  const access = await requireDeckImportAccess(supabase, id);
  if (!access.ok) return new Response(access.message, { status: access.status });

  const pages = await listDeckImportPages(supabase, id);
  const view = await buildDeckImportView(supabase, access.row, pages);
  // Tell intermediaries not to cache (URLs are signed + short-lived).
  return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const supabase = await createClient();
  const { id } = await params;

  const access = await requireDeckImportAccess(supabase, id);
  if (!access.ok) return new Response(access.message, { status: access.status });

  const err = await deleteDeckImport(supabase, access.row);
  if (err) {
    console.log(JSON.stringify({ tag: "deck_import_delete_error", message: err }));
    return new Response("We couldn't delete that deck.", { status: 500 });
  }
  return Response.json({ ok: true });
}
